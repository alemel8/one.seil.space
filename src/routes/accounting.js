import { getDb, generateId } from '../db.js';

// Pozn: vydané a přijaté faktury jsou v src/routes/invoices.js
// Tento soubor spravuje bankovní záznamy, manuální položky a Fio CSV import

export default async function accountingRoutes(fastify) {
  const sql = getDb();

  // ── Banka ──────────────────────────────────────────────────

  fastify.get('/ucetnictvi/banka', async (request, reply) => {
    const accounts = await sql`SELECT id FROM accounting_bank_accounts WHERE active = TRUE LIMIT 1`;
    let defaultAccountId = accounts[0]?.id;
    if (!defaultAccountId) {
      const [acc] = await sql`
        INSERT INTO accounting_bank_accounts (name, bank_name, account_number, currency)
        VALUES ('Hlavní účet', 'Fio banka', '2800828200/2010', 'CZK') RETURNING id
      `;
      defaultAccountId = acc.id;
    }

    const q        = (request.query.q    || '').trim();
    const typeFilter = (request.query.type || '').trim();
    const page    = Math.max(1, parseInt(request.query.page || '1', 10));
    const perPage = 50;
    const offset  = (page - 1) * perPage;

    const conditions = [sql`t.bank_account_id = ${defaultAccountId}`];
    if (q) conditions.push(sql`(t.counterparty_name ILIKE ${'%'+q+'%'} OR t.message ILIKE ${'%'+q+'%'} OR t.variable_symbol ILIKE ${'%'+q+'%'})`);
    if (typeFilter) conditions.push(sql`t.type = ${typeFilter}`);
    const where = sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM accounting_bank_transactions t ${where}`;
    const transactions = await sql`
      SELECT t.*,
             i.number AS matched_invoice_number,
             i.type   AS matched_invoice_type
      FROM accounting_bank_transactions t
      LEFT JOIN accounting_invoices i ON t.matched_invoice_id = i.id
      ${where}
      ORDER BY t.transaction_date DESC, t.id DESC
      LIMIT ${perPage} OFFSET ${offset}
    `;

    return reply.view('pages/accounting/bank.ejs', {
      pageTitle: 'Banka', currentPath: '/ucetnictvi/banka',
      user: request.user, transactions, total: count,
      currentPage: page, totalPages: Math.ceil(count / perPage),
      q, typeFilter,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/banka/vytvorit', async (request, reply) => {
    const b = request.body || {};
    const accounts = await sql`SELECT id FROM accounting_bank_accounts WHERE active = TRUE LIMIT 1`;
    let bankAccountId = accounts[0]?.id;
    if (!bankAccountId) {
      const [acc] = await sql`
        INSERT INTO accounting_bank_accounts (name, bank_name, account_number, currency)
        VALUES ('Hlavní účet', 'Fio banka', '2800828200/2010', 'CZK') RETURNING id
      `;
      bankAccountId = acc.id;
    }

    const amount = parseFloat(b.amount || 0);
    const type = (b.type === 'debit' || amount < 0) ? 'debit' : 'credit';

    await sql`
      INSERT INTO accounting_bank_transactions
        (bank_account_id, type, amount, currency, message, counterparty_name,
         variable_symbol, transaction_date, notes)
      VALUES (
        ${bankAccountId}, ${type}, ${Math.abs(amount)},
        ${b.currency || 'CZK'}, ${b.description || ''},
        ${b.counterparty || ''},
        ${b.variable_symbol || ''},
        ${b.date || new Date().toISOString().split('T')[0]},
        ${b.notes || ''}
      )
    `;
    return reply.redirect('/ucetnictvi/banka');
  });

  // Párování transakce s fakturou nebo účtenkou
  fastify.post('/ucetnictvi/banka/:id/parovat', async (request, reply) => {
    const { document_type, document_id, invoice_id } = request.body || {};
    const txId = parseInt(request.params.id, 10);

    // Backward-compat: starý formulář posílá invoice_id
    const docType = document_type || 'invoice';
    const docId   = document_id   || invoice_id;
    if (!docId) return reply.redirect('/ucetnictvi/banka');

    if (docType === 'receipt') {
      await sql`
        UPDATE accounting_bank_transactions
        SET matched_receipt_id = ${parseInt(docId, 10)}, matched_invoice_id = NULL,
            matched_at = NOW(), matched_by = ${request.user.id}
        WHERE id = ${txId}
      `;
      await sql`
        UPDATE receipts
        SET status = 'Zaúčtována', bank_tx_id = ${txId}, updated_at = NOW()
        WHERE id = ${parseInt(docId, 10)}
      `;
    } else {
      await sql`
        UPDATE accounting_bank_transactions
        SET matched_invoice_id = ${docId}, matched_receipt_id = NULL,
            matched_at = NOW(), matched_by = ${request.user.id}
        WHERE id = ${txId}
      `;
      await sql`
        UPDATE accounting_invoices
        SET status = 'Zaplacena', paid_date = CURRENT_DATE,
            bank_transaction_id = ${txId}, modified_at = NOW()
        WHERE id = ${docId} AND status != 'Zaplacena'
      `;
    }
    return reply.redirect('/ucetnictvi/banka');
  });

  // ── Webhook: příjem transakce z Make (Fio) ───────────────────
  //
  // POST /api/webhook/banka
  // Header: x-api-key: <BANK_WEBHOOK_SECRET>
  // Body (JSON, jedno pole nebo pole transakcí):
  // {
  //   "external_id": "12345678",
  //   "transaction_date": "2024-01-15",   // nebo "date"
  //   "amount": 1500.00,                   // kladné = příjem, záporné = výdaj
  //   "currency": "CZK",
  //   "counterparty_account": "1234567890/0800",
  //   "counterparty_name": "Firma s.r.o.",
  //   "variable_symbol": "20240001",
  //   "constant_symbol": "0308",
  //   "specific_symbol": "",
  //   "message": "Platba faktury"
  // }

  fastify.post('/api/webhook/banka', async (request, reply) => {
    const secret = process.env.BANK_WEBHOOK_SECRET;
    if (!secret || request.headers['x-api-key'] !== secret) {
      return reply.status(401).send({ ok: false, error: 'Unauthorized' });
    }

    const accounts = await sql`SELECT id FROM accounting_bank_accounts WHERE active = TRUE LIMIT 1`;
    let bankAccountId = accounts[0]?.id;
    if (!bankAccountId) {
      const [acc] = await sql`
        INSERT INTO accounting_bank_accounts (name, bank_name, account_number, currency)
        VALUES ('Hlavní účet', 'Fio banka', '2800828200/2010', 'CZK') RETURNING id
      `;
      bankAccountId = acc.id;
    }

    const body = request.body;
    const items = Array.isArray(body) ? body : [body];

    let imported = 0, skipped = 0, matched = 0;

    for (const rec of items) {
      const externalId = rec.external_id ?? rec.transactionId ?? rec.id ?? null;

      if (externalId) {
        const exists = await sql`SELECT id FROM accounting_bank_transactions WHERE external_id = ${String(externalId)} LIMIT 1`;
        if (exists[0]) { skipped++; continue; }
      }

      const rawAmount  = parseFloat(rec.amount ?? 0);
      const type       = rawAmount < 0 ? 'debit' : 'credit';
      const amount     = Math.abs(rawAmount);
      const currency   = rec.currency || 'CZK';
      const txDate     = rec.transaction_date || rec.date || new Date().toISOString().split('T')[0];
      const vs         = rec.variable_symbol || rec.variableSymbol || '';
      const ks         = rec.constant_symbol  || rec.constantSymbol  || '';
      const ss         = rec.specific_symbol  || rec.specificSymbol  || '';
      const msg        = rec.message          || rec.userDescription || rec.description || '';
      const cpAccount  = rec.counterparty_account || rec.counterpartyAccountNumber || '';
      const cpName     = rec.counterparty_name    || rec.counterpartyName    || '';

      // Auto-párování: variabilní symbol = číslo faktury
      let matchedInvoiceId = null;
      if (vs) {
        const vsClean = vs.replace(/\s/g, '');
        const [inv] = await sql`
          SELECT id FROM accounting_invoices
          WHERE type IN ('issued', 'proforma') AND status != 'Zaplacena'
            AND REPLACE(REPLACE(number, '-', ''), '/', '') LIKE ${'%' + vsClean + '%'}
          LIMIT 1
        `;
        if (inv) {
          matchedInvoiceId = inv.id;
          matched++;
        }
      }

      await sql`
        INSERT INTO accounting_bank_transactions
          (bank_account_id, external_id, type, amount, currency,
           counterparty_account, counterparty_name,
           variable_symbol, constant_symbol, specific_symbol,
           message, transaction_date, matched_invoice_id)
        VALUES (
          ${bankAccountId}, ${externalId ? String(externalId) : null},
          ${type}, ${amount}, ${currency},
          ${cpAccount}, ${cpName},
          ${vs}, ${ks}, ${ss},
          ${msg}, ${txDate}, ${matchedInvoiceId}
        )
      `;

      if (matchedInvoiceId) {
        await sql`
          UPDATE accounting_invoices
          SET status = 'Zaplacena', paid_date = ${txDate}, modified_at = NOW()
          WHERE id = ${matchedInvoiceId} AND status != 'Zaplacena'
        `;
      }

      imported++;
    }

    return reply.send({ ok: true, imported, skipped, matched });
  });

  // Zrušení párování (faktura nebo účtenka)
  fastify.post('/ucetnictvi/banka/:id/zrusit-parovani', async (request, reply) => {
    const [tx] = await sql`
      SELECT matched_invoice_id, matched_receipt_id
      FROM accounting_bank_transactions WHERE id = ${request.params.id}
    `;
    if (tx?.matched_invoice_id) {
      await sql`UPDATE accounting_invoices SET bank_transaction_id = NULL, modified_at = NOW() WHERE id = ${tx.matched_invoice_id}`;
    }
    if (tx?.matched_receipt_id) {
      await sql`UPDATE receipts SET bank_tx_id = NULL, updated_at = NOW() WHERE id = ${tx.matched_receipt_id}`;
    }
    await sql`
      UPDATE accounting_bank_transactions
      SET matched_invoice_id = NULL, matched_receipt_id = NULL, matched_at = NULL, matched_by = NULL
      WHERE id = ${request.params.id}
    `;
    return reply.redirect('/ucetnictvi/banka');
  });

  // ── API: Vyhledávání dokladů pro párování ────────────────────
  fastify.get('/api/banka/doklady', async (request, reply) => {
    const q    = (request.query.q    || '').trim();
    const type = (request.query.type || 'invoice');
    const like = `%${q}%`;

    if (type === 'receipt') {
      const rows = await sql`
        SELECT id::text, number, vendor AS name, total_amount, currency, receipt_date AS date, 'receipt' AS doc_type
        FROM receipts
        WHERE bank_tx_id IS NULL AND status != 'Storno'
          AND (${q} = '' OR vendor ILIKE ${like} OR number ILIKE ${like})
        ORDER BY receipt_date DESC LIMIT 20
      `;
      return reply.send(rows);
    }

    const rows = await sql`
      SELECT id, number, COALESCE(client_name, supplier, '') AS name,
             total_amount, currency, issue_date AS date, type AS doc_type
      FROM accounting_invoices
      WHERE bank_transaction_id IS NULL AND status NOT IN ('Zaplacena', 'Storno')
        AND (${q} = '' OR number ILIKE ${like} OR client_name ILIKE ${like} OR supplier ILIKE ${like})
      ORDER BY issue_date DESC LIMIT 20
    `;
    return reply.send(rows);
  });

  // ── API: Cash flow (12 měsíců) ───────────────────────────────
  fastify.get('/api/cashflow', async (request, reply) => {
    const months = Math.max(1, Math.min(24, parseInt(request.query.months || '12', 10)));
    const since  = new Date();
    since.setMonth(since.getMonth() - months + 1);
    since.setDate(1);
    const sinceStr = since.toISOString().slice(0, 10);

    const invoiceRows = await sql`
      SELECT
        TO_CHAR(DATE_TRUNC('month', issue_date), 'YYYY-MM') AS month,
        type,
        COALESCE(SUM(total_amount), 0)::numeric AS v
      FROM accounting_invoices
      WHERE issue_date >= ${sinceStr}
      GROUP BY 1, 2
    `;

    const receiptRows = await sql`
      SELECT
        TO_CHAR(DATE_TRUNC('month', receipt_date), 'YYYY-MM') AS month,
        COALESCE(SUM(total_amount), 0)::numeric AS v
      FROM receipts
      WHERE receipt_date >= ${sinceStr}
      GROUP BY 1
    `;

    // Agregovat do mapy
    const map = {};
    for (const r of invoiceRows) {
      if (!map[r.month]) map[r.month] = { month: r.month, income: 0, expense: 0 };
      if (r.type === 'issued')   map[r.month].income  += Number(r.v);
      if (r.type === 'received') map[r.month].expense += Number(r.v);
    }
    for (const r of receiptRows) {
      if (!map[r.month]) map[r.month] = { month: r.month, income: 0, expense: 0 };
      map[r.month].expense += Number(r.v);
    }

    const result = Object.values(map).sort((a, b) => a.month.localeCompare(b.month));
    return reply.send(result);
  });

  // ── Finanční přehled (KPI) ─────────────────────────────────
  fastify.get('/ucetnictvi/prehled', async (request, reply) => {
    const now   = new Date();
    const year  = parseInt(request.query.rok  || now.getFullYear(),  10);
    const month = parseInt(request.query.mesic || (now.getMonth() + 1), 10);

    const mStart = `${year}-${String(month).padStart(2,'0')}-01`;
    const mEnd   = new Date(year, month, 0).toISOString().slice(0, 10);
    const yStart = `${year}-01-01`;
    const yEnd   = `${year}-12-31`;

    // Měsíc
    const [mIssued]   = await sql`SELECT COALESCE(SUM(total_amount),0)::numeric AS v FROM accounting_invoices WHERE type='issued'   AND issue_date BETWEEN ${mStart} AND ${mEnd}`;
    const [mReceived] = await sql`SELECT COALESCE(SUM(total_amount),0)::numeric AS v FROM accounting_invoices WHERE type='received' AND issue_date BETWEEN ${mStart} AND ${mEnd}`;
    const [mVatOut]   = await sql`SELECT COALESCE(SUM(vat_amount),0)::numeric   AS v FROM accounting_invoices WHERE type='issued'   AND issue_date BETWEEN ${mStart} AND ${mEnd}`;
    const [mVatIn]    = await sql`SELECT COALESCE(SUM(vat_amount),0)::numeric   AS v FROM accounting_invoices WHERE type='received' AND issue_date BETWEEN ${mStart} AND ${mEnd}`;

    // Rok
    const [yIssued]   = await sql`SELECT COALESCE(SUM(total_amount),0)::numeric AS v FROM accounting_invoices WHERE type='issued'   AND issue_date BETWEEN ${yStart} AND ${yEnd}`;
    const [yReceived] = await sql`SELECT COALESCE(SUM(total_amount),0)::numeric AS v FROM accounting_invoices WHERE type='received' AND issue_date BETWEEN ${yStart} AND ${yEnd}`;
    const [yVatOut]   = await sql`SELECT COALESCE(SUM(vat_amount),0)::numeric   AS v FROM accounting_invoices WHERE type='issued'   AND issue_date BETWEEN ${yStart} AND ${yEnd}`;
    const [yVatIn]    = await sql`SELECT COALESCE(SUM(vat_amount),0)::numeric   AS v FROM accounting_invoices WHERE type='received' AND issue_date BETWEEN ${yStart} AND ${yEnd}`;

    // Nezaplacené faktury
    const overdueIssued   = await sql`SELECT id, number, client_name, total_amount, currency, due_date FROM accounting_invoices WHERE type='issued'   AND status='Po splatnosti' ORDER BY due_date`;
    const overdueReceived = await sql`SELECT id, number, supplier,    total_amount, currency, due_date FROM accounting_invoices WHERE type='received' AND status='Po splatnosti' ORDER BY due_date`;
    const pendingIssued   = await sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount),0)::numeric AS v FROM accounting_invoices WHERE type='issued'   AND status='Nezaplacena'`;
    const pendingReceived = await sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount),0)::numeric AS v FROM accounting_invoices WHERE type='received' AND status='Nezaplacena'`;

    // Graf — měsíce roku
    const monthlyChart = await sql`
      SELECT
        EXTRACT(MONTH FROM issue_date)::int AS m,
        type,
        COALESCE(SUM(total_amount),0)::numeric AS v
      FROM accounting_invoices
      WHERE issue_date BETWEEN ${yStart} AND ${yEnd}
      GROUP BY m, type ORDER BY m
    `;

    // Cashflow banka (typy: credit/debit)
    const [cashIn]  = await sql`SELECT COALESCE(SUM(amount),0)::numeric AS v FROM accounting_bank_transactions WHERE type='credit'`;
    const [cashOut] = await sql`SELECT COALESCE(SUM(amount),0)::numeric AS v FROM accounting_bank_transactions WHERE type='debit'`;

    return reply.view('pages/accounting/prehled.ejs', {
      pageTitle: 'Finanční přehled', currentPath: '/ucetnictvi/prehled',
      user: request.user, year, month,
      kpi: {
        month: { issued: Number(mIssued.v), received: Number(mReceived.v), vatOut: Number(mVatOut.v), vatIn: Number(mVatIn.v) },
        year:  { issued: Number(yIssued.v), received: Number(yReceived.v), vatOut: Number(yVatOut.v), vatIn: Number(yVatIn.v) },
      },
      overdue: { issued: overdueIssued, received: overdueReceived },
      pending: { issued: pendingIssued[0], received: pendingReceived[0] },
      monthlyChart,
      cash: { in: Number(cashIn.v), out: Number(cashOut.v) },
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Export objednávek CSV ─────────────────────────────────
  fastify.get('/ucetnictvi/objednavky/export.csv', async (request, reply) => {
    const orders = await sql`
      SELECT o.*, s.name AS shop_name
      FROM shop_orders o LEFT JOIN shops s ON o.shop_id = s.id
      ORDER BY o.created_at DESC
    `;
    const header = 'Číslo;Eshop;Zákazník;Email;Telefon;Celkem;Měna;Stav;Datum';
    const rows = orders.map(o => [
      o.order_number, o.shop_name||'', o.customer_name||'', o.customer_email||'', o.customer_phone||'',
      String(o.total_amount||0).replace('.',','), o.currency||'CZK', o.status,
      o.created_at?.toISOString?.()?.slice(0,10) || '',
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(';')).join('\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="objednavky.csv"');
    return reply.send('﻿' + header + '\n' + rows);
  });
}
