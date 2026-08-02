// Funkční test vydaných faktur — vytvoření, PDF, odeslání, upomínky.
//
// Testy jedou proti běžícímu serveru a reálné databázi z .env; přihlášení
// obchází vložením session přímo do DB (stejný podpis cookie jako @fastify/cookie).
// Všechna vytvořená data se na konci mažou.
//
//   npm test
//   TEST_BASE_URL=http://127.0.0.1:3100 npm test

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';

const BASE   = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.SESSION_SECRET || 'one-seil-space-secret-change-in-production-32chars';

let sql, cookie, sid, userId;
const createdInvoices = [];

function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    for (const one of Array.isArray(v) ? v : [v]) p.append(k, one);
  }
  return p;
}

const get  = p => fetch(BASE + p, { headers: { cookie }, redirect: 'manual' });
const post = (p, body) => fetch(BASE + p, {
  method: 'POST', redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: form(body),
});

/** Vytvoří fakturu a vrátí její id z redirectu. */
async function createInvoice(fields) {
  const res = await post('/ucetnictvi/vydane-faktury/vytvorit', fields);
  const loc = res.headers.get('location') || '';
  const id = loc.includes('/vydane-faktury/') && !loc.includes('formError')
    ? loc.split('/').pop() : null;
  if (id) createdInvoices.push(id);
  return { res, loc, id };
}

const baseFields = {
  client_name: 'TEST Klient s.r.o.',
  client_ico: '12345678',
  client_email: 'test@example.invalid',
  item_name: 'Testovací služba',
  item_qty: '2',
  item_unit: 'hod',
  item_price: '500',
  item_vat: '21',
  issue_date: '2026-08-02',
  due_date: '2026-08-16',
};

before(async () => {
  sql = postgres(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === 'true', max: 3 });

  const [user] = await sql`SELECT id FROM users WHERE is_active = TRUE ORDER BY id LIMIT 1`;
  assert.ok(user, 'v databázi musí být aspoň jeden aktivní uživatel');
  userId = user.id;

  sid = 'test' + crypto.randomBytes(12).toString('hex');
  const sig = crypto.createHmac('sha256', SECRET).update(sid).digest('base64').replace(/=/g, '');
  cookie = `sessionId=${sid}.${sig}`;

  await sql`
    INSERT INTO session (sid, sess, expire) VALUES (
      ${sid},
      ${{ cookie: { originalMaxAge: 28800000, httpOnly: true, path: '/', sameSite: 'lax', secure: false }, userId }},
      ${new Date(Date.now() + 3600_000)}
    )
  `;

  const health = await fetch(BASE + '/health').catch(() => null);
  assert.ok(health?.ok, `server neběží na ${BASE} — spusť npm start`);
});

after(async () => {
  if (createdInvoices.length) {
    await sql`DELETE FROM accounting_invoices WHERE id = ANY(${createdInvoices})`;
  }
  await sql`DELETE FROM session WHERE sid = ${sid}`;
  await sql.end();
});

describe('vytvoření vydané faktury', () => {
  test('uloží fakturu i s položkami a spočítá částky z řádků', async () => {
    const { res, id } = await createInvoice(baseFields);
    assert.equal(res.status, 302);
    assert.ok(id, 'faktura se měla vytvořit');

    const [inv] = await sql`SELECT * FROM accounting_invoices WHERE id = ${id}`;
    assert.equal(inv.type, 'issued');
    assert.equal(Number(inv.amount), 1000);        // 2 × 500
    assert.equal(Number(inv.vat_amount), 210);     // 21 %
    assert.equal(Number(inv.total_amount), 1210);
    assert.equal(inv.client_email, 'test@example.invalid');

    const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${id}`;
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'Testovací služba');
    assert.equal(Number(items[0].total), 1210);
  });

  test('sečte víc položek s různými sazbami DPH', async () => {
    const { id } = await createInvoice({
      ...baseFields,
      item_name:  ['Služba 21 %', 'Zboží 12 %'],
      item_qty:   ['1', '1'],
      item_unit:  ['ks', 'ks'],
      item_price: ['1000', '100'],
      item_vat:   ['21', '12'],
    });
    assert.ok(id);

    const [inv] = await sql`SELECT * FROM accounting_invoices WHERE id = ${id}`;
    assert.equal(Number(inv.amount), 1100);
    assert.equal(Number(inv.vat_amount), 222);     // 210 + 12
    assert.equal(Number(inv.total_amount), 1322);
    assert.equal((await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${id}`).length, 2);
  });

  test('odmítne fakturu bez klienta', async () => {
    const { loc, id } = await createInvoice({ ...baseFields, client_name: '' });
    assert.equal(id, null);
    assert.match(loc, /formError=klient/);
  });

  test('odmítne fakturu bez položek', async () => {
    const { loc, id } = await createInvoice({ ...baseFields, item_name: '' });
    assert.equal(id, null);
    assert.match(loc, /formError=polozky/);
  });

  test('odmítne duplicitní číslo faktury', async () => {
    const number = `TEST-${Date.now()}`;
    const first = await createInvoice({ ...baseFields, number });
    assert.ok(first.id);

    const second = await createInvoice({ ...baseFields, number });
    assert.equal(second.id, null);
    assert.match(second.loc, /formError=duplicita/);

    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM accounting_invoices WHERE number = ${number}`;
    assert.equal(n, 1);
  });
});

describe('úprava faktury', () => {
  test('přepíše položky i součty', async () => {
    const { id } = await createInvoice(baseFields);
    assert.ok(id);

    const res = await post(`/ucetnictvi/vydane-faktury/${id}/upravit`, {
      client_name: 'TEST Klient upravený',
      item_name: 'Nová položka', item_qty: '3', item_unit: 'ks',
      item_price: '100', item_vat: '21',
      issue_date: '2026-08-02', due_date: '2026-08-20',
    });
    assert.equal(res.status, 302);

    const [inv] = await sql`SELECT * FROM accounting_invoices WHERE id = ${id}`;
    assert.equal(inv.client_name, 'TEST Klient upravený');
    assert.equal(Number(inv.total_amount), 363);   // 300 + 63

    const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${id}`;
    assert.equal(items.length, 1, 'staré položky se mají nahradit, ne přidat');
    assert.equal(items[0].name, 'Nová položka');
  });
});

describe('PDF', () => {
  test('vygeneruje platné PDF', async () => {
    const { id } = await createInvoice(baseFields);
    const res = await get(`/ucetnictvi/vydane-faktury/${id}/pdf`);
    assert.equal(res.status, 200);

    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString(), '%PDF');
    assert.ok(buf.length > 10_000, 'PDF vypadá podezřele malé');
  });
});

describe('variabilní symbol', () => {
  test('nikdy nepřesáhne 10 číslic', async () => {
    const { invoiceVs } = await import('../src/series-format.js');
    assert.equal(invoiceVs('21260013'), '21260013');
    assert.equal(invoiceVs('FV-2026-3'), '20263');
    assert.equal(invoiceVs('ZF-2026-260642121').length, 10);
    assert.equal(invoiceVs(`FV-2026-${Date.now()}`).length, 10);
    assert.equal(invoiceVs(''), '');
  });
});

describe('upomínky', () => {
  test('worker přepne prošlou fakturu na Po splatnosti a založí upomínku', async () => {
    const { id } = await createInvoice({
      ...baseFields,
      issue_date: '2026-01-01',
      due_date: '2026-01-15',       // dávno po splatnosti
    });
    assert.ok(id);
    assert.equal((await sql`SELECT status FROM accounting_invoices WHERE id = ${id}`)[0].status, 'Nezaplacena');

    const { markOverdueInvoices, prepareReminders } = await import('../src/healthcheck-worker.js');
    await markOverdueInvoices();
    await prepareReminders();

    const [inv] = await sql`SELECT status FROM accounting_invoices WHERE id = ${id}`;
    assert.equal(inv.status, 'Po splatnosti');

    const reminders = await sql`SELECT * FROM invoice_reminders WHERE invoice_id = ${id}`;
    assert.equal(reminders.length, 1, 'má vzniknout jen nejvyšší dosažený stupeň');
    assert.equal(reminders[0].status, 'ceka');
    assert.equal(reminders[0].level, 3);
    assert.ok(reminders[0].days_overdue > 30);
  });

  test('opakované spuštění workeru upomínku nezduplikuje', async () => {
    const { prepareReminders } = await import('../src/healthcheck-worker.js');
    const before = (await sql`SELECT COUNT(*)::int AS n FROM invoice_reminders`)[0].n;
    await prepareReminders();
    const after = (await sql`SELECT COUNT(*)::int AS n FROM invoice_reminders`)[0].n;
    assert.equal(after, before);
  });

  test('seznam upomínek se zobrazí', async () => {
    const res = await get('/ucetnictvi/upominky');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Upomínky/);
  });

  test('zrušení upomínky ji vyřadí z fronty', async () => {
    const { id } = await createInvoice({ ...baseFields, issue_date: '2026-01-01', due_date: '2026-01-10' });
    const { markOverdueInvoices, prepareReminders } = await import('../src/healthcheck-worker.js');
    await markOverdueInvoices();
    await prepareReminders();

    const [rem] = await sql`SELECT * FROM invoice_reminders WHERE invoice_id = ${id}`;
    assert.ok(rem, 'upomínka měla vzniknout');

    const res = await post(`/ucetnictvi/upominky/${rem.id}/zrusit`, {});
    assert.equal(res.status, 302);
    assert.equal((await sql`SELECT status FROM invoice_reminders WHERE id = ${rem.id}`)[0].status, 'zrusena');
  });
});

describe('odeslání e-mailem', () => {
  test('bez adresy skončí chybou a nic neodešle', async () => {
    const { id } = await createInvoice(baseFields);
    const res = await post(`/ucetnictvi/vydane-faktury/${id}/odeslat-email`, { email: '' });
    assert.match(res.headers.get('location'), /error=noemail/);
    assert.equal((await sql`SELECT COUNT(*)::int AS n FROM invoice_emails WHERE invoice_id = ${id}`)[0].n, 0);
  });

  test('pokus o odeslání se vždy zapíše do logu', async () => {
    const { id } = await createInvoice(baseFields);
    await post(`/ucetnictvi/vydane-faktury/${id}/odeslat-email`, { email: 'test@example.invalid' });

    const [log] = await sql`SELECT * FROM invoice_emails WHERE invoice_id = ${id}`;
    assert.ok(log, 'odeslání se má zalogovat i když selže');
    assert.equal(log.kind, 'faktura');
    assert.equal(log.email, 'test@example.invalid');
    assert.ok(['odeslano', 'chyba'].includes(log.status));
    assert.equal(log.sent_by, userId);
  });
});
