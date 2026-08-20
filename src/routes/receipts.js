import { getDb } from '../db.js';
import { buildPohodaXml, PAYMENT_METHODS, isCashReceipt } from '../pohoda.js';
import { saveAttachment, deleteAttachment, isSupportedMime, markMissingAttachments } from '../attachments.js';
import Anthropic from '@anthropic-ai/sdk';

const STATUSES = ['Nezaúčtována', 'Zaúčtována', 'Storno'];
const CATEGORIES = ['Kancelář', 'Cestovné', 'PHM', 'Stravné', 'Reprezentace',
                    'IT & Software', 'Marketing', 'Provoz', 'Ostatní'];

// Kategorie, u kterých zákon nárok na odpočet DPH nepřipouští
// (§ 72 odst. 4 ZDPH — náklady na reprezentaci, pohoštění, dary).
const NO_VAT_CATEGORIES = ['Reprezentace'];

// Nárok na odpočet: u reprezentace ho nelze uplatnit, jinak rozhoduje uživatel.
// Checkbox se z prohlížeče posílá jen když je zaškrtnutý, proto 'on'/'1'/'true'.
function vatDeductibleFrom(body) {
  if (NO_VAT_CATEGORIES.includes(body.category)) return false;
  return ['on', '1', 'true'].includes(String(body.vat_deductible ?? ''));
}

function paymentMethodFrom(body) {
  const m = (body.payment_method || '').trim();
  return PAYMENT_METHODS.includes(m) ? m : 'Hotovost';
}

export default async function receiptsRoutes(fastify) {
  const sql = getDb();

  // Formulář účtenky chodí jako multipart — kromě polí veze i foto dokladu.
  // Prohlížeč ho posílá i bez souboru, proto je příloha vždy nepovinná.
  async function parseReceiptForm(request) {
    const fields = {};
    let attachment = null;

    // Fallback pro klasický urlencoded submit (vypnutý JS, starý prohlížeč)
    if (!request.isMultipart()) return { fields: request.body || {}, attachment: null };

    for await (const part of request.parts()) {
      if (!part.file) { fields[part.fieldname] = part.value ?? ''; continue; }

      const mime = part.mimetype || '';
      const buf  = await part.toBuffer();
      if (buf.length === 0 || !isSupportedMime(mime)) continue;
      attachment = await saveAttachment(buf, mime, 'uctenka', { log: fastify.log });
    }

    return { fields, attachment };
  }

  // ── Seznam účtenek ────────────────────────────────────────────
  fastify.get('/ucetnictvi/uctenky', async (request, reply) => {
    const q             = (request.query.q      || '').trim();
    const statusFilter  = (request.query.status || '').trim();
    const paymentFilter = (request.query.platba || '').trim();
    const page    = Math.max(1, parseInt(request.query.page || '1', 10));
    const perPage = 25;
    const offset  = (page - 1) * perPage;

    const conditions = [sql`TRUE`];
    if (q) conditions.push(sql`(vendor ILIKE ${'%'+q+'%'} OR number ILIKE ${'%'+q+'%'} OR notes ILIKE ${'%'+q+'%'})`);
    if (statusFilter)  conditions.push(sql`status = ${statusFilter}`);
    if (paymentFilter) conditions.push(sql`payment_method = ${paymentFilter}`);
    const where = sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM receipts ${where}`;
    const receipts    = await sql`SELECT * FROM receipts ${where} ORDER BY receipt_date DESC, id DESC LIMIT ${perPage} OFFSET ${offset}`;
    markMissingAttachments(receipts);

    const totalPages = Math.ceil(count / perPage);
    return reply.view('pages/receipts/list.ejs', {
      pageTitle: 'Účtenky', currentPath: '/ucetnictvi/uctenky',
      user: request.user, receipts, total: count, page, totalPages,
      q, statusFilter, paymentFilter, STATUSES, CATEGORIES, PAYMENT_METHODS,
      NO_VAT_CATEGORIES,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Detail účtenky ───────────────────────────────────────────
  // Statické segmenty (export.csv, pohoda-xml) mají v routeru přednost
  // před :id, takže si nepřekáží.
  fastify.get('/ucetnictvi/uctenky/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isInteger(id)) return reply.code(404).send('Účtenka nenalezena');

    const [receipt] = await sql`SELECT * FROM receipts WHERE id = ${id}`;
    if (!receipt) return reply.code(404).send('Účtenka nenalezena');
    markMissingAttachments([receipt]);

    return reply.view('pages/receipts/detail.ejs', {
      pageTitle: `Účtenka ${receipt.number || '#' + receipt.id}`,
      currentPath: '/ucetnictvi/uctenky',
      user: request.user, receipt, STATUSES, CATEGORIES, PAYMENT_METHODS,
      NO_VAT_CATEGORIES,
      saved: request.query.saved === '1',
      error: request.query.error || null,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── AI: vytěžení dat z PDF/obrázku účtenky ───────────────────
  fastify.post('/ucetnictvi/uctenky/analyze-pdf', async (request, reply) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.length < 20 || apiKey.includes('XXX')) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY není nastavena na serveru. Nastavte ji v prostředí (Coolify env vars).' });
    }

    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'Žádný soubor nebyl nahrán.' });

    const buf = await data.toBuffer();
    if (buf.length === 0) return reply.code(400).send({ error: 'Nahraný soubor je prázdný.' });

    const mimeType = data.mimetype || 'application/pdf';
    const base64 = buf.toString('base64');

    try {
      const client = new Anthropic({ apiKey });

      const contentBlock = mimeType.startsWith('image/')
        ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }
        : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };

      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            contentBlock,
            {
              type: 'text',
              text: `Z tohoto dokladu (účtenka/paragon) vyextrahuj data. Vrať POUZE platný JSON objekt bez markdown bloků:
{"number":"číslo dokladu nebo null","vendor":"název prodejce/dodavatele","vendor_ico":"IČO nebo null","amount":základ_bez_DPH_číslo_nebo_0,"vat_amount":DPH_číslo_nebo_0,"total_amount":celková_částka_číslo,"currency":"CZK","receipt_date":"YYYY-MM-DD nebo null","category":"jedna z: Kancelář|Cestovné|PHM|Stravné|Reprezentace|IT & Software|Marketing|Provoz|Ostatní","payment_method":"jedna z: Hotovost|Karta|Převodem podle údaje o platbě na dokladu (PLATBA KARTOU/CARD → Karta, HOTOVOST/CASH → Hotovost, jinak null)","notes":"předmět nákupu nebo null"}

Kategorie PHM použij u nákupu pohonných hmot, Reprezentace u pohoštění, občerstvení pro obchodní partnery a darů.`,
            },
          ],
        }],
      });

      const text = (message.content?.[0]?.text || '{}').trim()
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

      let extracted = {};
      try { extracted = JSON.parse(text); } catch {
        fastify.log.warn({ text }, 'Claude vrátil neplatný JSON pro účtenku');
      }
      return reply.send(extracted);
    } catch (err) {
      fastify.log.error({ err }, 'Chyba Anthropic API při zpracování účtenky');
      return reply.code(502).send({ error: 'Chyba Claude API: ' + (err?.message || 'Neznámá chyba') });
    }
  });

  // ── Vytvořit účtenku ─────────────────────────────────────────
  fastify.post('/ucetnictvi/uctenky/vytvorit', async (request, reply) => {
    let form;
    try {
      form = await parseReceiptForm(request);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }

    const b = form.fields;
    const a = form.attachment;
    const amount      = parseFloat(b.amount      || 0);
    const vatAmount   = parseFloat(b.vat_amount  || 0);
    const totalAmount = b.total_amount ? parseFloat(b.total_amount) : (amount + vatAmount);

    const [row] = await sql`
      INSERT INTO receipts (number, vendor, vendor_ico, amount, vat_amount, total_amount,
                            currency, receipt_date, category, notes, status,
                            payment_method, vat_deductible,
                            account_debit, account_credit,
                            attachment_path, attachment_mime, attachment_size)
      VALUES (
        ${(b.number   || '').trim() || null},
        ${(b.vendor   || '').trim()},
        ${(b.vendor_ico || '').trim() || null},
        ${amount}, ${vatAmount}, ${totalAmount},
        ${b.currency || 'CZK'},
        ${b.receipt_date || new Date().toISOString().split('T')[0]},
        ${b.category || 'Ostatní'},
        ${(b.notes || '').trim() || null},
        ${b.status || 'Nezaúčtována'},
        ${paymentMethodFrom(b)}, ${vatDeductibleFrom(b)},
        ${(b.account_debit  || '').trim()},
        ${(b.account_credit || '').trim()},
        ${a?.filename ?? null}, ${a?.mime ?? null}, ${a?.size ?? null}
      )
      RETURNING id
    `;
    return reply.code(201).send({ id: row.id });
  });

  // ── Upravit účtenku ──────────────────────────────────────────
  fastify.post('/ucetnictvi/uctenky/:id/upravit', async (request, reply) => {
    let form;
    try {
      form = await parseReceiptForm(request);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }

    const b = form.fields;
    const amount      = parseFloat(b.amount      || 0);
    const vatAmount   = parseFloat(b.vat_amount  || 0);
    const totalAmount = b.total_amount ? parseFloat(b.total_amount) : (amount + vatAmount);

    // Přílohu přepisujeme jen když nějaká přišla — jinak zůstává původní.
    // Starý soubor mažeme až po úspěšném zápisu, ať o doklad nepřijdeme.
    let replaced = null;
    let attachmentSet = sql``;
    if (form.attachment) {
      const [prev] = await sql`SELECT attachment_path FROM receipts WHERE id = ${request.params.id}`;
      replaced = prev?.attachment_path || null;
      attachmentSet = sql`
        attachment_path = ${form.attachment.filename},
        attachment_mime = ${form.attachment.mime},
        attachment_size = ${form.attachment.size},`;
    }

    await sql`
      UPDATE receipts SET
        ${attachmentSet}
        number         = ${(b.number || '').trim() || null},
        vendor         = ${(b.vendor || '').trim()},
        vendor_ico     = ${(b.vendor_ico || '').trim() || null},
        amount         = ${amount},
        vat_amount     = ${vatAmount},
        total_amount   = ${totalAmount},
        currency       = ${b.currency || 'CZK'},
        receipt_date   = ${b.receipt_date},
        category       = ${b.category || 'Ostatní'},
        notes          = ${(b.notes || '').trim() || null},
        status         = ${b.status || 'Nezaúčtována'},
        payment_method = ${paymentMethodFrom(b)},
        vat_deductible = ${vatDeductibleFrom(b)},
        account_debit  = ${(b.account_debit  || '').trim()},
        account_credit = ${(b.account_credit || '').trim()},
        updated_at     = NOW()
      WHERE id = ${request.params.id}
    `;

    if (replaced) await deleteAttachment(replaced);

    // Detail posílá klasický formulář (Accept: text/html) a čeká přesměrování,
    // modal v seznamu volá fetch a zpracuje JSON.
    if ((request.headers.accept || '').includes('text/html')) {
      return reply.redirect(`/ucetnictvi/uctenky/${request.params.id}?saved=1`);
    }
    return reply.code(200).send({ id: Number(request.params.id) });
  });

  // ── Příloha k existující účtence (dofocení dokladu) ──────────
  fastify.post('/ucetnictvi/uctenky/:id/priloha', async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'Žádný soubor nebyl nahrán.' });

    const mime = data.mimetype || '';
    if (!isSupportedMime(mime)) return reply.code(400).send({ error: 'Podporujeme jen PDF nebo obrázek.' });

    const buf = await data.toBuffer();
    let saved;
    try {
      saved = await saveAttachment(buf, mime, `uctenka${request.params.id}`, { log: fastify.log });
    } catch (err) {
      fastify.log.warn({ err }, 'Uložení přílohy účtenky selhalo');
      return reply.code(400).send({ error: err.message });
    }

    const [prev] = await sql`SELECT attachment_path FROM receipts WHERE id = ${request.params.id}`;
    await sql`
      UPDATE receipts SET
        attachment_path = ${saved.filename},
        attachment_mime = ${saved.mime},
        attachment_size = ${saved.size},
        updated_at      = NOW()
      WHERE id = ${request.params.id}
    `;
    if (prev?.attachment_path) await deleteAttachment(prev.attachment_path);
    return reply.send({ id: Number(request.params.id), attachment_path: saved.filename });
  });

  // ── Smazat účtenku ───────────────────────────────────────────
  fastify.post('/ucetnictvi/uctenky/:id/smazat', async (request, reply) => {
    const [prev] = await sql`SELECT attachment_path FROM receipts WHERE id = ${request.params.id}`;
    await sql`DELETE FROM receipts WHERE id = ${request.params.id}`;
    if (prev?.attachment_path) await deleteAttachment(prev.attachment_path);
    return reply.redirect('/ucetnictvi/uctenky');
  });

  // ── Stav účtenky (inline) ────────────────────────────────────
  fastify.post('/ucetnictvi/uctenky/:id/stav', async (request, reply) => {
    const { status } = request.body || {};
    if (status) await sql`UPDATE receipts SET status = ${status}, updated_at = NOW() WHERE id = ${request.params.id}`;
    return reply.redirect('/ucetnictvi/uctenky');
  });

  // ── POHODA XML export (Pokladna + Ostatní závazky) ────────────
  //
  // Hotovostní účtenka jde do pokladny, účtenka placená kartou nebo převodem
  // do ostatních závazků — z pokladny ji účetní stejně vyhazuje, protože
  // peníze odešly z účtu. Rozřazení řeší buildPohodaXml podle payment_method.
  fastify.post('/ucetnictvi/uctenky/pohoda-xml', async (request, reply) => {
    const ids = [].concat(request.body?.ids || []).map(Number).filter(Boolean);
    const receipts = ids.length > 0
      ? await sql`SELECT * FROM receipts WHERE id = ANY(${ids}) AND status <> 'Storno' ORDER BY receipt_date DESC`
      : await sql`SELECT * FROM receipts WHERE status <> 'Storno' ORDER BY receipt_date DESC`;

    const plain = txt => reply.code(400).type('text/plain; charset=utf-8').send(txt);

    if (receipts.length === 0) {
      return plain('Není co exportovat — vybrané účtenky jsou ve stavu Storno nebo žádné neexistují.');
    }

    // IČO určuje účetní jednotku, do které POHODA balíček naimportuje
    const [company] = await sql`SELECT * FROM company_settings LIMIT 1`;
    if (!company?.ico) {
      return plain('Chybí IČO firmy — POHODA bez něj nepozná účetní jednotku. Doplňte jej v Nastavení → Firma.');
    }

    const xml = buildPohodaXml(receipts.map(r => ({ ...r, _type: 'receipt' })), {
      ico:                 company.ico,
      cashAccount:         company.pohoda_cash_account || 'Pokladna',
      predkontace:         company.pohoda_predkontace  || '',
      predkontaceReceived: company.pohoda_predkontace_prijate || '',
      predkontaceNoVat:    company.pohoda_predkontace_repre   || '',
      note:                'Účtenky z one.seil.space',
    });

    // Datum exportu drží seznam, aby šlo poznat, co už účetní jednou dostala
    await sql`UPDATE receipts SET pohoda_exported_at = NOW() WHERE id = ANY(${receipts.map(r => r.id)})`;

    reply.header('Content-Type', 'application/xml; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="pohoda-uctenky.xml"');
    return reply.send(xml);
  });

  // ── Export CSV ───────────────────────────────────────────────
  fastify.get('/ucetnictvi/uctenky/export.csv', async (request, reply) => {
    const rows = await sql`SELECT * FROM receipts ORDER BY receipt_date DESC, id DESC`;
    const header = 'ID,Číslo,Dodavatel,IČO,Základ,DPH,Celkem,Měna,Datum,Kategorie,Úhrada,Odpočet DPH,Agenda POHODA,Stav,Poznámka\n';
    const lines = rows.map(r => [
      r.id, r.number || '', r.vendor, r.vendor_ico || '',
      r.amount, r.vat_amount, r.total_amount, r.currency,
      r.receipt_date, r.category,
      r.payment_method || 'Hotovost',
      r.vat_deductible === false ? 'ne' : 'ano',
      isCashReceipt(r) ? 'Pokladna' : 'Ostatní závazky',
      r.status, (r.notes || '').replace(/,/g, ' '),
    ].join(',')).join('\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="uctenky.csv"');
    return reply.send('﻿' + header + lines);
  });
}
