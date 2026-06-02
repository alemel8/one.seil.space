import { getDb, generateId } from '../db.js';
import { parseFioCsv } from '../fio-parser.js';

// Pozn: vydané a přijaté faktury jsou v src/routes/invoices.js
// Tento soubor spravuje bankovní záznamy, manuální položky a Fio CSV import

export default async function accountingRoutes(fastify) {
  const sql = getDb();

  // Registruj multipart pro upload
  await fastify.register((await import('@fastify/multipart')).default, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });

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
             i.number AS matched_invoice_number
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

  // Párování transakce s fakturou
  fastify.post('/ucetnictvi/banka/:id/parovat', async (request, reply) => {
    const { invoice_id } = request.body || {};
    if (!invoice_id) return reply.redirect('/ucetnictvi/banka');

    await sql`
      UPDATE accounting_bank_transactions
      SET matched_invoice_id = ${invoice_id}, matched_at = NOW(), matched_by = ${request.user.id}
      WHERE id = ${request.params.id}
    `;

    // Označ fakturu jako zaplacenou
    await sql`
      UPDATE accounting_invoices
      SET status = 'Zaplacena', paid_date = CURRENT_DATE, bank_transaction_id = ${parseInt(request.params.id, 10)}, modified_at = NOW()
      WHERE id = ${invoice_id} AND status != 'Zaplacena'
    `;

    return reply.redirect('/ucetnictvi/banka');
  });

  // ── Import Fio CSV ────────────────────────────────────────────

  fastify.get('/ucetnictvi/banka/import', async (request, reply) => {
    const imports = await sql`
      SELECT i.*, a.name AS account_name, COUNT(t.id)::int AS tx_count
      FROM accounting_bank_imports i
      JOIN accounting_bank_accounts a ON i.bank_account_id = a.id
      LEFT JOIN accounting_bank_transactions t ON t.import_id = i.id
      GROUP BY i.id, a.name
      ORDER BY i.imported_at DESC LIMIT 20
    `;
    const accounts = await sql`SELECT * FROM accounting_bank_accounts WHERE active = TRUE`;
    return reply.view('pages/accounting/bank-import.ejs', {
      pageTitle: 'Import Fio CSV', currentPath: '/ucetnictvi/banka',
      user: request.user, imports, accounts,
      result: request.query.result ? JSON.parse(decodeURIComponent(request.query.result)) : null,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/banka/import', async (request, reply) => {
    let csvText = '';
    let filename = 'upload.csv';
    let bankAccountId;

    try {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'csvfile') {
          filename = part.filename;
          const chunks = [];
          for await (const chunk of part.file) chunks.push(chunk);
          csvText = Buffer.concat(chunks).toString('utf8');
        } else if (part.type === 'field' && part.fieldname === 'bank_account_id') {
          bankAccountId = parseInt(part.value, 10);
        }
      }
    } catch (err) {
      return reply.redirect('/ucetnictvi/banka/import?result=' + encodeURIComponent(JSON.stringify({ error: err.message })));
    }

    if (!csvText) return reply.redirect('/ucetnictvi/banka/import?result=' + encodeURIComponent(JSON.stringify({ error: 'Soubor nebyl nahrán' })));

    // Zajisti výchozí bankovní účet
    if (!bankAccountId) {
      const [acc] = await sql`SELECT id FROM accounting_bank_accounts WHERE active = TRUE LIMIT 1`;
      if (acc) {
        bankAccountId = acc.id;
      } else {
        const [newAcc] = await sql`
          INSERT INTO accounting_bank_accounts (name, bank_name, account_number, currency)
          VALUES ('Hlavní účet', 'Fio banka', '2800828200/2010', 'CZK') RETURNING id
        `;
        bankAccountId = newAcc.id;
      }
    }

    let parsed;
    try {
      parsed = parseFioCsv(csvText);
    } catch (err) {
      return reply.redirect('/ucetnictvi/banka/import?result=' + encodeURIComponent(JSON.stringify({ error: `Chyba parsování: ${err.message}` })));
    }

    const [importRecord] = await sql`
      INSERT INTO accounting_bank_imports
        (bank_account_id, filename, format, date_from, date_to, imported_by)
      VALUES (${bankAccountId}, ${filename}, 'fio_csv',
              ${parsed.meta.dateFrom || null}, ${parsed.meta.dateTo || null},
              ${request.user.id})
      RETURNING id
    `;
    const importId = importRecord.id;

    let imported = 0, skipped = 0, matched = 0;

    for (const rec of parsed.records) {
      // Deduplikace podle external_id
      const exists = await sql`SELECT id FROM accounting_bank_transactions WHERE external_id = ${rec.external_id} LIMIT 1`;
      if (exists[0]) { skipped++; continue; }

      // Auto-párování: variabilní symbol = číslo faktury (bez mezer, písmen)
      let matchedInvoiceId = null;
      if (rec.variable_symbol) {
        const vs = rec.variable_symbol.replace(/\s/g, '');
        const [inv] = await sql`
          SELECT id FROM accounting_invoices
          WHERE type = 'issued' AND status != 'Zaplacena'
            AND REPLACE(REPLACE(number, '-', ''), '/', '') LIKE ${'%' + vs + '%'}
          LIMIT 1
        `;
        if (inv) {
          matchedInvoiceId = inv.id;
          matched++;
        }
      }

      await sql`
        INSERT INTO accounting_bank_transactions
          (bank_account_id, import_id, external_id, type, amount, currency,
           counterparty_account, counterparty_name,
           variable_symbol, constant_symbol, specific_symbol,
           message, transaction_date, matched_invoice_id)
        VALUES (
          ${bankAccountId}, ${importId}, ${rec.external_id}, ${rec.type}, ${rec.amount}, ${rec.currency},
          ${rec.counterparty_account}, ${rec.counterparty_name},
          ${rec.variable_symbol}, ${rec.constant_symbol}, ${rec.specific_symbol},
          ${rec.message}, ${rec.transaction_date}, ${matchedInvoiceId}
        )
      `;

      // Automaticky označ spárované faktury jako zaplacené
      if (matchedInvoiceId) {
        await sql`
          UPDATE accounting_invoices
          SET status = 'Zaplacena', paid_date = ${rec.transaction_date}, modified_at = NOW()
          WHERE id = ${matchedInvoiceId} AND status != 'Zaplacena'
        `;
      }

      imported++;
    }

    // Aktualizuj statistiku importu
    await sql`
      UPDATE accounting_bank_imports
      SET rows_imported = ${imported}, rows_skipped = ${skipped}, rows_matched = ${matched}
      WHERE id = ${importId}
    `;

    const result = { imported, skipped, matched, total: parsed.records.length };
    return reply.redirect('/ucetnictvi/banka/import?result=' + encodeURIComponent(JSON.stringify(result)));
  });

  // Zrušení párování
  fastify.post('/ucetnictvi/banka/:id/zrusit-parovani', async (request, reply) => {
    const [tx] = await sql`SELECT matched_invoice_id FROM accounting_bank_transactions WHERE id = ${request.params.id}`;
    if (tx?.matched_invoice_id) {
      await sql`UPDATE accounting_invoices SET bank_transaction_id = NULL, modified_at = NOW() WHERE id = ${tx.matched_invoice_id}`;
    }
    await sql`UPDATE accounting_bank_transactions SET matched_invoice_id = NULL, matched_at = NULL, matched_by = NULL WHERE id = ${request.params.id}`;
    return reply.redirect('/ucetnictvi/banka');
  });
}
