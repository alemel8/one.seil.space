// Import přijatých faktur z Google Disku: stáhnout → vytěžit Claudem → založit
// fakturu. Používá ho ruční výběr na stránce i automatická kontrola složky.
//
// Automatika každých 5 minut projde letošní a loňský rok. První kontrola jen
// zapíše, co ve složce je ('vychozi'), a nic neimportuje: ty doklady jsou
// v systému z POHODY s jejím interním číslem. Importuje se až to, co přibude.
//
// Duplicity: soubor se páruje přes gdrive_file_id. Než se založí nová faktura,
// hledá se stejná bez vazby na Disk – stejné IČO a číslo dokladu a k tomu datum
// nebo částka, nebo stejné IČO, datum a částka; když jedna strana IČO nemá, stejné
// číslo a název a k tomu datum nebo částka. Číslo samo nestačí: u faktur z POHODY
// je v `number` její interní číslo, ne číslo dodavatele, a dva dodavatelé můžou mít
// stejné číslo (migrace 044). Shoda s jedinou fakturou se k ní připojí, nic nového
// nevzniká. Když se nepřipojí a v systému je faktura se stejným číslem i dodavatelem,
// se stejným číslem, datem a částkou, nebo u dokladu bez čísla se stejným dodavatelem,
// datem a částkou, soubor skončí chybou: rozhodne člověk.

import Anthropic from '@anthropic-ai/sdk';
import { getDb, generateId } from './db.js';
import { saveAttachment, deleteAttachment } from './attachments.js';
import { sendPushToAll } from './push.js';
import { jenDatum, prazskeDatum } from './prazsky-cas.js';
import { downloadFile, findReceivedInvoices, getFile, isConfigured, ROK_CHYBI } from './gdrive.js';
import { shodaBezCisla, shodaBezIco, shodaCislaDataCastky } from './prijata-faktura.js';

/** Po tolika neúspěšných pokusech se soubor nechá být, dál jen ručně ze stránky. */
export const MAX_POKUSU = 5;
/** Pauza mezi pokusy: výpadek API by jinak všechny pokusy spotřeboval za pár minut. */
const PAUZA_MEZI_POKUSY_MS = 60 * 60_000;
/** Pojistka proti tomu, aby se najednou vytěžily stovky dokladů. Zbytek příště. */
const MAX_ZA_KONTROLU = 25;

const EXTRACT_PROMPT = `Z tohoto dokladu vyextrahuj data přijaté faktury. Vrať POUZE platný JSON objekt bez markdown bloků ani dalšího textu:
{"number":"číslo faktury od dodavatele","supplier":"název dodavatele","supplier_ico":"IČO dodavatele, ne odběratele, nebo null","amount":základ_bez_DPH_číslo,"vat_amount":DPH_číslo,"total_amount":celková_částka_číslo,"currency":"CZK","issue_date":"YYYY-MM-DD nebo null","due_date":"YYYY-MM-DD nebo null","notes":"předmět plnění nebo null"}`;

export async function extractInvoiceData(buf, mimeType, log) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.length < 20 || apiKey.includes('XXX')) {
    throw new Error('ANTHROPIC_API_KEY není nastavena na serveru. Nastavte ji v prostředí (Coolify env vars).');
  }

  const base64 = buf.toString('base64');
  const contentBlock = mimeType.startsWith('image/')
    ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };

  const message = await new Anthropic({ apiKey }).messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: EXTRACT_PROMPT }] }],
  });

  const text = (message.content?.[0]?.text || '{}').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  try {
    return JSON.parse(text);
  } catch {
    log?.warn({ text }, 'Claude vrátil neplatný JSON');
    return {};
  }
}

const cislo = (hodnota) => {
  const n = parseFloat(hodnota);
  return Number.isFinite(n) ? n : 0;
};

/** Faktura bez vazby na Disk, která je tímtéž dokladem; víc shod = radši žádná. */
async function najdiStejnou(sql, { ico, dodavatel, cisloDokladu, datum, celkem }) {
  const shody = await sql`
    SELECT id, attachment_path FROM accounting_invoices
    WHERE type = 'received' AND gdrive_file_id IS NULL AND (
      (
        ico_klic(supplier_ico) = ico_klic(${ico})
        AND (
          (${cisloDokladu} <> '' AND number = ${cisloDokladu}
            AND (issue_date = ${datum}::date OR total_amount = ${celkem}::numeric))
          OR (issue_date = ${datum}::date AND total_amount = ${celkem}::numeric)
        )
      )
      OR (
        ${cisloDokladu} <> '' AND number = ${cisloDokladu}
        AND lower(btrim(supplier)) = lower(btrim(${dodavatel}))
        AND (ico_klic(supplier_ico) IS NULL OR ico_klic(${ico}) IS NULL)
        AND (issue_date = ${datum}::date OR total_amount = ${celkem}::numeric)
      )
    )
    LIMIT 2
  `;
  return shody.length === 1 ? shody[0] : null;
}

async function zapisHotovo(sql, fileId, meta, invoiceId) {
  await sql`
    INSERT INTO gdrive_soubory (file_id, nazev, stav, invoice_id, posledni_pokus)
    VALUES (${fileId}, ${meta?.name || ''}, 'naimportovano', ${invoiceId}, NOW())
    ON CONFLICT (file_id) DO UPDATE SET
      stav = 'naimportovano', invoice_id = EXCLUDED.invoice_id, chyba = '',
      posledni_pokus = NOW(), updated_at = NOW()
  `;
}

/**
 * Naimportuje jeden soubor. Vrací { vysledek, invoiceId }, kde vysledek je
 * 'imported' (nová faktura), 'merged' (připojeno k existující) nebo 'skipped'
 * (soubor už v systému je). Selhání zapíše k souboru a vyhodí dál.
 */
export async function importujSoubor(sql, log, fileId, { extract = extractInvoiceData } = {}) {
  try {
    const [existing] = await sql`SELECT id FROM accounting_invoices WHERE gdrive_file_id = ${fileId}`;
    if (existing) {
      await zapisHotovo(sql, fileId, null, existing.id);
      return { vysledek: 'skipped', invoiceId: existing.id };
    }

    const meta = await getFile(fileId);
    const buf  = await downloadFile(fileId);
    const mime = meta.mimeType || 'application/pdf';
    const d    = await extract(buf, mime, log);

    const amount      = cislo(d.amount);
    const vatAmount   = cislo(d.vat_amount);
    const totalAmount = d.total_amount ? cislo(d.total_amount) : Math.round((amount + vatAmount) * 100) / 100;
    const supplier    = String(d.supplier || '').trim();

    // Prázdná faktura by se tvářila jako hotová a soubor by se už nezkusil znovu.
    if (!supplier || !totalAmount) {
      throw new Error('Z dokladu se nepodařilo vytěžit dodavatele a částku.');
    }

    // Jiný tvar by postgres.js přes JS Date tiše posunul: 1. 10. 2026 na 9. 1. 2026.
    const datum = jenDatum(d.issue_date);
    if (d.issue_date && !datum) {
      throw new Error(`Z dokladu se nepodařilo vytěžit datum vystavení (${String(d.issue_date).slice(0, 30)}).`);
    }

    const ico          = String(d.supplier_ico || '').trim();
    const cisloDokladu = String(d.number || '').trim().slice(0, 60);
    const cisloFaktury = cisloDokladu || String(meta.name || '').slice(0, 60);
    const stejna = await najdiStejnou(sql, {
      ico, dodavatel: supplier, cisloDokladu, datum, celkem: totalAmount,
    });

    const duplicita = () => new Error(`Faktura ${cisloFaktury} už v systému je: shoduje se dodavatel a číslo, nebo datum a částka. Zkontrolujte ji ručně.`);
    // Index tyhle dvojice nepozná: založil by se druhý řádek téhož dokladu.
    if (!stejna && (
      await shodaBezIco(sql, { number: cisloFaktury, supplier, ico })
      || await shodaCislaDataCastky(sql, { number: cisloFaktury, datum, celkem: totalAmount })
      || (!cisloDokladu && await shodaBezCisla(sql, { supplier, ico, datum, celkem: totalAmount }))
    )) throw duplicita();

    // Příloha se nepřepisuje, když ji stejná faktura už má.
    const saved = stejna?.attachment_path
      ? null
      : await saveAttachment(buf, mime, 'inv_recv_gd', { log });

    try {
      if (stejna) {
        await sql`
          UPDATE accounting_invoices SET
            gdrive_file_id  = ${fileId},
            attachment_path = COALESCE(${saved?.filename ?? null}, attachment_path),
            attachment_mime = COALESCE(${saved?.mime ?? null}, attachment_mime),
            attachment_size = COALESCE(${saved?.size ?? null}::int, attachment_size),
            modified_at     = NOW()
          WHERE id = ${stejna.id}
        `;
        await zapisHotovo(sql, fileId, meta, stejna.id);
        return { vysledek: 'merged', invoiceId: stejna.id };
      }

      const id = generateId();
      await sql`
        INSERT INTO accounting_invoices
          (id, type, number, supplier, supplier_ico, amount, vat_amount, total_amount,
           currency, status, issue_date, due_date, notes,
           attachment_path, attachment_mime, attachment_size, gdrive_file_id)
        VALUES (
          ${id}, 'received',
          ${cisloFaktury},
          ${supplier},
          ${ico || null},
          ${amount}, ${vatAmount}, ${totalAmount},
          ${d.currency || 'CZK'}, 'Nezaplacena',
          ${datum || new Date().toISOString().split('T')[0]},
          ${jenDatum(d.due_date)},
          ${(d.notes || '').trim() || meta.name},
          ${saved.filename}, ${saved.mime}, ${saved.size}, ${fileId}
        )
      `;
      await zapisHotovo(sql, fileId, meta, id);
      return { vysledek: 'imported', invoiceId: id };
    } catch (err) {
      if (saved) await deleteAttachment(saved.filename);
      // Souběh ruční dávky a automatiky: druhý běh narazí na index gdrive_file_id,
      // příští kontrola soubor zapíše jako hotový.
      if (err.code === '23505' && err.constraint_name === 'accounting_invoices_gdrive_file_id_idx') {
        return { vysledek: 'skipped', invoiceId: null };
      }
      // Stejné číslo od stejného dodavatele je duplicita, ne souběh. Bez chyby by
      // soubor zůstal 'cekajici' a každá kontrola by ho znovu vytěžovala.
      if (err.code === '23505') throw duplicita();
      throw err;
    }
  } catch (err) {
    await sql`
      INSERT INTO gdrive_soubory (file_id, stav, pokusy, chyba, posledni_pokus)
      VALUES (${fileId}, 'chyba', 1, ${err.message || 'Neznámá chyba'}, NOW())
      ON CONFLICT (file_id) DO UPDATE SET
        stav = 'chyba', pokusy = gdrive_soubory.pokusy + 1, chyba = EXCLUDED.chyba,
        posledni_pokus = NOW(), updated_at = NOW()
    `;
    throw err;
  }
}

/** Soubory letošního a loňského roku; chybějící složka roku nevadí, obě chybějící ano. */
async function nactiSoubory(rootFolderId, now) {
  const rok = parseInt(prazskeDatum(now).slice(0, 4), 10);
  const soubory = [];
  let nalezeno = 0;
  for (const year of [rok - 1, rok]) {
    try {
      soubory.push(...await findReceivedInvoices({ rootFolderId, year }));
      nalezeno++;
    } catch (err) {
      if (err.code !== ROK_CHYBI) throw err;
    }
  }
  if (!nalezeno) throw new Error(`Ve sdílené složce není podsložka pro rok ${rok} ani ${rok - 1}.`);
  return soubory;
}

let bezi = false;

/**
 * Jedna kontrola složky. Vrací počty pro test a log, null když neběžela
 * (bez klíče, bez ID složky, předchozí kontrola ještě běží).
 */
export async function tikGdrive(log, { sql = getDb(), now = new Date(), extract = extractInvoiceData, notify = sendPushToAll } = {}) {
  if (bezi || !isConfigured()) return null;
  bezi = true;
  try {
    const [firma] = await sql`SELECT id, gdrive_root_folder_id, gdrive_vychozi_slozka FROM company_settings LIMIT 1`;
    const root = firma?.gdrive_root_folder_id;
    if (!root) return null;

    let soubory;
    try {
      soubory = await nactiSoubory(root, now);
    } catch (err) {
      log?.error?.({ err }, 'Google Disk: kontrola složky selhala');
      await sql`
        UPDATE company_settings
        SET gdrive_posledni_kontrola = ${now}, gdrive_posledni_chyba = ${err.message || 'Neznámá chyba'}
        WHERE id = ${firma.id}
      `;
      return null;
    }

    const prvniKontrola = firma.gdrive_vychozi_slozka !== root;
    for (const f of soubory) {
      await sql`
        INSERT INTO gdrive_soubory (file_id, nazev, slozka, stav)
        VALUES (${f.id}, ${f.name}, ${f.folderPath}, ${prvniKontrola ? 'vychozi' : 'cekajici'})
        ON CONFLICT (file_id) DO UPDATE SET
          nazev = EXCLUDED.nazev, slozka = EXCLUDED.slozka, updated_at = NOW()
      `;
    }
    await sql`
      UPDATE company_settings
      SET gdrive_vychozi_slozka = ${root}, gdrive_posledni_kontrola = ${now}, gdrive_posledni_chyba = ''
      WHERE id = ${firma.id}
    `;
    if (prvniKontrola) return { vychozi: soubory.length, naimportovano: 0, chyby: 0 };
    if (!soubory.length) return { vychozi: 0, naimportovano: 0, chyby: 0 };

    const naRade = await sql`
      SELECT file_id, nazev, pokusy FROM gdrive_soubory
      WHERE file_id = ANY(${soubory.map(f => f.id)})
        AND (stav = 'cekajici' OR (
          stav = 'chyba' AND pokusy < ${MAX_POKUSU}
          AND posledni_pokus < ${new Date(now.getTime() - PAUZA_MEZI_POKUSY_MS)}
        ))
      ORDER BY created_at
      LIMIT ${MAX_ZA_KONTROLU}
    `;

    let naimportovano = 0;
    let chyby = 0;
    const vzdane = [];
    for (const soubor of naRade) {
      try {
        const { vysledek } = await importujSoubor(sql, log, soubor.file_id, { extract });
        if (vysledek !== 'skipped') naimportovano++;
      } catch (err) {
        log?.error?.({ err, fileId: soubor.file_id }, 'Import faktury z Google Disku selhal');
        chyby++;
        if (soubor.pokusy + 1 >= MAX_POKUSU) vzdane.push(soubor.nazev);
      }
    }

    const url = '/ucetnictvi/prijate-faktury/gdrive';
    if (naimportovano) {
      await notify({ title: 'Nové přijaté faktury', body: `Z Google Disku přibylo dokladů: ${naimportovano}`, url }, 'gdrive_import');
    }
    if (vzdane.length) {
      await notify({ title: 'Doklad z Google Disku se nepodařilo načíst', body: vzdane.join(', '), url }, 'gdrive_import');
    }
    return { vychozi: 0, naimportovano, chyby };
  } finally {
    bezi = false;
  }
}

export function startGdriveScheduler(log) {
  const tik = () => tikGdrive(log).catch(err => log?.error?.({ err }, 'gdrive import tick error'));
  setTimeout(tik, 60_000);
  setInterval(tik, 5 * 60_000);
}
