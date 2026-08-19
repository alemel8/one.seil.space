import { getDb, generateId } from '../db.js';
import { renderInvoicePdf } from '../pdf.js';
import { sendInvoiceEmail, sendReminderEmail } from '../email.js';
import { buildPohodaXml } from '../pohoda.js';
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { renderSeriesNumber, invoiceVs } from '../series-format.js';
import { saveAttachment, deleteAttachment, isSupportedMime, markMissingAttachments } from '../attachments.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const PDFS_DIR   = path.join(projectRoot, 'data/pdfs');

const STATUSES_ISSUED   = ['Nezaplacena', 'Zaplacena', 'Po splatnosti', 'Storno'];
const STATUSES_RECEIVED = ['Nezaplacena', 'Zaplacena', 'Po splatnosti', 'Storno'];

const FORM_ERRORS = {
  klient:    'Vyplňte klienta.',
  polozky:   'Faktura musí mít alespoň jednu položku s popisem.',
  castka:    'Celková částka musí být větší než nula.',
  duplicita: 'Faktura s tímto číslem už existuje.',
};

// ── Načtení nastavení firmy (issuer) ─────────────────────────

async function getIssuer(sql) {
  const [company] = await sql`SELECT * FROM company_settings LIMIT 1`;
  return company || {};
}

// ── AI: vytěžení dat přijaté faktury z PDF/obrázku ───────────

const EXTRACT_PROMPT = `Z tohoto dokladu vyextrahuj data přijaté faktury. Vrať POUZE platný JSON objekt bez markdown bloků ani dalšího textu:
{"number":"číslo faktury od dodavatele","supplier":"název dodavatele","supplier_ico":"IČO nebo null","amount":základ_bez_DPH_číslo,"vat_amount":DPH_číslo,"total_amount":celková_částka_číslo,"currency":"CZK","issue_date":"YYYY-MM-DD nebo null","due_date":"YYYY-MM-DD nebo null","notes":"předmět plnění nebo null"}`;

async function extractInvoiceData(buf, mimeType, log) {
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

// ── Výpočet DPH souhrnu ───────────────────────────────────────

function calcVatSummary(items) {
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
// Jeden řádek přijde jako string, víc řádků jako pole — proto toArray.

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
    // Archivace je vedlejší — když selže, e-mail už stejně odešel
    log?.warn({ err }, 'PDF faktury se nepodařilo uložit');
    return null;
  }
}

// ── Odeslání upomínky ────────────────────────────────────────
//
// Sdílené oběma cestami: tlačítkem na detailu faktury i seznamem upomínek.
// Upomínku vždy spouští člověk — worker ji jen připraví do stavu 'ceka'.

export function daysOverdue(dueDate, today = new Date()) {
  if (!dueDate) return 0;
  const diff = today - new Date(dueDate);
  return Math.max(0, Math.floor(diff / 86400000));
}

async function deliverReminder(sql, { invoice, email, level, reminderId = null, daysOverdue: days, userId, log }) {
  const issuer = await getIssuer(sql);
  const overdue = days ?? daysOverdue(invoice.due_date);
  let subject = `Upomínka — faktura ${invoice.number}`;

  try {
    const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${invoice.id} ORDER BY id`;
    const pdfBuffer = await renderInvoicePdf({ invoice, items, issuer, vatSummary: calcVatSummary(items) });

    ({ subject } = await sendReminderEmail({
      invoice, issuer, email, pdfBuffer, level, daysOverdue: overdue,
      paymentDetails: {
        accountNumber:  issuer.bank_account || '',
        iban:           issuer.iban || '',
        variableSymbol: invoiceVs(invoice.number),
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

async function nextInvoiceNumber(sql, seriesId) {
  const [series] = await sql`
    UPDATE invoice_number_series SET current_number = current_number + 1
    WHERE id = ${seriesId} AND active = TRUE RETURNING *
  `;
  if (!series) throw new Error('Číselná řada nenalezena nebo není aktivní');
  return renderSeriesNumber(series);
}

// Výchozí číselná řada podle eshopu, ze kterého objednávka přišla
async function pickDefaultSeries(sql, shopId, entityType) {
  const [series] = await sql`
    SELECT id FROM invoice_number_series
    WHERE shop_id = ${shopId} AND entity_type = ${entityType} AND active = TRUE
    ORDER BY id LIMIT 1
  `;
  return series?.id || null;
}

function defaultDueDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
}

async function insertOrderInvoiceItems(sql, orderItems, invoiceId, vatRate) {
  for (const item of orderItems) {
    const itemBase   = +(Number(item.price) / (1 + vatRate / 100) * item.quantity).toFixed(2);
    const itemVat    = +(Number(item.price) * item.quantity - itemBase).toFixed(2);
    const itemTotal  = +(Number(item.price) * item.quantity).toFixed(2);
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
}

// ── Vystavit zálohovou fakturu z objednávky (platba převodem) ────
//
// Volá se automaticky při vzniku objednávky s platbou převodem
// (src/routes/toneracek.js), nebo jako ruční záchranná akce z UI.

export async function generateProformaForOrder(sql, order) {
  const orderItems = await sql`SELECT * FROM shop_order_items WHERE order_id = ${order.id}`;

  const seriesId = await pickDefaultSeries(sql, order.shop_id, 'zalohova_faktura');
  let number = '';
  if (seriesId) number = await nextInvoiceNumber(sql, seriesId);
  if (!number) number = `ZF-${new Date().getFullYear()}-${order.order_number}`;

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
       issue_date, due_date)
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
      ${new Date().toISOString().split('T')[0]},
      ${defaultDueDate(7)}
    )
  `;

  await insertOrderInvoiceItems(sql, orderItems, invoiceId, vatRate);

  const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${invoiceId}`;
  return invoice;
}

// ── Vystavit běžnou (vydanou) fakturu z objednávky ────────────────
//
// Volá se automaticky při přepnutí stavu objednávky na "Vyřízena"
// (src/routes/toneracek.js). Faktura se vystavuje vždy jako už uhrazená —
// u karty/dobírky je platba v tu chvíli fakticky přijatá, u převodu je
// podmínkou zaplacená zálohová faktura (`fromProforma`), ze které se
// faktura vystaví s nulovým doplatkem.

export async function generateInvoiceForOrder(sql, order, { fromProforma } = {}) {
  const orderItems = await sql`SELECT * FROM shop_order_items WHERE order_id = ${order.id}`;

  const seriesId = await pickDefaultSeries(sql, order.shop_id, 'faktura');
  let number = '';
  if (seriesId) number = await nextInvoiceNumber(sql, seriesId);
  if (!number) number = order.invoice_number || `FV-${new Date().getFullYear()}-${order.order_number}`;

  const vatRate = 21;
  const totalWithVat = Number(order.total_price);
  const base   = +(totalWithVat / (1 + vatRate / 100)).toFixed(2);
  const vatAmt = +(totalWithVat - base).toFixed(2);

  const invoiceId = generateId();
  const today = new Date().toISOString().split('T')[0];

  await sql`
    INSERT INTO accounting_invoices
      (id, type, series_id, number, status, paid_date,
       shop_id, order_id, crm_contact_id, crm_company_id, proforma_invoice_id,
       client_name, client_ico, client_dic, client_address,
       amount, vat_amount, total_amount, currency,
       issue_date, due_date)
    VALUES (
      ${invoiceId}, 'issued',
      ${seriesId},
      ${number}, 'Zaplacena', ${today},
      ${order.shop_id}, ${order.id},
      ${order.crm_contact_id || null}, ${order.crm_company_id || null}, ${fromProforma?.id || null},
      ${`${order.first_name} ${order.last_name}`.trim() || order.company || ''},
      ${order.ic || ''}, ${order.dic || ''},
      ${[order.address, order.zip + ' ' + order.city].filter(Boolean).join(', ')},
      ${base}, ${vatAmt}, ${totalWithVat},
      ${order.currency || 'CZK'},
      ${today},
      ${defaultDueDate(14)}
    )
  `;

  await insertOrderInvoiceItems(sql, orderItems, invoiceId, vatRate);

  const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${invoiceId}`;
  return invoice;
}

export default async function invoicesRoutes(fastify) {
  const sql = getDb();

  // ══════════════════════════════════════════════════════════
  // VYDANÉ FAKTURY
  // ══════════════════════════════════════════════════════════

  fastify.get('/ucetnictvi/vydane-faktury', async (request, reply) => {
    const q            = (request.query.q      || '').trim();
    const statusFilter = (request.query.status || '').trim();
    const page    = Math.max(1, parseInt(request.query.page || '1', 10));
    const perPage = 25;
    const offset  = (page - 1) * perPage;

    const conditions = [sql`type = 'issued'`];
    if (q) conditions.push(sql`(number ILIKE ${'%'+q+'%'} OR client_name ILIKE ${'%'+q+'%'})`);
    if (statusFilter) conditions.push(sql`status = ${statusFilter}`);
    const where = sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM accounting_invoices ${where}`;
    const invoices    = await sql`SELECT * FROM accounting_invoices ${where} ORDER BY issue_date DESC LIMIT ${perPage} OFFSET ${offset}`;
    const series      = await sql`SELECT * FROM invoice_number_series WHERE active = TRUE ORDER BY name`;

    return reply.view('pages/invoices/issued.ejs', {
      pageTitle: 'Vydané faktury', currentPath: '/ucetnictvi/vydane-faktury',
      user: request.user, invoices, total: count,
      currentPage: page, totalPages: Math.ceil(count / perPage),
      q, statusFilter, STATUSES_ISSUED, series,
      formError: FORM_ERRORS[request.query.formError] || '',
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
      SELECT * FROM invoice_emails WHERE invoice_id = ${invoice.id} ORDER BY sent_at DESC LIMIT 10
    `;
    const reminders  = await sql`
      SELECT * FROM invoice_reminders WHERE invoice_id = ${invoice.id} ORDER BY level
    `;
    return reply.view('pages/invoices/issued-detail.ejs', {
      pageTitle: `Faktura ${invoice.number}`, currentPath: '/ucetnictvi/vydane-faktury',
      user: request.user, invoice, items, vatSummary, STATUSES_ISSUED, order,
      emailSent, emailError, emailLog, reminders,
      suggestedEmail: await resolveClientEmail(sql, invoice),
      formError: FORM_ERRORS[request.query.formError] || '',
    }, { layout: 'layouts/base.ejs' });
  });

  // Vytvořit vydanou fakturu manuálně
  fastify.post('/ucetnictvi/vydane-faktury/vytvorit', async (request, reply) => {
    const b = request.body || {};
    const fail = code => reply.redirect(`/ucetnictvi/vydane-faktury?formError=${code}`);

    const clientName = (b.client_name || '').trim();
    if (!clientName) return fail('klient');

    const items = parseItemRows(b);
    if (!items.length) return fail('polozky');

    const { amount, vatAmount, total } = sumItems(items);
    if (total <= 0) return fail('castka');

    // Ruční číslo nesmí kolidovat; číslo z řady je z podstaty nové
    const manualNumber = (b.number || '').trim();
    if (manualNumber) {
      const [clash] = await sql`
        SELECT id FROM accounting_invoices WHERE type = 'issued' AND number = ${manualNumber} LIMIT 1
      `;
      if (clash) return fail('duplicita');
    }

    let number = manualNumber;
    if (!number && b.series_id) number = await nextInvoiceNumber(sql, parseInt(b.series_id, 10));
    if (!number) number = `FV-${new Date().getFullYear()}-${Date.now()}`;

    const id = generateId();
    const clientIco = (b.client_ico || '').trim();

    try {
      await sql.begin(async tx => {
        await tx`
          INSERT INTO accounting_invoices
            (id, type, series_id, number, status, client_name, client_ico, client_dic, client_address,
             client_email, crm_company_id, crm_contact_id,
             amount, vat_amount, total_amount, currency, issue_date, due_date, notes,
             account_debit, account_credit)
          VALUES (
            ${id}, 'issued',
            ${b.series_id ? parseInt(b.series_id, 10) : null},
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
      if (err.code === '23505') return fail('duplicita');   // unique_violation
      throw err;
    }

    return reply.redirect(`/ucetnictvi/vydane-faktury/${id}`);
  });

  // Vystavit zálohovou fakturu z objednávky — ruční záchranná akce
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

  // Vystavit běžnou fakturu z objednávky — ruční záchranná akce
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
      SELECT id FROM accounting_invoices WHERE id = ${request.params.id} AND type IN ('issued', 'proforma')
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

  // Změna stavu faktury
  fastify.post('/ucetnictvi/vydane-faktury/:id/stav', async (request, reply) => {
    const { status } = request.body || {};
    if (!STATUSES_ISSUED.includes(status)) return reply.code(400).send('Neplatný stav');
    const updates = [sql`status = ${status}`, sql`modified_at = NOW()`];
    if (status === 'Zaplacena') updates.push(sql`paid_date = CURRENT_DATE`);
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

    const pdfBuffer = await renderInvoicePdf({ invoice, items, issuer, vatSummary });

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
    const subject = `Faktura ${invoice.number} — ${issuer.name}`;

    try {
      const pdfBuffer = await renderInvoicePdf({ invoice, items, issuer, vatSummary });
      await sendInvoiceEmail({
        invoice, issuer, email, pdfBuffer, subject,
        paymentDetails: {
          accountNumber:  issuer.bank_account || '',
          iban:           issuer.iban || '',
          variableSymbol: invoiceVs(invoice.number),
        },
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

  // Odeslat upomínku k faktuře — vždy ruční akce
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
    const statusFilter = (request.query.status || 'ceka').trim();

    const reminders = await sql`
      SELECT r.*, i.number, i.client_name, i.client_email, i.client_ico,
             i.total_amount, i.currency, i.due_date, i.status AS invoice_status,
             i.crm_company_id, i.crm_contact_id
      FROM invoice_reminders r
      JOIN accounting_invoices i ON i.id = r.invoice_id
      ${statusFilter ? sql`WHERE r.status = ${statusFilter}` : sql``}
      ORDER BY r.level DESC, r.days_overdue DESC
    `;

    // E-mail se dohledává až tady, ať se v seznamu dá rovnou odeslat
    const rows = [];
    for (const r of reminders) {
      rows.push({ ...r, email: await resolveClientEmail(sql, r) });
    }

    const counts = await sql`
      SELECT status, COUNT(*)::int AS n FROM invoice_reminders GROUP BY status
    `;

    return reply.view('pages/invoices/reminders.ejs', {
      pageTitle: 'Upomínky', currentPath: '/ucetnictvi/upominky',
      user: request.user, reminders: rows, statusFilter,
      counts: Object.fromEntries(counts.map(c => [c.status, c.n])),
      sent: request.query.sent === '1', error: request.query.error === '1',
    }, { layout: 'layouts/base.ejs' });
  });

  // Odeslat připravenou upomínku ze seznamu
  fastify.post('/ucetnictvi/upominky/:id/odeslat', async (request, reply) => {
    const [reminder] = await sql`SELECT * FROM invoice_reminders WHERE id = ${parseInt(request.params.id, 10)}`;
    if (!reminder) return reply.code(404).send('Upomínka nenalezena');

    const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${reminder.invoice_id}`;
    if (!invoice) return reply.code(404).send('Faktura nenalezena');

    const email = (request.body?.email || '').trim() || await resolveClientEmail(sql, invoice);
    if (!email) return reply.redirect('/ucetnictvi/upominky?error=1');

    const result = await deliverReminder(sql, {
      invoice, email, level: reminder.level, reminderId: reminder.id,
      daysOverdue: reminder.days_overdue, userId: request.user?.id, log: fastify.log,
    });

    return reply.redirect(`/ucetnictvi/upominky?${result.ok ? 'sent=1' : 'error=1'}`);
  });

  // Zrušit upomínku (např. klient zaplatil mimo systém)
  fastify.post('/ucetnictvi/upominky/:id/zrusit', async (request, reply) => {
    await sql`UPDATE invoice_reminders SET status = 'zrusena' WHERE id = ${parseInt(request.params.id, 10)}`;
    return reply.redirect('/ucetnictvi/upominky');
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
      pageTitle: `Přijatá ${invoice.number}`, currentPath: '/ucetnictvi/prijate-faktury',
      user: request.user, invoice, bankTx, STATUSES_RECEIVED,
      saved: request.query.saved === '1',
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/prijate-faktury/:id/upravit', async (request, reply) => {
    const b = request.body || {};
    const amount      = parseFloat(b.amount     || 0);
    const vatAmount   = parseFloat(b.vat_amount || 0);
    const totalAmount = b.total_amount ? parseFloat(b.total_amount) : (amount + vatAmount);
    await sql`
      UPDATE accounting_invoices SET
        number           = ${b.number || ''},
        supplier         = ${(b.supplier||'').trim()},
        supplier_ico     = ${(b.supplier_ico||'').trim() || null},
        supplier_dic     = ${(b.supplier_dic||'').trim()},
        supplier_address = ${(b.supplier_address||'').trim()},
        supplier_city    = ${(b.supplier_city||'').trim()},
        supplier_zip     = ${(b.supplier_zip||'').trim()},
        supplier_country = ${(b.supplier_country||'Česká republika').trim()},
        amount           = ${amount},
        vat_amount       = ${vatAmount},
        total_amount     = ${totalAmount},
        currency         = ${b.currency || 'CZK'},
        issue_date       = ${b.issue_date || new Date().toISOString().split('T')[0]},
        due_date         = ${b.due_date || null},
        notes            = ${(b.notes||'').trim()},
        account_debit    = ${(b.account_debit||'').trim()},
        account_credit   = ${(b.account_credit||'').trim()},
        modified_at      = NOW()
      WHERE id = ${request.params.id} AND type = 'received'
    `;
    return reply.redirect(`/ucetnictvi/prijate-faktury/${request.params.id}`);
  });

  fastify.get('/ucetnictvi/prijate-faktury', async (request, reply) => {
    const q            = (request.query.q      || '').trim();
    const statusFilter = (request.query.status || '').trim();
    const page    = Math.max(1, parseInt(request.query.page || '1', 10));
    const perPage = 25;
    const offset  = (page - 1) * perPage;

    const conditions = [sql`type = 'received'`];
    if (q) conditions.push(sql`(number ILIKE ${'%'+q+'%'} OR supplier ILIKE ${'%'+q+'%'})`);
    if (statusFilter) conditions.push(sql`status = ${statusFilter}`);
    const where = sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM accounting_invoices ${where}`;
    const invoices    = await sql`SELECT * FROM accounting_invoices ${where} ORDER BY issue_date DESC LIMIT ${perPage} OFFSET ${offset}`;
    markMissingAttachments(invoices);

    return reply.view('pages/invoices/received.ejs', {
      pageTitle: 'Přijaté faktury', currentPath: '/ucetnictvi/prijate-faktury',
      user: request.user, invoices, total: count,
      currentPage: page, totalPages: Math.ceil(count / perPage),
      q, statusFilter, STATUSES_RECEIVED,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/prijate-faktury/vytvorit', async (request, reply) => {
    // Parsuj multipart (přichází z fetch FormData — i bez souboru)
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

    await sql`
      INSERT INTO accounting_invoices
        (id, type, number, supplier, supplier_ico, supplier_dic,
         supplier_address, supplier_city, supplier_zip, supplier_country,
         amount, vat_amount, total_amount, currency,
         status, issue_date, due_date, notes, account_debit, account_credit,
         attachment_path, attachment_mime, attachment_size)
      VALUES (
        ${newId}, 'received',
        ${b.number || ''}, ${(b.supplier||'').trim()},
        ${(b.supplier_ico||'').trim() || null},
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
        ${attachmentPath}, ${attachmentMime}, ${attachmentSize}
      )
    `;
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
    const { isConfigured, serviceAccountEmail, findReceivedInvoices } = await import('../gdrive.js');
    const { company, year, month } = await gdriveContext(request.query);

    let files = [];
    let error = null;

    if (!isConfigured()) {
      error = 'Není nastavena proměnná GOOGLE_SERVICE_ACCOUNT_JSON — doplňte ji v Coolify env vars.';
    } else if (!company.gdrive_root_folder_id) {
      error = 'Není vyplněné ID složky na Google Disku — doplňte jej v Nastavení → Firma.';
    } else {
      try {
        files = await findReceivedInvoices({
          rootFolderId: company.gdrive_root_folder_id, year, month,
        });
        const ids = files.map(f => f.id);
        const imported = ids.length > 0
          ? await sql`SELECT id, gdrive_file_id FROM accounting_invoices WHERE gdrive_file_id = ANY(${ids})`
          : [];
        const byFile = new Map(imported.map(r => [r.gdrive_file_id, r.id]));
        files = files.map(f => ({ ...f, invoiceId: byFile.get(f.id) || null }));
      } catch (err) {
        fastify.log.error({ err }, 'Google Drive listing selhal');
        error = err.message;
      }
    }

    return reply.view('pages/invoices/gdrive.ejs', {
      pageTitle: 'Import z Google Disku', currentPath: '/ucetnictvi/prijate-faktury',
      user: request.user, files, error, year, month,
      serviceAccount: serviceAccountEmail(),
      rootFolderId: company.gdrive_root_folder_id || '',
      job: gdriveJob,
    }, { layout: 'layouts/base.ejs' });
  });

  // Import jednoho souboru: stáhnout → vytěžit Claudem → založit fakturu
  const importGdriveFile = async (fileId) => {
    const { downloadFile, getFile } = await import('../gdrive.js');

    // Přeskoč, co už v systému je (dvojklik na tlačítko, souběžný běh)
    const [existing] = await sql`SELECT id FROM accounting_invoices WHERE gdrive_file_id = ${fileId}`;
    if (existing) return 'skipped';

    const meta = await getFile(fileId);
    const buf  = await downloadFile(fileId);
    const mime = meta.mimeType || 'application/pdf';
    const d    = await extractInvoiceData(buf, mime, fastify.log);

    const saved = await saveAttachment(buf, mime, 'inv_recv_gd', { log: fastify.log });

    const amount      = parseFloat(d.amount     || 0);
    const vatAmount   = parseFloat(d.vat_amount || 0);
    const totalAmount = d.total_amount ? parseFloat(d.total_amount) : (amount + vatAmount);

    await sql`
      INSERT INTO accounting_invoices
        (id, type, number, supplier, supplier_ico, amount, vat_amount, total_amount,
         currency, status, issue_date, due_date, notes,
         attachment_path, attachment_mime, attachment_size, gdrive_file_id)
      VALUES (
        ${generateId()}, 'received',
        ${String(d.number || meta.name || '').slice(0, 60)},
        ${(d.supplier || '').trim()},
        ${(d.supplier_ico || '').trim() || null},
        ${amount}, ${vatAmount}, ${totalAmount},
        ${d.currency || 'CZK'}, 'Nezaplacena',
        ${d.issue_date || new Date().toISOString().split('T')[0]},
        ${d.due_date || null},
        ${(d.notes || '').trim() || meta.name},
        ${saved.filename}, ${saved.mime}, ${saved.size}, ${fileId}
      )
    `;
    return 'imported';
  };

  // Import běží na pozadí — vytěžení jedné faktury trvá ~10 s, celá dávka by
  // přesáhla timeout proxy. Stav drží jedna proměnná, souběžný běh nedovolíme.
  let gdriveJob = null;

  fastify.post('/ucetnictvi/prijate-faktury/gdrive/import', async (request, reply) => {
    const fileIds = [].concat(request.body?.file_ids || []).filter(Boolean);
    const { year, month } = await gdriveContext(request.body || {});
    const back = `/ucetnictvi/prijate-faktury/gdrive?year=${year}&month=${month ?? ''}`;

    if (fileIds.length === 0 || gdriveJob?.running) return reply.redirect(back);

    gdriveJob = { running: true, total: fileIds.length, done: 0, imported: 0, skipped: 0, failed: 0, errors: [] };

    // Záměrně bez await — odpovíme hned a klient si stav dotáhne přes /status
    (async () => {
      for (const fileId of fileIds) {
        try {
          const result = await importGdriveFile(fileId);
          gdriveJob[result === 'imported' ? 'imported' : 'skipped']++;
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
    return reply.send(gdriveJob || { running: false, total: 0, done: 0, imported: 0, skipped: 0, failed: 0, errors: [] });
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
    const header = 'Číslo;Klient;IČO;Vystavení;Splatnost;Zaplaceno;Základ;DPH;Celkem;Měna;Stav';
    const rows = invoices.map(i => [
      i.number, i.client_name||'', i.client_ico||'',
      i.issue_date?.toISOString?.()?.slice(0,10) || '',
      i.due_date?.toISOString?.()?.slice(0,10)   || '',
      i.paid_date?.toISOString?.()?.slice(0,10)  || '',
      String(i.amount||0).replace('.',','),
      String(i.vat_amount||0).replace('.',','),
      String(i.total_amount||0).replace('.',','),
      i.currency, i.status,
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(';')).join('\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="vydane-faktury.csv"');
    return reply.send('﻿' + header + '\n' + rows);
  });

  fastify.get('/ucetnictvi/prijate-faktury/export.csv', async (request, reply) => {
    const invoices = await sql`SELECT * FROM accounting_invoices WHERE type='received' ORDER BY issue_date DESC`;
    const header = 'Číslo;Dodavatel;IČO;Přijato;Splatnost;Zaplaceno;Základ;DPH;Celkem;Měna;Stav';
    const rows = invoices.map(i => [
      i.number, i.supplier||'', i.supplier_ico||'',
      i.issue_date?.toISOString?.()?.slice(0,10) || '',
      i.due_date?.toISOString?.()?.slice(0,10)   || '',
      i.paid_date?.toISOString?.()?.slice(0,10)  || '',
      String(i.amount||0).replace('.',','),
      String(i.vat_amount||0).replace('.',','),
      String(i.total_amount||0).replace('.',','),
      i.currency, i.status,
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
    return reply.redirect(redirect_to || `/ucetnictvi/prijate-faktury/${request.params.id}`);
  });

  // ── POHODA XML export ─────────────────────────────────────────
  fastify.post('/ucetnictvi/vydane-faktury/pohoda-xml', async (request, reply) => {
    const ids = [].concat(request.body?.ids || []).map(Number).filter(Boolean);
    const invoices = ids.length > 0
      ? await sql`SELECT * FROM accounting_invoices WHERE type='issued' AND id = ANY(${ids}) ORDER BY issue_date DESC`
      : await sql`SELECT * FROM accounting_invoices WHERE type='issued' ORDER BY issue_date DESC`;

    const withItems = await Promise.all(invoices.map(async inv => {
      const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${inv.id} ORDER BY id`;
      return { ...inv, _items: items };
    }));

    const issuer = await getIssuer(sql);
    const xml = buildPohodaXml(withItems, { ico: issuer.ico, note: 'Vydané faktury z one.seil.space' });
    reply.header('Content-Type', 'application/xml; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="pohoda-vydane-faktury.xml"');
    return reply.send(xml);
  });

  fastify.post('/ucetnictvi/prijate-faktury/pohoda-xml', async (request, reply) => {
    const ids = [].concat(request.body?.ids || []).map(Number).filter(Boolean);
    const invoices = ids.length > 0
      ? await sql`SELECT * FROM accounting_invoices WHERE type='received' AND id = ANY(${ids}) ORDER BY issue_date DESC`
      : await sql`SELECT * FROM accounting_invoices WHERE type='received' ORDER BY issue_date DESC`;

    const issuer = await getIssuer(sql);
    const xml = buildPohodaXml(invoices, { ico: issuer.ico, note: 'Přijaté faktury z one.seil.space' });
    reply.header('Content-Type', 'application/xml; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="pohoda-prijate-faktury.xml"');
    return reply.send(xml);
  });

  // ── Opakující se faktury — šablony ───────────────────────────

  fastify.get('/ucetnictvi/sablony-faktur', async (request, reply) => {
    const templates = await sql`
      SELECT r.*, s.name AS series_name
      FROM recurring_invoices r
      LEFT JOIN invoice_number_series s ON r.series_id = s.id
      ORDER BY r.active DESC, r.name
    `;
    const series = await sql`SELECT * FROM invoice_number_series WHERE active = TRUE ORDER BY name`;
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
