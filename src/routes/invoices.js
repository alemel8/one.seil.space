import { getDb, generateId } from '../db.js';
import { renderInvoicePdf } from '../pdf.js';
import { sendInvoiceEmail, sendReminderEmail } from '../email.js';
import { brandForShopId } from '../brand.js';
import { buildPohodaXml } from '../pohoda.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dalsiCisloRady, nahledRady, paymentVs, radaPodleCisla, renderSeriesNumber } from '../series-format.js';
import { saveAttachment, deleteAttachment, isSupportedMime, markMissingAttachments } from '../attachments.js';
import { denUhradyZFormulare, uhradaFakturyObjednavky, zobrazeniUhrady } from '../danovy-doklad.js';
import { ceskeDatum, jenDatum, prazskeDatum, pridejDny } from '../prazsky-cas.js';
import { rezimUprav } from '../upravy.js';
import { extractInvoiceData, importujSoubor, MAX_POKUSU } from '../gdrive-import.js';
import { shodaBezIco } from '../prijata-faktura.js';
import { parametr, strankovani } from '../strankovani.js';
import { bezpecnyNavrat } from '../navrat.js';
import { zalozka } from '../zalozky.js';
import { filtrDokladu, podminkyFiltru } from '../filtr-dokladu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const PDFS_DIR   = path.join(projectRoot, 'data/pdfs');

const STATUSES_ISSUED   = ['Nezaplacena', 'Zaplacena', 'Po splatnosti', 'Storno'];
const STATUSES_RECEIVED = ['Nezaplacena', 'Zaplacena', 'Po splatnosti', 'Storno'];

// Záložky seznamu vydaných faktur (?typ=): zálohové jsou řádky s type = 'proforma'.
const DRUHY_VYDANYCH = [['vydane', 'Vydané'], ['zalohove', 'Zálohové']];
// Záložky upomínek (?status=): klíč je hodnota sloupce status, Vše je bez podmínky.
// Záložky importu z Disku: co ještě ve faktuřách není a co už je.
const ZALOZKY_GDRIVE = [['nenahrane', 'Nenahrané'], ['nahrane', 'Nahrané']];
const ZALOZKY_UPOMINEK = [['ceka', 'Čeká na odeslání'], ['odeslana', 'Odeslané'], ['zrusena', 'Zrušené'], ['vse', 'Vše']];

// Nárok na odpočet DPH: checkbox chodí z prohlížeče jen zaškrtnutý.
// U reprezentace ho zákon nepřipouští (§ 72 odst. 4 ZDPH), proto ho
// formulář nabízí vypnout a export pak celou částku hodí do nákladů.
function vatDeductibleFrom(body) {
  return ['on', '1', 'true'].includes(String(body.vat_deductible ?? ''));
}

// Hlášky detailu přijaté faktury podle ?error=. Text nikdy nejde z adresy.
const CHYBY_PRIJATE = {
  __proto__: null,
  duplicita: 'Faktura s tímto číslem už v systému je, a to od stejného dodavatele. Zkontrolujte číslo a IČO nebo název dodavatele.',
  datum: 'Vyplňte platné datum přijetí a splatnosti.',
};

const FORM_ERRORS = {
  __proto__: null,
  klient:    'Vyplňte klienta.',
  polozky:   'Faktura musí mít alespoň jednu položku s popisem.',
  castka:    'Celková částka musí být větší než nula.',
  duplicita: 'Faktura s tímto číslem už existuje.',
  rada:      'Zvolená číselná řada není aktivní. Vyberte jinou.',
  'rada-obsazena': 'Příští číslo z řady už má jiná faktura. Upravte příští pořadí v Nastavení firmy, záložka Číselné řady.',
};

// ── Načtení nastavení firmy (issuer) ─────────────────────────

async function getIssuer(sql) {
  const [company] = await sql`SELECT * FROM company_settings LIMIT 1`;
  return company || {};
}

// ── Výpočet DPH souhrnu ───────────────────────────────────────

export function calcVatSummary(items) {
  const byRate = {};
  for (const item of items) {
    const rate = Number(item.vat_rate);
    if (!byRate[rate]) byRate[rate] = { rate, base: 0, vat: 0, total: 0 };
    byRate[rate].base  += Number(item.amount);
    byRate[rate].vat   += Number(item.vat_amount);
    byRate[rate].total += Number(item.total);
  }
  return Object.values(byRate).sort((a, b) => b.rate - a.rate);
}

// ── Položky z formuláře ──────────────────────────────────────
//
// Formulář posílá řádky jako paralelní pole (item_name, item_qty, …).
// Jeden řádek přijde jako string, víc řádků jako pole – proto toArray.

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function parseItemRows(body) {
  const names  = toArray(body.item_name);
  const qtys   = toArray(body.item_qty);
  const units  = toArray(body.item_unit);
  const prices = toArray(body.item_price);
  const rates  = toArray(body.item_vat);

  const items = [];
  for (let i = 0; i < names.length; i++) {
    const name = String(names[i] ?? '').trim();
    if (!name) continue;

    const quantity     = parseFloat(qtys[i])   || 0;
    const pricePerUnit = parseFloat(prices[i]) || 0;
    const vatRate      = parseFloat(rates[i])  || 0;

    const amount    = round2(quantity * pricePerUnit);
    const vatAmount = round2(amount * vatRate / 100);

    items.push({
      name, quantity, unit: String(units[i] ?? 'ks').trim() || 'ks',
      pricePerUnit, vatRate, amount, vatAmount, total: round2(amount + vatAmount),
    });
  }
  return items;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function sumItems(items) {
  const amount    = round2(items.reduce((s, it) => s + it.amount, 0));
  const vatAmount = round2(items.reduce((s, it) => s + it.vatAmount, 0));
  return { amount, vatAmount, total: round2(amount + vatAmount) };
}

// ── Napojení faktury na CRM ──────────────────────────────────

async function findCrmCompanyId(sql, ico, name) {
  if (ico) {
    const [byIco] = await sql`SELECT id FROM crm_companies WHERE ico = ${ico} LIMIT 1`;
    if (byIco) return byIco.id;
  }
  if (name) {
    const [byName] = await sql`SELECT id FROM crm_companies WHERE LOWER(name) = ${name.toLowerCase()} LIMIT 1`;
    if (byName) return byName.id;
  }
  return null;
}

async function findCrmContactId(sql, email) {
  if (!email) return null;
  const [row] = await sql`SELECT id FROM crm_contacts WHERE LOWER(email) = ${email.toLowerCase()} LIMIT 1`;
  return row?.id ?? null;
}

/** E-mail klienta: přednostně z faktury, jinak dohledaný v CRM. */
async function resolveClientEmail(sql, invoice) {
  if (invoice.client_email) return invoice.client_email;

  if (invoice.crm_contact_id) {
    const [c] = await sql`SELECT email FROM crm_contacts WHERE id = ${invoice.crm_contact_id}`;
    if (c?.email) return c.email;
  }
  if (invoice.crm_company_id) {
    const [c] = await sql`SELECT email FROM crm_companies WHERE id = ${invoice.crm_company_id}`;
    if (c?.email) return c.email;
  }
  if (invoice.client_ico) {
    const [c] = await sql`SELECT email FROM crm_companies WHERE ico = ${invoice.client_ico} AND email <> '' LIMIT 1`;
    if (c?.email) return c.email;
  }
  return '';
}

// ── Odeslané e-maily ─────────────────────────────────────────

async function logInvoiceEmail(sql, { invoiceId, kind, level = null, email, subject, status, error = '', userId = null }) {
  await sql`
    INSERT INTO invoice_emails (invoice_id, kind, reminder_level, email, subject, status, error, sent_by)
    VALUES (${invoiceId}, ${kind}, ${level}, ${email}, ${subject}, ${status}, ${error}, ${userId ?? null})
  `;
}

/** Uloží odeslané PDF, ať je dohledatelné, co přesně klient dostal. */
async function storeInvoicePdf(invoice, pdfBuffer, log) {
  try {
    if (!existsSync(PDFS_DIR)) await mkdir(PDFS_DIR, { recursive: true });
    const name = `faktura-${invoice.id}.pdf`;
    await writeFile(path.join(PDFS_DIR, name), pdfBuffer);
    return name;
  } catch (err) {
    // Archivace je vedlejší – když selže, e-mail už stejně odešel
    log?.warn({ err }, 'PDF faktury se nepodařilo uložit');
    return null;
  }
}

// ── Odeslání upomínky ────────────────────────────────────────
//
// Sdílené oběma cestami: tlačítkem na detailu faktury i seznamem upomínek.
// Upomínku vždy spouští člověk – worker ji jen připraví do stavu 'ceka'.

export function daysOverdue(dueDate, today = new Date()) {
  if (!dueDate) return 0;
  const diff = today - new Date(dueDate);
  return Math.max(0, Math.floor(diff / 86400000));
}

export async function deliverReminder(sql, { invoice, email, level, reminderId = null, daysOverdue: days, userId, log }) {
  const issuer = await getIssuer(sql);
  const overdue = days ?? daysOverdue(invoice.due_date);
  let subject = `Upomínka k faktuře ${invoice.number}`;
  // Zálohovku k objednávce zákazník platí pod číslem objednávky, takže i
  // upomínka musí uvádět tentýž symbol jako původní e-mail a PDF.
  const [ord] = await sql`SELECT order_number, payment_method FROM shop_orders WHERE id = ${invoice.order_id} LIMIT 1`;

  // Dobírku zákazník platí dopravci při převzetí a peníze posílá Zásilkovna.
  // „Po splatnosti“ u ní znamená nespárovanou dobírku, ne dluh zákazníka –
  // upomínka s číslem účtu by chtěla zaplatit podruhé, u nevyzvednuté zásilky
  // za zboží, které nedostal. Fronta je nezakládá (prepareReminders()) a detail
  // faktury tlačítko nenabízí; tohle je pojistka pro obě cesty k odeslání.
  // Do historie odeslání se zapíše, ať je vidět, proč nic neodešlo.
  if (ord?.payment_method === 'Dobírka') {
    const error = 'Faktura k dobírce se neupomíná – zákazník platí dopravci při převzetí, peníze posílá Zásilkovna.';
    await logInvoiceEmail(sql, { invoiceId: invoice.id, kind: 'upominka', level, email, subject,
                                 status: 'chyba', error, userId });
    return { ok: false, error };
  }

  try {
    const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${invoice.id} ORDER BY id`;
    // Přiložená faktura je tentýž doklad, jaký zákazník dostal – s formou
    // platby z objednávky, ne s výchozím převodem.
    const pdfBuffer = await renderInvoicePdf({ invoice, items, issuer, vatSummary: calcVatSummary(items),
      brand: await brandForShopId(invoice.shop_id), vs: paymentVs(invoice, ord?.order_number),
      paymentMethod: ord?.payment_method });

    ({ subject } = await sendReminderEmail({
      invoice, issuer, brand: await brandForShopId(invoice.shop_id),
      email, pdfBuffer, level, daysOverdue: overdue,
      paymentDetails: {
        bankAccount:    issuer.bank_account || '',
        iban:           issuer.iban || '',
        variableSymbol: paymentVs(invoice, ord?.order_number),
      },
    }));

    // Upomínka odeslaná z detailu faktury nemusí mít připravený záznam
    await sql`
      INSERT INTO invoice_reminders (invoice_id, level, days_overdue, status, sent_at, sent_to)
      VALUES (${invoice.id}, ${level}, ${overdue}, 'odeslana', NOW(), ${email})
      ON CONFLICT (invoice_id, level)
      DO UPDATE SET status = 'odeslana', sent_at = NOW(), sent_to = ${email}
    `;
    await logInvoiceEmail(sql, { invoiceId: invoice.id, kind: 'upominka', level, email, subject,
                                 status: 'odeslano', userId });
    return { ok: true };
  } catch (err) {
    log?.error({ err }, 'Chyba odeslání upomínky');
    await logInvoiceEmail(sql, { invoiceId: invoice.id, kind: 'upominka', level, email, subject,
                                 status: 'chyba', error: err.message, userId });
    return { ok: false, error: err.message };
  }
}

// ── Generování čísla z číselné řady ──────────────────────────

// Výchozí číselná řada podle eshopu, ze kterého objednávka přišla
async function pickDefaultSeries(sql, shopId, entityType) {
  const [series] = await sql`
    SELECT id FROM invoice_number_series
    WHERE shop_id = ${shopId} AND entity_type = ${entityType} AND active = TRUE
    ORDER BY id LIMIT 1
  `;
  return series?.id || null;
}

async function insertOrderInvoiceItems(sql, orderItems, invoiceId, vatRate, totalAmount) {
  let itemsTotal = 0;
  let itemsBase  = 0;
  let itemsVat   = 0;

  for (const item of orderItems) {
    const itemBase   = +(Number(item.price) / (1 + vatRate / 100) * item.quantity).toFixed(2);
    const itemVat    = +(Number(item.price) * item.quantity - itemBase).toFixed(2);
    const itemTotal  = +(Number(item.price) * item.quantity).toFixed(2);
    itemsTotal = round2(itemsTotal + itemTotal);
    itemsBase  = round2(itemsBase + itemBase);
    itemsVat   = round2(itemsVat + itemVat);
    await sql`
      INSERT INTO accounting_invoice_items
        (invoice_id, name, quantity, unit, price_per_unit, vat_rate, amount, vat_amount, total)
      VALUES (
        ${invoiceId}, ${item.name}, ${item.quantity}, 'ks',
        ${Number(item.price)}, ${vatRate},
        ${itemBase}, ${itemVat}, ${itemTotal}
      )
    `;
  }

  // Hlavička dokladu se počítá z `order.total_price`, tedy včetně dopravy,
  // dobírky a slevy pro přihlášené – jenže položky přicházejí ze
  // `shop_order_items`, kam pokladna nic z toho nedává. Doklad si pak
  // protiřečil na téže stránce: rekapitulace DPH se počítá z položek, blok
  // "Základ daně celkem" z hlavičky, a zákazník měl formální důvod poslat jen
  // součet položek.
  //
  // Dorovnávací řádek to drží v souladu z definice, ať se pokladna změní
  // jakkoli. Až bude dopravu a dobírku posílat jako regulérní položky, vyjde
  // rozdíl nula a řádek se prostě nevloží.
  if (totalAmount != null) {
    const diff = round2(Number(totalAmount) - itemsTotal);
    if (Math.abs(diff) >= 0.01) {
      // Základ a DPH dorovnávacího řádku se počítají jako **zbytek do
      // hlavičky**, ne samostatně z `diff`. Kdyby se počítaly zvlášť, sečetly
      // by se položky na haléř jinak než hlavička a doklad by si pořád
      // protiřečil – jen o setinu místo o osmdesát pět korun. Takhle vyjde
      // rekapitulace DPH přesně na blok "Základ daně celkem".
      const headerBase = +(Number(totalAmount) / (1 + vatRate / 100)).toFixed(2);
      const headerVat  = +(Number(totalAmount) - headerBase).toFixed(2);
      const diffBase = round2(headerBase - itemsBase);
      const diffVat  = round2(headerVat - itemsVat);
      await sql`
        INSERT INTO accounting_invoice_items
          (invoice_id, name, quantity, unit, price_per_unit, vat_rate, amount, vat_amount, total)
        VALUES (
          ${invoiceId}, ${diff > 0 ? 'Doprava a poplatky' : 'Sleva'}, 1, 'ks',
          ${diff}, ${vatRate},
          ${diffBase}, ${diffVat}, ${round2(diffBase + diffVat)}
        )
      `;
    }
  }
}

// ── Vystavit zálohovou fakturu z objednávky (platba převodem) ────
//
// Volá se automaticky při vzniku objednávky s platbou převodem
// (src/routes/toneracek.js), nebo jako ruční záchranná akce z UI.

export async function generateProformaForOrder(sql, order, { now = new Date() } = {}) {
  const orderItems = await sql`SELECT * FROM shop_order_items WHERE order_id = ${order.id}`;
  // Pražský den jako u vydané faktury – objednávka po půlnoci by jinak
  // dostala zálohovku se včerejším datem a o den kratší splatností.
  const issueDate = prazskeDatum(now);

  const seriesId = await pickDefaultSeries(sql, order.shop_id, 'zalohova_faktura');
  let number = '';
  if (seriesId) number = await dalsiCisloRady(sql, seriesId, now);
  if (!number) number = `ZF-${issueDate.slice(0, 4)}-${order.order_number}`;

  const vatRate = 21;
  const totalWithVat = Number(order.total_price);
  const base   = +(totalWithVat / (1 + vatRate / 100)).toFixed(2);
  const vatAmt = +(totalWithVat - base).toFixed(2);

  const invoiceId = generateId();
  await sql`
    INSERT INTO accounting_invoices
      (id, type, series_id, number, status,
       shop_id, order_id, crm_contact_id, crm_company_id,
       client_name, client_ico, client_dic, client_address,
       amount, vat_amount, total_amount, currency,
       issue_date, due_date, source)
    VALUES (
      ${invoiceId}, 'proforma',
      ${seriesId},
      ${number}, 'Nezaplacena',
      ${order.shop_id}, ${order.id},
      ${order.crm_contact_id || null}, ${order.crm_company_id || null},
      ${`${order.first_name} ${order.last_name}`.trim() || order.company || ''},
      ${order.ic || ''}, ${order.dic || ''},
      ${[order.address, order.zip + ' ' + order.city].filter(Boolean).join(', ')},
      ${base}, ${vatAmt}, ${totalWithVat},
      ${order.currency || 'CZK'},
      ${issueDate},
      ${pridejDny(issueDate, 7)},
      'eshop'
    )
  `;

  await insertOrderInvoiceItems(sql, orderItems, invoiceId, vatRate, totalWithVat);

  const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${invoiceId}`;
  return invoice;
}

// ── Vystavit běžnou (vydanou) fakturu z objednávky ────────────────
//
// Volá se automaticky při přepnutí stavu objednávky na "Vyřízena"
// (src/routes/toneracek.js) a z ruční záchranné akce níž. Stav, den úhrady
// a DUZP určuje uhradaFakturyObjednavky() v src/danovy-doklad.js: karta
// a převod jsou zaplacené ke dni přijetí úplaty (u převodu je podmínkou
// zaplacená zálohová faktura `fromProforma`, ze které se faktura vystaví
// s nulovým doplatkem), dobírka zůstává nezaplacená – platí se až při
// převzetí zásilky.

export async function generateInvoiceForOrder(sql, order, { fromProforma, now = new Date() } = {}) {
  const orderItems = await sql`SELECT * FROM shop_order_items WHERE order_id = ${order.id}`;
  // Pražský den, ne UTC – po půlnoci by jinak faktura nesla včerejší datum
  // a DUZP dobírky by se rozešel s datem vystavení. Z téhož okamžiku bere rok
  // i číslo z řady.
  const issueDate = prazskeDatum(now);

  const seriesId = await pickDefaultSeries(sql, order.shop_id, 'faktura');
  let number = '';
  if (seriesId) number = await dalsiCisloRady(sql, seriesId, now);
  // Bez číselné řady. Nové objednávky mají invoice_number prázdné (číslo se
  // do něj zapisuje až níž); starší v něm nesou číslo, které e-shop zákazníkovi
  // už ukázal, a to se tu radši dodrží.
  if (!number) number = order.invoice_number || `FV-${issueDate.slice(0, 4)}-${order.order_number}`;

  const vatRate = 21;
  const totalWithVat = Number(order.total_price);
  const base   = +(totalWithVat / (1 + vatRate / 100)).toFixed(2);
  const vatAmt = +(totalWithVat - base).toFixed(2);

  const invoiceId = generateId();
  const { status, paidDate, taxableDate } = uhradaFakturyObjednavky(order, { fromProforma, now });

  await sql`
    INSERT INTO accounting_invoices
      (id, type, series_id, number, status, paid_date, taxable_date,
       shop_id, order_id, crm_contact_id, crm_company_id, proforma_invoice_id,
       client_name, client_ico, client_dic, client_address,
       amount, vat_amount, total_amount, currency,
       issue_date, due_date, source)
    VALUES (
      ${invoiceId}, 'issued',
      ${seriesId},
      ${number}, ${status}, ${paidDate}, ${taxableDate},
      ${order.shop_id}, ${order.id},
      ${order.crm_contact_id || null}, ${order.crm_company_id || null}, ${fromProforma?.id || null},
      ${`${order.first_name} ${order.last_name}`.trim() || order.company || ''},
      ${order.ic || ''}, ${order.dic || ''},
      ${[order.address, order.zip + ' ' + order.city].filter(Boolean).join(', ')},
      ${base}, ${vatAmt}, ${totalWithVat},
      ${order.currency || 'CZK'},
      ${issueDate},
      ${pridejDny(issueDate, 14)},
      'eshop'
    )
  `;

  await insertOrderInvoiceItems(sql, orderItems, invoiceId, vatRate, totalWithVat);

  // Objednávka nese číslo skutečného dokladu – e-shop ho ukazuje zákazníkovi
  // a obsluha podle něj hledá. Dřív tu od založení objednávky leželo vymyšlené
  // „FV-<rok>-<objednávka>“, ke kterému žádná faktura neexistovala.
  await sql`UPDATE shop_orders SET invoice_number = ${number}, modified_at = NOW() WHERE id = ${order.id}`;

  const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${invoiceId}`;
  return invoice;
}

/** Proč vydaný doklad smazat nejde. Ukazuje se na detailu, adresa nese jen kód. */
const PROC_NELZE_SMAZAT = {
  __proto__: null,
  pohoda:     'Doklad je v POHODĚ nebo se pro ni exportoval.',
  objednavka: 'Doklad patří k objednávce e-shopu.',
  banka:      'Doklad je spárovaný s platbou v bance. Nejdřív platbu odpárujte.',
  podklad:    'Doklad je navázaný na fakturační podklad.',
  zalohova:   'Ze zálohové faktury už vznikla vydaná faktura.',
};

/**
 * Kód překážky smazání, nebo null. „Odesláno“ se počítá jako v POHODĚ: XML už má
 * účetní a jestli ho naimportovala, se tady nepozná. Doklad k objednávce se nemaže
 * vůbec: e-shop z něj bere číslo a stav a příznak V POHODĚ doplní až import z exportu,
 * takže „není v POHODĚ“ u něj nic neznamená. Spárovanou platbu nebo podklad by cizí
 * klíč potichu odvázal a zůstaly by vést k dokladu, který není.
 */
async function prekazkaSmazani(sql, invoice) {
  if (invoice.pohoda_v_evidenci || invoice.pohoda_exported_at) return 'pohoda';
  if (invoice.order_id) return 'objednavka';
  const [vazby] = await sql`
    SELECT
      EXISTS (SELECT 1 FROM accounting_bank_transactions WHERE matched_invoice_id = ${invoice.id}) AS banka,
      EXISTS (SELECT 1 FROM hr_work_reports WHERE invoice_id = ${invoice.id}) AS podklad,
      EXISTS (SELECT 1 FROM accounting_invoices WHERE proforma_invoice_id = ${invoice.id}) AS zalohova
  `;
  if (vazby.banka || invoice.bank_transaction_id) return 'banka';
  if (vazby.podklad) return 'podklad';
  if (vazby.zalohova) return 'zalohova';
  return null;
}

/**
 * Předvyplněný formulář nové faktury podle staré. Převezme odběratele, položky
 * a předkontaci, dostane dnešní datum a stejně dlouhou splatnost. Číslo, úhrada,
 * vazba na objednávku ani stav v POHODĚ se nepřebírají, jde o nový doklad.
 *
 * Faktura z exportu POHODY položky nemá, má jen text a součty. Z nich vznikne
 * jediný řádek, jinak by její duplikace nešla uložit. Text je pak v položce
 * a do poznámky se znovu neopisuje.
 */
export function predlohaDuplikatu(zdroj, polozky, dnes = prazskeDatum(new Date())) {
  const vystaveno = jenDatum(zdroj.issue_date);
  const splatno = jenDatum(zdroj.due_date);
  const dnu = vystaveno && splatno ? Math.round((Date.parse(splatno) - Date.parse(vystaveno)) / 86400000) : -1;
  const zaklad = Number(zdroj.amount) || 0;
  return {
    id: zdroj.id,
    number: zdroj.number,
    series_id: zdroj.series_id,
    client_name: zdroj.client_name,
    client_ico: zdroj.client_ico,
    client_dic: zdroj.client_dic,
    client_address: zdroj.client_address,
    client_email: zdroj.client_email,
    currency: zdroj.currency,
    account_debit: zdroj.account_debit,
    account_credit: zdroj.account_credit,
    issue_date: dnes,
    due_date: pridejDny(dnes, dnu >= 0 ? dnu : 14),
    notes: polozky.length ? zdroj.notes : '',
    polozky: polozky.length ? polozky : [{
      name: String(zdroj.notes || '').replace(/\s+/g, ' ').trim().slice(0, 255) || 'Plnění dle faktury',
      quantity: 1,
      unit: 'ks',
      price_per_unit: zaklad,
      vat_rate: zaklad ? Math.round(Number(zdroj.vat_amount) / zaklad * 100) : 21,
    }],
  };
}

export default async function invoicesRoutes(fastify) {
  const sql = getDb();

  // ══════════════════════════════════════════════════════════
  // VYDANÉ FAKTURY
  // ══════════════════════════════════════════════════════════

  fastify.get('/ucetnictvi/vydane-faktury', async (request, reply) => {
    const filtr        = filtrDokladu(request.query);
    const statusFilter = parametr(request.query.status);
    const typ = zalozka(DRUHY_VYDANYCH, request.query.typ);
    const zalohove = typ === 'zalohove';

    // Filtr platí pro obě záložky: odznak řekne, kolik shod je na té druhé,
    // a přechod na ni ho drží (hledání v liště sem vede i pro zálohové faktury).
    const conditions = [sql`type IN ('issued', 'proforma')`, ...podminkyFiltru(sql, filtr, {
      datum: 'issue_date', dodavatel: 'client_name', hledat: ['number', 'client_name', 'client_ico', 'notes'],
    })];
    if (statusFilter) conditions.push(sql`status = ${statusFilter}`);
    const where = sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`;

    const [pocty] = await sql`
      SELECT COUNT(*) FILTER (WHERE type = 'issued')::int AS vydane,
             COUNT(*) FILTER (WHERE type = 'proforma')::int AS zalohove
      FROM accounting_invoices ${where}
    `;
    const strany = strankovani({
      cesta: '/ucetnictvi/vydane-faktury', query: request.query, celkem: pocty[typ],
      zachovat: [...filtr.zachovat, 'status'], pevne: zalohove ? { typ } : {},
    });
    const invoices = await sql`
      SELECT * FROM accounting_invoices ${where} AND type = ${zalohove ? 'proforma' : 'issued'}
      ORDER BY issue_date DESC, created_at DESC, id DESC
      LIMIT ${strany.naStranku} OFFSET ${strany.offset}
    `;
    // Modal Nová faktura zakládá jen vydanou fakturu, na záložce Zálohové není.
    // Řady SEIL první: podle pořadí se volí výchozí řada i shoda čísla duplikátu.
    const series = zalohove ? [] : (await sql`
      SELECT * FROM invoice_number_series
      WHERE active = TRUE AND entity_type = 'faktura'
      ORDER BY shop_id NULLS FIRST, name, id
    `).map(s => ({ ...s, ...nahledRady(s) }));

    // Odkaz Duplikovat z detailu faktury: formulář se předvyplní, nic se nezaloží
    // a žádné číslo se nespotřebuje, dokud člověk neuloží.
    let predloha = null;
    if (!zalohove && parametr(request.query.duplikovat)) {
      const [zdroj] = await sql`
        SELECT * FROM accounting_invoices WHERE id = ${parametr(request.query.duplikovat)} AND type = 'issued'
      `;
      if (zdroj) {
        const polozky = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${zdroj.id} ORDER BY id`;
        predloha = predlohaDuplikatu(zdroj, polozky);
      }
    }
    const radaDuplikatu = predloha && (series.find(s => s.id === predloha.series_id) || radaPodleCisla(predloha.number, series));
    const vychoziRada = (radaDuplikatu || series.find(s => !s.shop_id))?.id ?? null;

    const adresaZalozky = (klic) => {
      const p = new URLSearchParams();
      if (klic !== DRUHY_VYDANYCH[0][0]) p.set('typ', klic);
      for (const k of filtr.zachovat) if (parametr(request.query[k])) p.set(k, parametr(request.query[k]));
      if (statusFilter) p.set('status', statusFilter);
      const s = p.toString();
      return `/ucetnictvi/vydane-faktury${s ? `?${s}` : ''}`;
    };

    return reply.view('pages/invoices/issued.ejs', {
      pageTitle: zalohove ? 'Zálohové faktury' : 'Vydané faktury', currentPath: '/ucetnictvi/vydane-faktury',
      user: request.user, invoices, total: pocty[typ], strany, typ, adresaZalozky,
      zalozky: DRUHY_VYDANYCH.map(([klic, popisek]) => ({ klic, popisek, pocet: pocty[klic].toLocaleString('cs-CZ') })),
      filtr, statusFilter, STATUSES_ISSUED, series, vychoziRada, predloha, dnes: prazskeDatum(new Date()),
      smazano: request.query.smazano === '1',
      klienti: (await sql`
        SELECT client_name FROM accounting_invoices WHERE type IN ('issued', 'proforma') AND client_name <> ''
        GROUP BY client_name ORDER BY MAX(issue_date) DESC LIMIT 500
      `).map(r => r.client_name),
      formError: zalohove ? '' : FORM_ERRORS[request.query.formError] || '',
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.get('/ucetnictvi/vydane-faktury/:id', async (request, reply) => {
    const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${request.params.id} AND type IN ('issued', 'proforma')`;
    if (!invoice) return reply.code(404).send('Faktura nenalezena');
    const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${invoice.id} ORDER BY id`;
    const vatSummary = calcVatSummary(items);
    const [order] = invoice.order_id
      ? await sql`SELECT payment_method, shipping_method, tracking_number FROM shop_orders WHERE id = ${invoice.order_id}`
      : [null];
    const emailSent  = request.query.emailSent  === '1';
    const emailError = request.query.emailError === '1';
    const emailLog   = await sql`
      SELECT * FROM invoice_emails WHERE invoice_id = ${invoice.id} ORDER BY sent_at DESC, id DESC LIMIT 10
    `;
    const [{ n: emailCelkem }] = await sql`SELECT COUNT(*)::int AS n FROM invoice_emails WHERE invoice_id = ${invoice.id}`;
    const reminders  = await sql`
      SELECT * FROM invoice_reminders WHERE invoice_id = ${invoice.id} ORDER BY level
    `;
    return reply.view('pages/invoices/issued-detail.ejs', {
      pageTitle: `${invoice.type === 'proforma' ? 'Zálohová faktura' : 'Faktura'} ${invoice.number}`, currentPath: '/ucetnictvi/vydane-faktury',
      user: request.user, invoice, items, vatSummary, STATUSES_ISSUED, order,
      emailSent, emailError, emailLog, emailCelkem, reminders,
      suggestedEmail: await resolveClientEmail(sql, invoice),
      formError: FORM_ERRORS[request.query.formError] || '',
      nelzeSmazat: PROC_NELZE_SMAZAT[await prekazkaSmazani(sql, invoice)] || null,
      chybaSmazani: PROC_NELZE_SMAZAT[request.query.smazatError] || null,
      // Předvyplněný den úhrady ve změně stavu: už zapsaný, jinak pražský dnešek
      vychoziDenUhrady: denUhradyZFormulare(invoice.paid_date),
      // Data dokladu stejně jako v PDF – nezávisle na časovém pásmu procesu
      ceskeDatum,
    }, { layout: 'layouts/base.ejs' });
  });

  // Vytvořit vydanou fakturu manuálně
  fastify.post('/ucetnictvi/vydane-faktury/vytvorit', async (request, reply) => {
    const b = request.body || {};
    // Po chybě v duplikaci se vrátí předvyplněný formulář, ne prázdný.
    const duplikat = b.duplikat_z ? `duplikovat=${encodeURIComponent(b.duplikat_z)}&` : '';
    const fail = code => reply.redirect(`/ucetnictvi/vydane-faktury?${duplikat}formError=${code}`);

    const clientName = (b.client_name || '').trim();
    if (!clientName) return fail('klient');

    const items = parseItemRows(b);
    if (!items.length) return fail('polozky');

    const { amount, vatAmount, total } = sumItems(items);
    if (total <= 0) return fail('castka');

    // Faktura patří k e-shopu své řady: podle něj se tiskne hlavička dokladu.
    let rada = null;
    if (b.series_id) {
      [rada] = await sql`
        SELECT id, shop_id FROM invoice_number_series
        WHERE id = ${parseInt(b.series_id, 10) || 0} AND entity_type = 'faktura' AND active = TRUE
      `;
      if (!rada) return fail('rada');
    }

    // Ruční číslo se bere jen bez řady a nesmí kolidovat
    const manualNumber = rada ? '' : (b.number || '').trim();
    if (manualNumber) {
      const [clash] = await sql`
        SELECT id FROM accounting_invoices WHERE type = 'issued' AND number = ${manualNumber} LIMIT 1
      `;
      if (clash) return fail('duplicita');
    }

    const id = generateId();
    const clientIco = (b.client_ico || '').trim();

    try {
      await sql.begin(async tx => {
        const number = rada
          ? await dalsiCisloRady(tx, rada.id)
          : manualNumber || `FV-${new Date().getFullYear()}-${Date.now()}`;
        await tx`
          INSERT INTO accounting_invoices
            (id, type, series_id, shop_id, number, status, client_name, client_ico, client_dic, client_address,
             client_email, crm_company_id, crm_contact_id,
             amount, vat_amount, total_amount, currency, issue_date, due_date, notes,
             account_debit, account_credit)
          VALUES (
            ${id}, 'issued',
            ${rada?.id ?? null}, ${rada?.shop_id ?? null},
            ${number}, ${b.status || 'Nezaplacena'},
            ${clientName}, ${clientIco},
            ${(b.client_dic||'').trim()}, ${(b.client_address||'').trim()},
            ${(b.client_email||'').trim().toLowerCase()},
            ${await findCrmCompanyId(sql, clientIco, clientName)},
            ${await findCrmContactId(sql, (b.client_email||'').trim())},
            ${amount}, ${vatAmount}, ${total},
            ${b.currency || 'CZK'},
            ${b.issue_date || new Date().toISOString().split('T')[0]},
            ${b.due_date || null},
            ${(b.notes||'').trim()},
            ${(b.account_debit||'').trim()}, ${(b.account_credit||'').trim()}
          )
        `;
        for (const it of items) {
          await tx`
            INSERT INTO accounting_invoice_items
              (invoice_id, name, quantity, unit, price_per_unit, vat_rate, amount, vat_amount, total)
            VALUES (
              ${id}, ${it.name}, ${it.quantity}, ${it.unit},
              ${it.pricePerUnit}, ${it.vatRate}, ${it.amount}, ${it.vatAmount}, ${it.total}
            )
          `;
        }
      });
    } catch (err) {
      if (err.code === '23505') return fail(rada ? 'rada-obsazena' : 'duplicita');   // unique_violation
      throw err;
    }

    return reply.redirect(`/ucetnictvi/vydane-faktury/${id}`);
  });

  // Vystavit zálohovou fakturu z objednávky – ruční záchranná akce
  // (normálně se vystavuje automaticky při vzniku objednávky, viz toneracek.js)
  fastify.post('/ucetnictvi/objednavky/:id/generovat-zalohovou-fakturu', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');

    const [order] = await sql`SELECT * FROM shop_orders WHERE id = ${request.params.id}`;
    if (!order) return reply.code(404).send('Objednávka nenalezena');

    const [existing] = await sql`SELECT id FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'proforma' LIMIT 1`;
    if (existing) return reply.redirect(`/ucetnictvi/objednavky/${order.id}`);

    await generateProformaForOrder(sql, order);
    return reply.redirect(`/ucetnictvi/objednavky/${order.id}`);
  });

  // Vystavit běžnou fakturu z objednávky – ruční záchranná akce
  // (normálně se vystavuje automaticky při přepnutí stavu na Vyřízena, viz toneracek.js)
  fastify.post('/ucetnictvi/objednavky/:id/generovat-fakturu', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');

    const [order] = await sql`SELECT * FROM shop_orders WHERE id = ${request.params.id}`;
    if (!order) return reply.code(404).send('Objednávka nenalezena');

    const [existing] = await sql`SELECT id FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'issued' LIMIT 1`;
    if (existing) return reply.redirect(`/ucetnictvi/vydane-faktury/${existing.id}`);

    const isTransfer = order.payment_method === 'Bankovní převod';
    const [proforma] = await sql`SELECT * FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'proforma' LIMIT 1`;
    if (isTransfer && (!proforma || proforma.status !== 'Zaplacena')) {
      return reply.redirect(`/ucetnictvi/objednavky/${order.id}?error=proforma-nezaplacena`);
    }

    const invoice = await generateInvoiceForOrder(sql, order, { fromProforma: isTransfer ? proforma : null });
    return reply.redirect(`/ucetnictvi/vydane-faktury/${invoice.id}`);
  });

  // Úprava vydané faktury (hlavička i položky)
  fastify.post('/ucetnictvi/vydane-faktury/:id/upravit', async (request, reply) => {
    const [invoice] = await sql`
      SELECT id, type FROM accounting_invoices WHERE id = ${request.params.id} AND type IN ('issued', 'proforma')
    `;
    if (!invoice) return reply.code(404).send('Faktura nenalezena');

    const b = request.body || {};
    const back = code => reply.redirect(`/ucetnictvi/vydane-faktury/${invoice.id}?formError=${code}`);

    const clientName = (b.client_name || '').trim();
    if (!clientName) return back('klient');

    // Položky se posílají celé; když nepřijdou, hlavička se upraví a rozpis zůstane
    const items = parseItemRows(b);
    const totals = items.length
      ? sumItems(items)
      : { amount: parseFloat(b.amount) || 0, vatAmount: parseFloat(b.vat_amount) || 0,
          total: round2((parseFloat(b.amount) || 0) + (parseFloat(b.vat_amount) || 0)) };

    // DUZP jen u vydané faktury (zálohová daňovým dokladem není) a jen když
    // ho formulář poslal. Opravuje se tu den přijetí úplaty, který Seil
    // u objednávek z doby před migrací 039 nezná, nebo potvrzení platby, které
    // dorazilo až po půlnoci. Prázdné pole = shodné s datem vystavení.
    const menitDuzp = invoice.type === 'issued' && b.taxable_date !== undefined;

    await sql.begin(async tx => {
      await tx`
        UPDATE accounting_invoices SET
          client_name = ${clientName},
          client_ico = ${(b.client_ico||'').trim()},
          client_dic = ${(b.client_dic||'').trim()},
          client_address = ${(b.client_address||'').trim()},
          client_email = ${(b.client_email||'').trim().toLowerCase()},
          issue_date = ${b.issue_date || null},
          due_date = ${b.due_date || null},
          ${menitDuzp ? tx`taxable_date = ${jenDatum(b.taxable_date)},` : tx``}
          notes = ${(b.notes||'').trim()},
          account_debit = ${(b.account_debit||'').trim()},
          account_credit = ${(b.account_credit||'').trim()},
          amount = ${totals.amount}, vat_amount = ${totals.vatAmount}, total_amount = ${totals.total},
          modified_at = NOW()
        WHERE id = ${invoice.id}
      `;

      if (items.length) {
        await tx`DELETE FROM accounting_invoice_items WHERE invoice_id = ${invoice.id}`;
        for (const it of items) {
          await tx`
            INSERT INTO accounting_invoice_items
              (invoice_id, name, quantity, unit, price_per_unit, vat_rate, amount, vat_amount, total)
            VALUES (
              ${invoice.id}, ${it.name}, ${it.quantity}, ${it.unit},
              ${it.pricePerUnit}, ${it.vatRate}, ${it.amount}, ${it.vatAmount}, ${it.total}
            )
          `;
        }
      }
    });

    return reply.redirect(`/ucetnictvi/vydane-faktury/${invoice.id}`);
  });

  // Smazání vydaného dokladu, který do POHODY neodešel. Zámek řádku drží kontrolu
  // a mazání pohromadě: souběžný export do POHODY počká a nic už nenajde.
  fastify.post('/ucetnictvi/vydane-faktury/:id/smazat', async (request, reply) => {
    const vysledek = await sql.begin(async tx => {
      const [invoice] = await tx`
        SELECT * FROM accounting_invoices WHERE id = ${request.params.id} AND type IN ('issued', 'proforma') FOR UPDATE
      `;
      if (!invoice) return null;
      const prekazka = await prekazkaSmazani(tx, invoice);
      if (prekazka) return { invoice, prekazka };

      // Poslední číslo řady se vrátí, ať po faktuře založené omylem nezůstane díra.
      // Číslo, které už klient dostal e-mailem, se nepoužije pro jiný doklad.
      const [odeslano] = await tx`SELECT 1 FROM invoice_emails WHERE invoice_id = ${invoice.id} AND status = 'odeslano' LIMIT 1`;
      const [rada] = invoice.series_id && !odeslano
        ? await tx`SELECT * FROM invoice_number_series WHERE id = ${invoice.series_id} FOR UPDATE`
        : [];
      if (rada && renderSeriesNumber(rada) === invoice.number) {
        await tx`UPDATE invoice_number_series SET current_number = current_number - 1 WHERE id = ${rada.id}`;
      }

      await tx`DELETE FROM accounting_invoices WHERE id = ${invoice.id}`;
      return { invoice };
    });

    if (!vysledek) return reply.code(404).send('Faktura nenalezena');
    const { invoice, prekazka } = vysledek;
    if (prekazka) return reply.redirect(`/ucetnictvi/vydane-faktury/${invoice.id}?smazatError=${prekazka}`);

    if (invoice.pdf_path) await unlink(path.join(PDFS_DIR, path.basename(invoice.pdf_path))).catch(() => {});
    if (invoice.attachment_path) await deleteAttachment(invoice.attachment_path);
    request.log.info({ id: invoice.id, number: invoice.number, type: invoice.type, userId: request.user?.id }, 'Smazán vydaný doklad');
    return reply.redirect(`/ucetnictvi/vydane-faktury?${invoice.type === 'proforma' ? 'typ=zalohove&' : ''}smazano=1`);
  });

  // Změna stavu faktury
  fastify.post('/ucetnictvi/vydane-faktury/:id/stav', async (request, reply) => {
    const { status, paid_date } = request.body || {};
    if (!STATUSES_ISSUED.includes(status)) return reply.code(400).send('Neplatný stav');
    const updates = [sql`status = ${status}`, sql`modified_at = NOW()`];
    // Den úhrady je den, kdy peníze přišly, ne den kliknutí – viz
    // denUhradyZFormulare(). Bez data z formuláře pražský dnešek, ne
    // CURRENT_DATE databáze.
    if (status === 'Zaplacena') {
      updates.push(sql`paid_date = ${denUhradyZFormulare(paid_date)}`);
    }
    await sql`UPDATE accounting_invoices SET ${updates.reduce((a, b) => sql`${a}, ${b}`)} WHERE id = ${request.params.id}`;
    return reply.redirect(`/ucetnictvi/vydane-faktury/${request.params.id}`);
  });

  // PDF endpoint
  fastify.get('/ucetnictvi/vydane-faktury/:id/pdf', async (request, reply) => {
    const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${request.params.id} AND type IN ('issued', 'proforma')`;
    if (!invoice) return reply.code(404).send('Faktura nenalezena');

    const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${invoice.id} ORDER BY id`;
    const issuer = await getIssuer(sql);
    const vatSummary = calcVatSummary(items);
    // Způsob platby nese objednávka, ne faktura – bez něj by dobírka v náhledu
    // vypadala jako doklad k převodu.
    const [ord] = await sql`SELECT payment_method FROM shop_orders WHERE id = ${invoice.order_id} LIMIT 1`;

    const pdfBuffer = await renderInvoicePdf({ invoice, items, issuer, vatSummary,
      brand: await brandForShopId(invoice.shop_id), paymentMethod: ord?.payment_method });

    // ?download=1 posílá tlačítko Stáhnout v náhledu dokladu
    const disposition = request.query.download === '1' ? 'attachment' : 'inline';
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `${disposition}; filename="faktura-${invoice.number}.pdf"`);
    return reply.send(pdfBuffer);
  });

  // Odeslat fakturu emailem
  fastify.post('/ucetnictvi/vydane-faktury/:id/odeslat-email', async (request, reply) => {
    const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${request.params.id} AND type IN ('issued', 'proforma')`;
    if (!invoice) return reply.code(404).send('Faktura nenalezena');

    const email = (request.body?.email || '').trim();
    if (!email) return reply.redirect(`/ucetnictvi/vydane-faktury/${invoice.id}?error=noemail`);

    const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${invoice.id} ORDER BY id`;
    const issuer = await getIssuer(sql);
    const vatSummary = calcVatSummary(items);
    const brand = await brandForShopId(invoice.shop_id);
    const subject = `Faktura ${invoice.number} od ${brand ? brand.name : issuer.name}`;
    const [ord] = await sql`SELECT order_number, payment_method FROM shop_orders WHERE id = ${invoice.order_id} LIMIT 1`;
    // E-mail ukazuje platební údaje jen tam, kde je ukazuje i PDF v příloze.
    // U dobírky a zaplacené faktury by číslo účtu s QR kódem svádělo k platbě,
    // kterou nikdo nečeká.
    const { instrukce } = zobrazeniUhrady({ invoice, paymentMethod: ord?.payment_method });

    try {
      const pdfBuffer = await renderInvoicePdf({ invoice, items, issuer, vatSummary, brand,
        vs: paymentVs(invoice, ord?.order_number), paymentMethod: ord?.payment_method });
      await sendInvoiceEmail({
        invoice, issuer, brand, email, pdfBuffer, subject,
        paymentMethod: ord?.payment_method,
        paymentDetails: instrukce ? {
          bankAccount:    issuer.bank_account || '',
          iban:           issuer.iban || '',
          variableSymbol: paymentVs(invoice, ord?.order_number),
        } : undefined,
      });

      const pdfPath = await storeInvoicePdf(invoice, pdfBuffer, fastify.log);
      await sql`
        UPDATE accounting_invoices
        SET client_email = ${email},
            pdf_path = COALESCE(${pdfPath}, pdf_path),
            modified_at = NOW()
        WHERE id = ${invoice.id}
      `;
      await logInvoiceEmail(sql, { invoiceId: invoice.id, kind: 'faktura', email, subject,
                                   status: 'odeslano', userId: request.user?.id });

      return reply.redirect(`/ucetnictvi/vydane-faktury/${invoice.id}?emailSent=1`);
    } catch (err) {
      fastify.log.error({ err }, 'Chyba odeslání faktury emailem');
      await logInvoiceEmail(sql, { invoiceId: invoice.id, kind: 'faktura', email, subject,
                                   status: 'chyba', error: err.message, userId: request.user?.id });
      return reply.redirect(`/ucetnictvi/vydane-faktury/${invoice.id}?emailError=1`);
    }
  });

  // Odeslat upomínku k faktuře – vždy ruční akce
  fastify.post('/ucetnictvi/vydane-faktury/:id/upominka', async (request, reply) => {
    const [invoice] = await sql`
      SELECT * FROM accounting_invoices WHERE id = ${request.params.id} AND type IN ('issued', 'proforma')
    `;
    if (!invoice) return reply.code(404).send('Faktura nenalezena');

    const back = q => reply.redirect(`/ucetnictvi/vydane-faktury/${invoice.id}${q}`);
    const email = (request.body?.email || '').trim();
    if (!email) return back('?error=noemail');

    const level = Math.min(3, Math.max(1, parseInt(request.body?.level, 10) || 2));
    const result = await deliverReminder(sql, {
      invoice, email, level, userId: request.user?.id, log: fastify.log,
    });

    return back(result.ok ? '?emailSent=1' : '?emailError=1');
  });

  // ══════════════════════════════════════════════════════════
  // UPOMÍNKY
  // ══════════════════════════════════════════════════════════

  fastify.get('/ucetnictvi/upominky', async (request, reply) => {
    // Bez parametru je to fronta k odeslání; prázdné ?status= je starý odkaz na Vše.
    const zDotazu = parametr(request.query.status);
    const tab = request.query.status !== undefined && !zDotazu ? 'vse' : zalozka(ZALOZKY_UPOMINEK, zDotazu);

    const skupiny = await sql`
      SELECT r.status, COUNT(*)::int AS n
      FROM invoice_reminders r
      JOIN accounting_invoices i ON i.id = r.invoice_id
      GROUP BY r.status
    `;
    const pocty = Object.fromEntries(skupiny.map(c => [c.status, c.n]));
    pocty.vse = skupiny.reduce((soucet, c) => soucet + c.n, 0);

    const strany = strankovani({
      cesta: '/ucetnictvi/upominky', query: request.query, celkem: pocty[tab] ?? 0,
      pevne: tab === ZALOZKY_UPOMINEK[0][0] ? {} : { status: tab },
    });
    const reminders = await sql`
      SELECT r.*, i.number, i.client_name, i.client_email, i.client_ico,
             i.total_amount, i.currency, i.due_date, i.status AS invoice_status,
             i.crm_company_id, i.crm_contact_id
      FROM invoice_reminders r
      JOIN accounting_invoices i ON i.id = r.invoice_id
      ${tab === 'vse' ? sql`` : sql`WHERE r.status = ${tab}`}
      ORDER BY r.level DESC, r.days_overdue DESC, r.id DESC
      LIMIT ${strany.naStranku} OFFSET ${strany.offset}
    `;

    // E-mail se dohledává až tady, ať se v seznamu dá rovnou odeslat. Až tři
    // dotazy na řádek, proto až po LIMIT.
    const rows = [];
    for (const r of reminders) {
      rows.push({ ...r, email: await resolveClientEmail(sql, r) });
    }

    return reply.view('pages/invoices/reminders.ejs', {
      pageTitle: 'Upomínky', currentPath: '/ucetnictvi/upominky',
      user: request.user, reminders: rows, tab, strany,
      zalozky: ZALOZKY_UPOMINEK.map(([klic, popisek]) => ({ klic, popisek, pocet: (pocty[klic] ?? 0).toLocaleString('cs-CZ') })),
      adresaZalozky: (klic) => (klic === ZALOZKY_UPOMINEK[0][0] ? '/ucetnictvi/upominky' : `/ucetnictvi/upominky?status=${klic}`),
      sent: request.query.sent === '1', error: request.query.error === '1',
    }, { layout: 'layouts/base.ejs' });
  });

  // Po akci v řádku zpět na tutéž záložku a stránku, výsledek jde navíc v adrese.
  const navratNaUpominky = (request, vysledek) => {
    const zpet = bezpecnyNavrat(request.body?.redirect_to, '/ucetnictvi/upominky');
    return vysledek ? `${zpet}${zpet.includes('?') ? '&' : '?'}${vysledek}` : zpet;
  };

  // Odeslat připravenou upomínku ze seznamu
  fastify.post('/ucetnictvi/upominky/:id/odeslat', async (request, reply) => {
    const [reminder] = await sql`SELECT * FROM invoice_reminders WHERE id = ${parseInt(request.params.id, 10)}`;
    if (!reminder) return reply.code(404).send('Upomínka nenalezena');

    const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${reminder.invoice_id}`;
    if (!invoice) return reply.code(404).send('Faktura nenalezena');

    const email = (request.body?.email || '').trim() || await resolveClientEmail(sql, invoice);
    if (!email) return reply.redirect(navratNaUpominky(request, 'error=1'));

    const result = await deliverReminder(sql, {
      invoice, email, level: reminder.level, reminderId: reminder.id,
      daysOverdue: reminder.days_overdue, userId: request.user?.id, log: fastify.log,
    });

    return reply.redirect(navratNaUpominky(request, result.ok ? 'sent=1' : 'error=1'));
  });

  // Zrušit upomínku (např. klient zaplatil mimo systém)
  fastify.post('/ucetnictvi/upominky/:id/zrusit', async (request, reply) => {
    await sql`UPDATE invoice_reminders SET status = 'zrusena' WHERE id = ${parseInt(request.params.id, 10)}`;
    return reply.redirect(navratNaUpominky(request));
  });

  // ══════════════════════════════════════════════════════════
  // PŘIJATÉ FAKTURY
  // ══════════════════════════════════════════════════════════

  // ── AI: vytěžení dat z PDF přijaté faktury ───────────────────
  fastify.post('/ucetnictvi/prijate-faktury/analyze-pdf', async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'Žádný soubor nebyl nahrán.' });

    const buf = await data.toBuffer();
    if (buf.length === 0) return reply.code(400).send({ error: 'Nahraný soubor je prázdný.' });
    if (buf.length > 20 * 1024 * 1024) return reply.code(400).send({ error: 'Soubor je příliš velký (max 20 MB).' });

    try {
      return reply.send(await extractInvoiceData(buf, data.mimetype || 'application/pdf', fastify.log));
    } catch (err) {
      fastify.log.error({ err }, 'Chyba Anthropic API');
      const msg = err?.message || 'Neznámá chyba';
      if (msg.includes('ANTHROPIC_API_KEY')) return reply.code(503).send({ error: msg });
      return reply.code(502).send({ error: 'Chyba Claude API: ' + msg });
    }
  });

  // ── Detail přijaté faktury ───────────────────────────────────
  fastify.get('/ucetnictvi/prijate-faktury/:id', async (request, reply) => {
    const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${request.params.id} AND type = 'received'`;
    if (!invoice) return reply.code(404).send('Faktura nenalezena');
    markMissingAttachments([invoice]);
    const [bankTx] = invoice.bank_transaction_id
      ? await sql`SELECT * FROM accounting_bank_transactions WHERE id = ${invoice.bank_transaction_id}`
      : [null];
    return reply.view('pages/invoices/received-detail.ejs', {
      pageTitle: `Přijatá ${invoice.internal_number || invoice.number}`, currentPath: '/ucetnictvi/prijate-faktury',
      user: request.user, invoice, bankTx, STATUSES_RECEIVED,
      saved: request.query.saved === '1',
      error: CHYBY_PRIJATE[request.query.error] || null,
      rezimUprav: rezimUprav(request.query),
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/prijate-faktury/:id/upravit', async (request, reply) => {
    const b = request.body || {};
    const amount      = parseFloat(b.amount     || 0);
    const vatAmount   = parseFloat(b.vat_amount || 0);
    const totalAmount = b.total_amount ? parseFloat(b.total_amount) : (amount + vatAmount);
    const zpetSChybou = (kod) => reply.redirect(`/ucetnictvi/prijate-faktury/${request.params.id}?error=${kod}&upravit=1`);
    // Prázdné nebo s překlepem v roce by postgres.js odmítl chybou 500 a tichá
    // náhrada dneškem by zkreslila účetní datum. jenDatum odmítne i 30. 2.
    const issueDate = jenDatum(b.issue_date);
    if (!issueDate || (b.due_date && !jenDatum(b.due_date))) return zpetSChybou('datum');
    const cislo = (b.number || '').trim();
    const dodavatel = (b.supplier || '').trim();
    const ico = (b.supplier_ico || '').trim();
    // Jen při změně klíče: dvojice vzniklá dřív by jinak zablokovala každé uložení obou řádků.
    const [pred] = await sql`SELECT number, supplier, supplier_ico FROM accounting_invoices WHERE id = ${request.params.id} AND type = 'received'`;
    const stejnyKlic = pred && pred.number === cislo && pred.supplier.trim() === dodavatel && (pred.supplier_ico || '').trim() === ico;
    if (!stejnyKlic && await shodaBezIco(sql, { number: cislo, supplier: dodavatel, ico, krome: request.params.id })) return zpetSChybou('duplicita');
    try {
      await sql`
        UPDATE accounting_invoices SET
          number           = ${cislo},
          supplier         = ${dodavatel},
          supplier_ico     = ${ico || null},
          supplier_dic     = ${(b.supplier_dic||'').trim()},
          supplier_address = ${(b.supplier_address||'').trim()},
          supplier_city    = ${(b.supplier_city||'').trim()},
          supplier_zip     = ${(b.supplier_zip||'').trim()},
          supplier_country = ${(b.supplier_country||'Česká republika').trim()},
          amount           = ${amount},
          vat_amount       = ${vatAmount},
          total_amount     = ${totalAmount},
          currency         = ${b.currency || 'CZK'},
          issue_date       = ${issueDate},
          due_date         = ${b.due_date || null},
          notes            = ${(b.notes||'').trim()},
          account_debit    = ${(b.account_debit||'').trim()},
          account_credit   = ${(b.account_credit||'').trim()},
          vat_deductible   = ${vatDeductibleFrom(b)},
          modified_at      = NOW()
        WHERE id = ${request.params.id} AND type = 'received'
      `;
    } catch (err) {
      if (err.code === '23505') return zpetSChybou('duplicita'); // unique_violation: číslo a dodavatel, migrace 045
      throw err;
    }
    return reply.redirect(`/ucetnictvi/prijate-faktury/${request.params.id}?saved=1`);
  });

  fastify.get('/ucetnictvi/prijate-faktury', async (request, reply) => {
    const filtr        = filtrDokladu(request.query);
    const statusFilter = parametr(request.query.status);

    const conditions = [sql`type = 'received'`, ...podminkyFiltru(sql, filtr, {
      datum: 'issue_date', dodavatel: 'supplier',
      hledat: ['internal_number', 'number', 'supplier_number', 'supplier', 'supplier_ico', 'notes'],
    })];
    if (statusFilter) conditions.push(sql`status = ${statusFilter}`);
    const where = sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM accounting_invoices ${where}`;
    const strany = strankovani({ cesta: '/ucetnictvi/prijate-faktury', query: request.query, celkem: count, zachovat: [...filtr.zachovat, 'status'] });
    const invoices = await sql`
      SELECT * FROM accounting_invoices ${where}
      ORDER BY issue_date DESC, created_at DESC, id DESC
      LIMIT ${strany.naStranku} OFFSET ${strany.offset}
    `;
    markMissingAttachments(invoices);

    return reply.view('pages/invoices/received.ejs', {
      pageTitle: 'Přijaté faktury', currentPath: '/ucetnictvi/prijate-faktury',
      user: request.user, invoices, total: count, strany,
      filtr, statusFilter, STATUSES_RECEIVED,
      dodavatele: (await sql`
        SELECT supplier FROM accounting_invoices WHERE type = 'received' AND supplier <> ''
        GROUP BY supplier ORDER BY supplier LIMIT 500
      `).map(r => r.supplier),
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/prijate-faktury/vytvorit', async (request, reply) => {
    // Parsuj multipart (přichází z fetch FormData – i bez souboru)
    const fields = {};
    let attachmentPath = null;

    let attachmentMime = null;
    let attachmentSize = null;

    const parts = request.parts();
    for await (const part of parts) {
      if (part.file) {
        const mime = part.mimetype || '';
        const buf  = await part.toBuffer();   // stream je nutné vždy dočíst
        if (buf.length > 0 && isSupportedMime(mime)) {
          try {
            const saved = await saveAttachment(buf, mime, 'inv_recv', { log: fastify.log });
            attachmentPath = saved.filename;
            attachmentMime = saved.mime;
            attachmentSize = saved.size;
          } catch (err) {
            return reply.code(400).send({ error: err.message });
          }
        }
      } else {
        fields[part.fieldname] = part.value ?? '';
      }
    }

    const b = fields;
    const amount      = parseFloat(b.amount      || 0);
    const vatAmount   = parseFloat(b.vat_amount  || 0);
    const totalAmount = b.total_amount ? parseFloat(b.total_amount) : (amount + vatAmount);
    const newId = generateId();
    const cislo = (b.number || '').trim();
    const dodavatel = (b.supplier || '').trim();
    const ico = (b.supplier_ico || '').trim();
    // Uložená příloha by bez faktury zůstala na disku napořád
    const duplicita = async () => {
      if (attachmentPath) await deleteAttachment(attachmentPath);
      return reply.code(409).send({ error: CHYBY_PRIJATE.duplicita });
    };
    if (await shodaBezIco(sql, { number: cislo, supplier: dodavatel, ico })) return duplicita();

    try {
      await sql`
        INSERT INTO accounting_invoices
          (id, type, number, supplier, supplier_ico, supplier_dic,
           supplier_address, supplier_city, supplier_zip, supplier_country,
           amount, vat_amount, total_amount, currency,
           status, issue_date, due_date, notes, account_debit, account_credit,
           vat_deductible, attachment_path, attachment_mime, attachment_size)
        VALUES (
          ${newId}, 'received',
          ${cislo}, ${dodavatel},
          ${ico || null},
          ${(b.supplier_dic||'').trim()},
          ${(b.supplier_address||'').trim()},
          ${(b.supplier_city||'').trim()},
          ${(b.supplier_zip||'').trim()},
          ${(b.supplier_country||'Česká republika').trim()},
          ${amount}, ${vatAmount}, ${totalAmount},
          ${b.currency || 'CZK'}, ${b.status || 'Nezaplacena'},
          ${b.issue_date || new Date().toISOString().split('T')[0]},
          ${b.due_date || null}, ${(b.notes||'').trim()},
          ${(b.account_debit  || '').trim()},
          ${(b.account_credit || '').trim()},
          ${vatDeductibleFrom(b)},
          ${attachmentPath}, ${attachmentMime}, ${attachmentSize}
        )
      `;
    } catch (err) {
      if (err.code === '23505') return duplicita(); // unique_violation: číslo a dodavatel, migrace 045
      if (attachmentPath) await deleteAttachment(attachmentPath);
      throw err;
    }
    // Odpovídáme JSON (front-end přesměruje)
    return reply.code(201).send({ id: newId });
  });

  // ══════════════════════════════════════════════════════════
  // IMPORT PŘIJATÝCH FAKTUR Z GOOGLE DISKU
  // Struktura: <sdílená složka> / <rok> / <měsíc> / Přijaté faktury
  // ══════════════════════════════════════════════════════════

  const gdriveContext = async (query = {}) => {
    const company = await getIssuer(sql);
    const now   = new Date();
    const year  = parseInt(query.year || now.getFullYear(), 10);
    // month = '' znamená celý rok
    const month = query.month === '' ? null
      : (query.month ? parseInt(query.month, 10) : now.getMonth() + 1);
    return { company, year, month };
  };

  fastify.get('/ucetnictvi/prijate-faktury/gdrive', async (request, reply) => {
    const { isConfigured, serviceAccountEmail, findReceivedInvoices, citelnaChyba, jeChybaPristupu } = await import('../gdrive.js');
    const { company, year, month } = await gdriveContext(request.query);

    let files = [];
    let error = null;

    if (!isConfigured()) {
      error = 'Není nastavena proměnná GOOGLE_SERVICE_ACCOUNT_JSON – doplňte ji v Coolify env vars.';
    } else if (!company.gdrive_root_folder_id) {
      error = 'Není vyplněné ID složky na Google Disku – doplňte jej v Nastavení firmy na záložce Google Disk.';
    } else {
      try {
        files = await findReceivedInvoices({
          rootFolderId: company.gdrive_root_folder_id, year, month,
        });
        const ids = files.map(f => f.id);
        const imported = ids.length > 0
          ? await sql`
              SELECT id, gdrive_file_id, internal_number, number, supplier, total_amount, currency, source
              FROM accounting_invoices WHERE gdrive_file_id = ANY(${ids})
            `
          : [];
        const known = ids.length > 0
          ? await sql`SELECT file_id, stav, chyba, pokusy FROM gdrive_soubory WHERE file_id = ANY(${ids})`
          : [];
        const byFile = new Map(imported.map(r => [r.gdrive_file_id, r]));
        const stavy  = new Map(known.map(r => [r.file_id, r]));
        files = files.map(f => ({
          ...f,
          invoiceId: byFile.get(f.id)?.id || null,
          faktura: byFile.get(f.id) || null,
          stav: stavy.get(f.id)?.stav || null,
          chyba: stavy.get(f.id)?.chyba || '',
          pokusy: stavy.get(f.id)?.pokusy || 0,
        }));
      } catch (err) {
        fastify.log.error({ err }, 'Google Drive listing selhal');
        error = err.message;
      }
    }

    const chybaKontroly = citelnaChyba(company.gdrive_posledni_chyba);
    const tab = zalozka(ZALOZKY_GDRIVE, parametr(request.query.tab));
    const nenahrane = files.filter(f => !f.invoiceId);
    const nahrane = files.filter(f => f.invoiceId);
    const dotazSlozky = (klic) => `/ucetnictvi/prijate-faktury/gdrive?year=${year}&month=${month ?? ''}${klic === 'nahrane' ? '&tab=nahrane' : ''}`;
    // U nenahraných stránkování není: Vybrat vše musí vybrat celou složku.
    const strany = strankovani({
      cesta: '/ucetnictvi/prijate-faktury/gdrive', query: request.query, celkem: nahrane.length,
      pevne: { year, month: month ?? '', tab: 'nahrane' },
    });
    const rok = Number(prazskeDatum(new Date()).slice(0, 4));
    return reply.view('pages/invoices/gdrive.ejs', {
      pageTitle: 'Import z Google Disku', currentPath: '/ucetnictvi/prijate-faktury',
      user: request.user, error, year, month, tab, strany, MAX_POKUSU,
      files: tab === 'nahrane' ? nahrane.slice(strany.offset, strany.offset + strany.naStranku) : nenahrane,
      slozkaPrazdna: files.length === 0,
      automatikaHlida: year === rok || year === rok - 1,
      zalozky: [
        { klic: 'nenahrane', popisek: 'Nenahrané', pocet: nenahrane.length.toLocaleString('cs-CZ') },
        { klic: 'nahrane', popisek: 'Nahrané', pocet: nahrane.length.toLocaleString('cs-CZ') },
      ],
      adresaZalozky: dotazSlozky,
      serviceAccount: serviceAccountEmail(),
      radaNasdilet: jeChybaPristupu(error) || jeChybaPristupu(chybaKontroly),
      rootFolderId: company.gdrive_root_folder_id || '',
      job: gdriveJob,
      kontrola: company.gdrive_posledni_kontrola || null,
      chybaKontroly,
    }, { layout: 'layouts/base.ejs' });
  });

  // Import běží na pozadí – vytěžení jedné faktury trvá ~10 s, celá dávka by
  // přesáhla timeout proxy. Stav drží jedna proměnná, souběžný běh nedovolíme.
  let gdriveJob = null;

  fastify.post('/ucetnictvi/prijate-faktury/gdrive/import', async (request, reply) => {
    // Tlačítko Založit jako novou u nespárovaného dokladu platí jen pro ten jeden soubor.
    // Založit vybrané vezme z výběru jen nespárované: starý doklad, který se ještě
    // nepároval, by jinak mohl založit fakturu, kterou systém z POHODY už má.
    const zalozit = parametr(request.body?.zalozit_novou);
    const vybrane = [].concat(request.body?.file_ids || []).filter(Boolean);
    const zalozitVybrane = request.body?.zalozit_vybrane === '1';
    const fileIds = zalozit ? [zalozit] : zalozitVybrane
      ? (await sql`SELECT file_id FROM gdrive_soubory WHERE file_id = ANY(${vybrane}) AND stav = 'nesparovano'`).map(r => r.file_id)
      : vybrane;
    const { year, month } = await gdriveContext(request.body || {});
    const back = `/ucetnictvi/prijate-faktury/gdrive?year=${year}&month=${month ?? ''}`;

    if (fileIds.length === 0 || gdriveJob?.running) return reply.redirect(back);

    gdriveJob = { running: true, total: fileIds.length, done: 0, imported: 0, merged: 0, nesparovano: 0, skipped: 0, failed: 0, errors: [] };

    // Záměrně bez await – odpovíme hned a klient si stav dotáhne přes /status
    (async () => {
      for (const fileId of fileIds) {
        try {
          const { vysledek } = await importujSoubor(sql, fastify.log, fileId, { zalozitNovou: Boolean(zalozit) || zalozitVybrane });
          gdriveJob[{ imported: 'imported', merged: 'merged', nesparovano: 'nesparovano' }[vysledek] ?? 'skipped']++;
        } catch (err) {
          fastify.log.error({ err, fileId }, 'Import faktury z Google Disku selhal');
          gdriveJob.failed++;
          if (gdriveJob.errors.length < 10) gdriveJob.errors.push(err.message || 'Neznámá chyba');
        }
        gdriveJob.done++;
      }
      gdriveJob.running = false;
    })();

    return reply.redirect(back);
  });

  fastify.get('/ucetnictvi/prijate-faktury/gdrive/status', async (request, reply) => {
    return reply.send(gdriveJob || { running: false, total: 0, done: 0, imported: 0, merged: 0, nesparovano: 0, skipped: 0, failed: 0, errors: [] });
  });

  // ── Upload přílohy k existující přijaté faktuře ───────────────
  fastify.post('/ucetnictvi/prijate-faktury/:id/priloha', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });

    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'Žádný soubor nebyl nahrán.' });
    const mime = data.mimetype || '';
    if (!isSupportedMime(mime)) return reply.code(400).send({ error: 'Podporujeme jen PDF nebo obrázek.' });

    const buf = await data.toBuffer();
    let saved;
    try {
      saved = await saveAttachment(buf, mime, 'inv_recv', { log: fastify.log });
    } catch (err) {
      fastify.log.warn({ err }, 'Uložení přílohy faktury selhalo');
      return reply.code(400).send({ error: err.message });
    }

    const [prev] = await sql`SELECT attachment_path FROM accounting_invoices WHERE id = ${request.params.id}`;
    await sql`
      UPDATE accounting_invoices SET
        attachment_path = ${saved.filename},
        attachment_mime = ${saved.mime},
        attachment_size = ${saved.size},
        modified_at     = NOW()
      WHERE id = ${request.params.id}
    `;
    if (prev?.attachment_path) await deleteAttachment(prev.attachment_path);
    return reply.send({ id: request.params.id, attachment_path: saved.filename });
  });

  // ── Export CSV ────────────────────────────────────────────────
  fastify.get('/ucetnictvi/vydane-faktury/export.csv', async (request, reply) => {
    const invoices = await sql`SELECT * FROM accounting_invoices WHERE type='issued' ORDER BY issue_date DESC`;
    // DUZP až na konci – kdo si export načítá podle pořadí sloupců, o nic nepřijde.
    // Bez taxable_date je to datum vystavení, stejně jako v PDF a v POHODĚ.
    const header = 'Číslo;Klient;IČO;Vystavení;Splatnost;Zaplaceno;Základ;DPH;Celkem;Měna;Stav;DUZP';
    const rows = invoices.map(i => [
      i.number, i.client_name||'', i.client_ico||'',
      i.issue_date?.toISOString?.()?.slice(0,10) || '',
      i.due_date?.toISOString?.()?.slice(0,10)   || '',
      i.paid_date?.toISOString?.()?.slice(0,10)  || '',
      String(i.amount||0).replace('.',','),
      String(i.vat_amount||0).replace('.',','),
      String(i.total_amount||0).replace('.',','),
      i.currency, i.status,
      jenDatum(i.taxable_date) ?? jenDatum(i.issue_date) ?? '',
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(';')).join('\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="vydane-faktury.csv"');
    return reply.send('﻿' + header + '\n' + rows);
  });

  fastify.get('/ucetnictvi/prijate-faktury/export.csv', async (request, reply) => {
    const invoices = await sql`SELECT * FROM accounting_invoices WHERE type='received' ORDER BY issue_date DESC`;
    const header = 'Číslo;Dodavatel;IČO;Přijato;Splatnost;Zaplaceno;Základ;DPH;Celkem;Měna;Stav;Interní číslo';
    const rows = invoices.map(i => [
      i.number, i.supplier||'', i.supplier_ico||'',
      i.issue_date?.toISOString?.()?.slice(0,10) || '',
      i.due_date?.toISOString?.()?.slice(0,10)   || '',
      i.paid_date?.toISOString?.()?.slice(0,10)  || '',
      String(i.amount||0).replace('.',','),
      String(i.vat_amount||0).replace('.',','),
      String(i.total_amount||0).replace('.',','),
      i.currency, i.status, i.internal_number || '',
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(';')).join('\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="prijate-faktury.csv"');
    return reply.send('﻿' + header + '\n' + rows);
  });

  fastify.post('/ucetnictvi/prijate-faktury/:id/stav', async (request, reply) => {
    const { status, redirect_to } = request.body || {};
    if (!STATUSES_RECEIVED.includes(status)) return reply.code(400).send('Neplatný stav');
    const updates = [sql`status = ${status}`, sql`modified_at = NOW()`];
    if (status === 'Zaplacena') updates.push(sql`paid_date = CURRENT_DATE`);
    await sql`UPDATE accounting_invoices SET ${updates.reduce((a, b) => sql`${a}, ${b}`)} WHERE id = ${request.params.id}`;
    return reply.redirect(bezpecnyNavrat(redirect_to, `/ucetnictvi/prijate-faktury/${request.params.id}`));
  });

  // ── POHODA XML export ─────────────────────────────────────────
  //
  // Vydané i přijaté faktury jedou stejnou cestou – liší se jen typem dokladu,
  // předkontací a jménem souboru. Storno doklady do účetnictví nepatří,
  // proto se do balíčku nedostanou ani při exportu „všeho“.
  async function exportPohodaInvoices(request, reply, { type, filename, note }) {
    const ids = [].concat(request.body?.ids || []).map(String).filter(Boolean);
    const invoices = ids.length > 0
      ? await sql`SELECT * FROM accounting_invoices WHERE type = ${type} AND id = ANY(${ids}) AND status <> 'Storno' ORDER BY issue_date DESC`
      : await sql`SELECT * FROM accounting_invoices WHERE type = ${type} AND status <> 'Storno' ORDER BY issue_date DESC`;

    const plain = txt => reply.code(400).type('text/plain; charset=utf-8').send(txt);

    if (invoices.length === 0) {
      return plain('Není co exportovat – vybrané faktury jsou ve stavu Storno nebo žádné neexistují.');
    }

    const issuer = await getIssuer(sql);
    if (!issuer.ico) {
      return plain('Chybí IČO firmy – POHODA bez něj nepozná účetní jednotku. Doplňte jej v Nastavení firmy na záložce Základní údaje.');
    }

    // Položky jedním dotazem – přijaté faktury je většinou nemají a i tak
    // se do balíčku vejdou jako jeden souhrnný řádek.
    const invoiceIds = invoices.map(i => i.id);
    const items = await sql`
      SELECT * FROM accounting_invoice_items WHERE invoice_id = ANY(${invoiceIds}) ORDER BY id
    `;
    const byInvoice = new Map();
    for (const it of items) {
      if (!byInvoice.has(it.invoice_id)) byInvoice.set(it.invoice_id, []);
      byInvoice.get(it.invoice_id).push(it);
    }

    const xml = buildPohodaXml(
      invoices.map(inv => ({ ...inv, _items: byInvoice.get(inv.id) || [] })),
      {
        ico:                 issuer.ico,
        predkontaceReceived: issuer.pohoda_predkontace_prijate || '',
        predkontaceNoVat:    issuer.pohoda_predkontace_repre   || '',
        note,
      },
    );

    // Datum exportu drží seznam, aby bylo poznat, co už účetní jednou dostala
    await sql`UPDATE accounting_invoices SET pohoda_exported_at = NOW() WHERE id = ANY(${invoiceIds})`;

    reply.header('Content-Type', 'application/xml; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(xml);
  }

  fastify.post('/ucetnictvi/vydane-faktury/pohoda-xml', (request, reply) =>
    exportPohodaInvoices(request, reply, {
      type: 'issued',
      filename: 'pohoda-vydane-faktury.xml',
      note: 'Vydané faktury z one.seil.space',
    }));

  fastify.post('/ucetnictvi/prijate-faktury/pohoda-xml', (request, reply) =>
    exportPohodaInvoices(request, reply, {
      type: 'received',
      filename: 'pohoda-prijate-faktury.xml',
      note: 'Přijaté faktury z one.seil.space',
    }));

  // ── Opakující se faktury – šablony ───────────────────────────

  fastify.get('/ucetnictvi/sablony-faktur', async (request, reply) => {
    const templates = await sql`
      SELECT r.*, s.name AS series_name
      FROM recurring_invoices r
      LEFT JOIN invoice_number_series s ON r.series_id = s.id
      ORDER BY r.active DESC, r.name
    `;
    const series = await sql`
      SELECT * FROM invoice_number_series WHERE active = TRUE AND entity_type = 'faktura' ORDER BY shop_id NULLS FIRST, name
    `;
    return reply.view('pages/invoices/recurring.ejs', {
      pageTitle: 'Šablony opakujících se faktur', currentPath: '/ucetnictvi/sablony-faktur',
      user: request.user, templates, series,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/sablony-faktur/vytvorit', async (request, reply) => {
    const b = request.body || {};
    const items = [];
    const names = [].concat(b['item_name[]'] || []);
    const qtys  = [].concat(b['item_qty[]']  || []);
    const prices = [].concat(b['item_price[]'] || []);
    const vats  = [].concat(b['item_vat[]']  || []);
    for (let i = 0; i < names.length; i++) {
      if (!names[i]) continue;
      const qty   = Number(qtys[i]   || 1);
      const price = Number(prices[i] || 0);
      const vat   = Number(vats[i]   || 21);
      items.push({ name: names[i], quantity: qty, unit: 'ks', price, vat_rate: vat, amount: qty * price, vat_amount: qty * price * vat / 100 });
    }
    await sql`
      INSERT INTO recurring_invoices
        (name, series_id, client_name, client_ico, client_dic, client_address, client_email,
         items, frequency, day_of_month, due_days, next_run_date, active, send_email, created_by)
      VALUES (
        ${b.name || 'Šablona'}, ${b.series_id ? parseInt(b.series_id) : null},
        ${(b.client_name||'').trim()}, ${(b.client_ico||'').trim()}, ${(b.client_dic||'').trim()},
        ${(b.client_address||'').trim()}, ${(b.client_email||'').trim()},
        ${JSON.stringify(items)},
        ${b.frequency || 'monthly'}, ${parseInt(b.day_of_month||1)}, ${parseInt(b.due_days||14)},
        ${b.next_run_date || new Date().toISOString().slice(0,10)},
        TRUE, ${b.send_email === 'on'}, ${request.user.id}
      )
    `;
    return reply.redirect('/ucetnictvi/sablony-faktur');
  });

  fastify.post('/ucetnictvi/sablony-faktur/:id/toggle', async (request, reply) => {
    await sql`UPDATE recurring_invoices SET active = NOT active WHERE id = ${request.params.id}`;
    return reply.redirect('/ucetnictvi/sablony-faktur');
  });

  fastify.post('/ucetnictvi/sablony-faktur/:id/smazat', async (request, reply) => {
    await sql`DELETE FROM recurring_invoices WHERE id = ${request.params.id}`;
    return reply.redirect('/ucetnictvi/sablony-faktur');
  });
}
