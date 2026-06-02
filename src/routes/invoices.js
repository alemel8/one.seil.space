import { getDb, generateId } from '../db.js';
import { renderInvoicePdf } from '../pdf.js';
import { sendInvoiceEmail } from '../email.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const PDFS_DIR = path.join(projectRoot, 'data/pdfs');

const STATUSES_ISSUED   = ['Nezaplacena', 'Zaplacena', 'Po splatnosti', 'Storno'];
const STATUSES_RECEIVED = ['Nezaplacena', 'Zaplacena', 'Po splatnosti', 'Storno'];

// ── Načtení nastavení firmy (issuer) ─────────────────────────

async function getIssuer(sql) {
  const [company] = await sql`SELECT * FROM company_settings LIMIT 1`;
  return company || {};
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

// ── Generování čísla z číselné řady ──────────────────────────

async function nextInvoiceNumber(sql, seriesId) {
  const [series] = await sql`
    UPDATE invoice_number_series SET current_number = current_number + 1
    WHERE id = ${seriesId} AND active = TRUE RETURNING *
  `;
  if (!series) throw new Error('Číselná řada nenalezena nebo není aktivní');
  const num = String(series.current_number).padStart(series.padding, '0');
  const yearPart = series.year ? `-${series.year}` : '';
  return `${series.prefix}${yearPart}-${num}`;
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
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.get('/ucetnictvi/vydane-faktury/:id', async (request, reply) => {
    const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${request.params.id} AND type = 'issued'`;
    if (!invoice) return reply.code(404).send('Faktura nenalezena');
    const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${invoice.id} ORDER BY id`;
    const vatSummary = calcVatSummary(items);
    return reply.view('pages/invoices/issued-detail.ejs', {
      pageTitle: `Faktura ${invoice.number}`, currentPath: '/ucetnictvi/vydane-faktury',
      user: request.user, invoice, items, vatSummary, STATUSES_ISSUED,
    }, { layout: 'layouts/base.ejs' });
  });

  // Vytvořit vydanou fakturu manuálně
  fastify.post('/ucetnictvi/vydane-faktury/vytvorit', async (request, reply) => {
    const b = request.body || {};
    const id = generateId();

    let number = b.number || '';
    if (!number && b.series_id) {
      number = await nextInvoiceNumber(sql, parseInt(b.series_id, 10));
    }
    if (!number) number = `FV-${new Date().getFullYear()}-${Date.now()}`;

    const amount    = parseFloat(b.amount    || 0);
    const vatAmount = parseFloat(b.vat_amount || 0);
    const total     = amount + vatAmount;

    await sql`
      INSERT INTO accounting_invoices
        (id, type, series_id, number, status, client_name, client_ico, client_dic, client_address,
         amount, vat_amount, total_amount, currency, issue_date, due_date, notes)
      VALUES (
        ${id}, 'issued',
        ${b.series_id ? parseInt(b.series_id, 10) : null},
        ${number}, ${b.status || 'Nezaplacena'},
        ${(b.client_name||'').trim()}, ${(b.client_ico||'').trim()},
        ${(b.client_dic||'').trim()}, ${(b.client_address||'').trim()},
        ${amount}, ${vatAmount}, ${total},
        ${b.currency || 'CZK'},
        ${b.issue_date || new Date().toISOString().split('T')[0]},
        ${b.due_date || null},
        ${(b.notes||'').trim()}
      )
    `;
    return reply.redirect(`/ucetnictvi/vydane-faktury/${id}`);
  });

  // Auto-generace faktury z objednávky
  fastify.post('/ucetnictvi/objednavky/:id/generovat-fakturu', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const b = request.body || {};

    const [order] = await sql`SELECT * FROM shop_orders WHERE id = ${request.params.id}`;
    if (!order) return reply.code(404).send('Objednávka nenalezena');

    // Zkontroluj, jestli už faktura existuje
    const [existing] = await sql`SELECT id FROM accounting_invoices WHERE order_id = ${order.id} LIMIT 1`;
    if (existing) return reply.redirect(`/ucetnictvi/vydane-faktury/${existing.id}`);

    const orderItems = await sql`SELECT * FROM shop_order_items WHERE order_id = ${order.id}`;
    const issuer = await getIssuer(sql);

    // Číslo faktury
    let number = order.invoice_number || '';
    if (!number && b.series_id) {
      number = await nextInvoiceNumber(sql, parseInt(b.series_id, 10));
    }
    if (!number) number = order.invoice_number || `FV-${new Date().getFullYear()}-${order.order_number}`;

    // Výpočet DPH (21% default pro eshop objednávky)
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
        ${invoiceId}, 'issued',
        ${b.series_id ? parseInt(b.series_id, 10) : null},
        ${number}, 'Nezaplacena',
        ${order.shop_id}, ${order.id},
        ${order.crm_contact_id || null}, ${order.crm_company_id || null},
        ${`${order.first_name} ${order.last_name}`.trim() || order.company || ''},
        ${order.ic || ''}, ${order.dic || ''},
        ${[order.address, order.zip + ' ' + order.city].filter(Boolean).join(', ')},
        ${base}, ${vatAmt}, ${totalWithVat},
        ${order.currency || 'CZK'},
        ${new Date().toISOString().split('T')[0]},
        ${b.due_date || null}
      )
    `;

    // Položky
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

    return reply.redirect(`/ucetnictvi/vydane-faktury/${invoiceId}`);
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
    const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${request.params.id} AND type = 'issued'`;
    if (!invoice) return reply.code(404).send('Faktura nenalezena');

    const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${invoice.id} ORDER BY id`;
    const issuer = await getIssuer(sql);
    const vatSummary = calcVatSummary(items);

    const pdfBuffer = await renderInvoicePdf({ invoice, items, issuer, vatSummary });

    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename="faktura-${invoice.number}.pdf"`);
    return reply.send(pdfBuffer);
  });

  // Odeslat fakturu emailem
  fastify.post('/ucetnictvi/vydane-faktury/:id/odeslat-email', async (request, reply) => {
    const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${request.params.id} AND type = 'issued'`;
    if (!invoice) return reply.code(404).send('Faktura nenalezena');

    const { email } = request.body || {};
    if (!email) return reply.redirect(`/ucetnictvi/vydane-faktury/${invoice.id}?error=noemail`);

    const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${invoice.id} ORDER BY id`;
    const issuer = await getIssuer(sql);
    const vatSummary = calcVatSummary(items);

    try {
      const pdfBuffer = await renderInvoicePdf({ invoice, items, issuer, vatSummary });
      await sendInvoiceEmail({ invoice, issuer, email, pdfBuffer });
      return reply.redirect(`/ucetnictvi/vydane-faktury/${invoice.id}?emailSent=1`);
    } catch (err) {
      fastify.log.error({ err }, 'Chyba odeslání faktury emailem');
      return reply.redirect(`/ucetnictvi/vydane-faktury/${invoice.id}?emailError=1`);
    }
  });

  // ══════════════════════════════════════════════════════════
  // PŘIJATÉ FAKTURY
  // ══════════════════════════════════════════════════════════

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

    return reply.view('pages/invoices/received.ejs', {
      pageTitle: 'Přijaté faktury', currentPath: '/ucetnictvi/prijate-faktury',
      user: request.user, invoices, total: count,
      currentPage: page, totalPages: Math.ceil(count / perPage),
      q, statusFilter, STATUSES_RECEIVED,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/prijate-faktury/vytvorit', async (request, reply) => {
    const b = request.body || {};
    const amount = parseFloat(b.amount || 0);
    await sql`
      INSERT INTO accounting_invoices
        (id, type, number, supplier, amount, vat_amount, total_amount, currency, status, issue_date, due_date, notes)
      VALUES (
        ${generateId()}, 'received',
        ${b.number || ''}, ${(b.supplier||'').trim()},
        ${amount}, ${parseFloat(b.vat_amount || 0)},
        ${amount + parseFloat(b.vat_amount || 0)},
        ${b.currency || 'CZK'}, ${b.status || 'Nezaplacena'},
        ${b.issue_date || new Date().toISOString().split('T')[0]},
        ${b.due_date || null}, ${(b.notes||'').trim()}
      )
    `;
    return reply.redirect('/ucetnictvi/prijate-faktury');
  });

  fastify.post('/ucetnictvi/prijate-faktury/:id/stav', async (request, reply) => {
    const { status } = request.body || {};
    if (!STATUSES_RECEIVED.includes(status)) return reply.code(400).send('Neplatný stav');
    const updates = [sql`status = ${status}`, sql`modified_at = NOW()`];
    if (status === 'Zaplacena') updates.push(sql`paid_date = CURRENT_DATE`);
    await sql`UPDATE accounting_invoices SET ${updates.reduce((a, b) => sql`${a}, ${b}`)} WHERE id = ${request.params.id}`;
    return reply.redirect('/ucetnictvi/prijate-faktury');
  });
}
