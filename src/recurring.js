// Scheduler pro opakující se faktury
// Spouštění: 1× při startu, pak každých 24 hodin

import { getDb, generateId } from './db.js';

function nextDate(current, frequency, dayOfMonth) {
  const d = new Date(current);
  switch (frequency) {
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'yearly':    d.setFullYear(d.getFullYear() + 1); break;
    default:          d.setMonth(d.getMonth() + 1); break; // monthly
  }
  d.setDate(Math.min(dayOfMonth, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d.toISOString().slice(0, 10);
}

async function runRecurring(log) {
  const sql = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const templates = await sql`
    SELECT r.*, s.prefix, s.year, s.padding, s.current_number
    FROM recurring_invoices r
    LEFT JOIN invoice_number_series s ON r.series_id = s.id
    WHERE r.active = TRUE AND r.next_run_date <= ${today}
  `;

  if (!templates.length) return;
  log?.(`[recurring] Spouštím ${templates.length} šablon(y)`);

  for (const tmpl of templates) {
    try {
      let number = '';
      if (tmpl.series_id && tmpl.prefix) {
        const [updated] = await sql`
          UPDATE invoice_number_series SET current_number = current_number + 1
          WHERE id = ${tmpl.series_id} RETURNING current_number, prefix, year, padding
        `;
        const num = String(updated.current_number).padStart(updated.padding, '0');
        const yr  = updated.year ? `-${updated.year}` : '';
        number = `${updated.prefix}${yr}-${num}`;
      }

      const issueDate = today;
      const dueDate   = new Date(Date.now() + tmpl.due_days * 86400000).toISOString().slice(0, 10);

      const items = Array.isArray(tmpl.items) ? tmpl.items : [];
      const amount    = items.reduce((s, it) => s + Number(it.amount || (Number(it.price || 0) * Number(it.quantity || 1))), 0);
      const vatAmount = items.reduce((s, it) => s + Number(it.vat_amount || ((Number(it.amount || Number(it.price || 0) * Number(it.quantity || 1))) * (Number(it.vat_rate || 0) / 100))), 0);
      const total     = amount + vatAmount;

      const invoiceId = generateId();
      await sql`
        INSERT INTO accounting_invoices
          (id, type, number, client_name, client_ico, client_dic, client_address,
           amount, vat_amount, total_amount, currency, status, issue_date, due_date)
        VALUES (
          ${invoiceId}, 'issued', ${number},
          ${tmpl.client_name}, ${tmpl.client_ico}, ${tmpl.client_dic}, ${tmpl.client_address},
          ${amount}, ${vatAmount}, ${total}, 'CZK', 'Nezaplacena', ${issueDate}, ${dueDate}
        )
      `;

      for (const it of items) {
        const qty    = Number(it.quantity || 1);
        const price  = Number(it.price || it.price_per_unit || 0);
        const vatR   = Number(it.vat_rate || 21);
        const base   = Number(it.amount || (qty * price));
        const vat    = Number(it.vat_amount || (base * vatR / 100));
        await sql`
          INSERT INTO accounting_invoice_items
            (invoice_id, name, quantity, unit, price_per_unit, vat_rate, amount, vat_amount, total)
          VALUES (${invoiceId}, ${it.name || 'Položka'}, ${qty}, ${it.unit || 'ks'}, ${price}, ${vatR}, ${base}, ${vat}, ${base + vat})
        `;
      }

      if (tmpl.send_email && tmpl.client_email) {
        try {
          const { renderInvoicePdf } = await import('./pdf.js');
          const { sendInvoiceEmail } = await import('./email.js');
          const [issuerRow] = await sql`SELECT * FROM company_settings LIMIT 1`;
          const invoice = { id: invoiceId, number, type: 'issued', client_name: tmpl.client_name, issue_date: issueDate, due_date: dueDate, amount, vat_amount: vatAmount, total_amount: total, currency: 'CZK' };
          const vatSummary = [{ rate: 21, base: amount, vat: vatAmount }];
          const pdfBuffer = await renderInvoicePdf({ invoice, items, issuer: issuerRow || {}, vatSummary });
          await sendInvoiceEmail({ invoice, issuer: issuerRow || {}, email: tmpl.client_email, pdfBuffer });
        } catch (e) {
          log?.(`[recurring] Email neposlán pro šablonu ${tmpl.id}: ${e.message}`);
        }
      }

      const nextRun = nextDate(tmpl.next_run_date, tmpl.frequency, tmpl.day_of_month);
      await sql`
        UPDATE recurring_invoices
        SET last_run_date = ${today}, next_run_date = ${nextRun}
        WHERE id = ${tmpl.id}
      `;
      log?.(`[recurring] ✓ Šablona ${tmpl.id} → faktura ${number}, příští: ${nextRun}`);
    } catch (err) {
      log?.(`[recurring] ✗ Šablona ${tmpl.id}: ${err.message}`);
    }
  }
}

export function startRecurringScheduler() {
  const log = (msg) => console.log(msg);
  const runAndSchedule = async () => {
    try { await runRecurring(log); } catch (err) { log(`[recurring] Chyba: ${err.message}`); }
    setTimeout(runAndSchedule, 24 * 60 * 60 * 1000);
  };
  // První spuštění za 30 sekund po startu
  setTimeout(runAndSchedule, 30 * 1000);
}
