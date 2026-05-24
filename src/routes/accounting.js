import { getAppDb, generateId } from '../db.js';

export default async function accountingRoutes(fastify) {

  // ── Objednávky ─────────────────────────────────────────────

  fastify.get('/ucetnictvi/objednavky', async (request, reply) => {
    const db = getAppDb();
    const orders = db.prepare(`
      SELECT o.*, c.name as company_name
      FROM accounting_orders o
      LEFT JOIN crm_companies c ON o.company_id = c.id
      ORDER BY o.date DESC
    `).all();
    const companies = db.prepare('SELECT id, name FROM crm_companies ORDER BY name').all();
    return reply.view('pages/accounting/orders.ejs', {
      pageTitle: 'Objednávky',
      currentPath: '/ucetnictvi/objednavky',
      user: request.user,
      orders,
      companies,
      total: orders.length,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/objednavky/vytvorit', async (request, reply) => {
    const db = getAppDb();
    const b = request.body || {};
    db.prepare(`INSERT INTO accounting_orders (id, number, subject, amount, currency, status, company_id, date, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      generateId(), b.number || '', b.subject || '',
      parseFloat(b.amount || 0), b.currency || 'CZK',
      b.status || 'Nová', b.company_id || null,
      b.date || new Date().toISOString().split('T')[0], b.notes || '',
    );
    return reply.redirect('/ucetnictvi/objednavky');
  });

  // ── Přijaté faktury ────────────────────────────────────────

  fastify.get('/ucetnictvi/prijate-faktury', async (request, reply) => {
    const db = getAppDb();
    const invoices = db.prepare('SELECT * FROM accounting_invoices_received ORDER BY date DESC').all();
    return reply.view('pages/accounting/invoices-received.ejs', {
      pageTitle: 'Přijaté faktury',
      currentPath: '/ucetnictvi/prijate-faktury',
      user: request.user,
      invoices,
      total: invoices.length,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/prijate-faktury/vytvorit', async (request, reply) => {
    const db = getAppDb();
    const b = request.body || {};
    db.prepare(`INSERT INTO accounting_invoices_received (id, number, supplier, amount, currency, status, due_date, date, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      generateId(), b.number || '', b.supplier || '',
      parseFloat(b.amount || 0), b.currency || 'CZK',
      b.status || 'Nezaplaceno', b.due_date || '',
      b.date || new Date().toISOString().split('T')[0], b.notes || '',
    );
    return reply.redirect('/ucetnictvi/prijate-faktury');
  });

  // ── Vydané faktury ─────────────────────────────────────────

  fastify.get('/ucetnictvi/vydane-faktury', async (request, reply) => {
    const db = getAppDb();
    const invoices = db.prepare('SELECT * FROM accounting_invoices_issued ORDER BY date DESC').all();
    return reply.view('pages/accounting/invoices-issued.ejs', {
      pageTitle: 'Vydané faktury',
      currentPath: '/ucetnictvi/vydane-faktury',
      user: request.user,
      invoices,
      total: invoices.length,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/vydane-faktury/vytvorit', async (request, reply) => {
    const db = getAppDb();
    const b = request.body || {};
    db.prepare(`INSERT INTO accounting_invoices_issued (id, number, client, amount, currency, status, due_date, date, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      generateId(), b.number || '', b.client || '',
      parseFloat(b.amount || 0), b.currency || 'CZK',
      b.status || 'Nezaplacena', b.due_date || '',
      b.date || new Date().toISOString().split('T')[0], b.notes || '',
    );
    return reply.redirect('/ucetnictvi/vydane-faktury');
  });

  // ── Banka ──────────────────────────────────────────────────

  fastify.get('/ucetnictvi/banka', async (request, reply) => {
    const db = getAppDb();
    const transactions = db.prepare('SELECT * FROM accounting_bank ORDER BY date DESC').all();
    return reply.view('pages/accounting/bank.ejs', {
      pageTitle: 'Banka',
      currentPath: '/ucetnictvi/banka',
      user: request.user,
      transactions,
      total: transactions.length,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/banka/vytvorit', async (request, reply) => {
    const db = getAppDb();
    const b = request.body || {};
    db.prepare(`INSERT INTO accounting_bank (id, description, amount, currency, type, date, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      generateId(), b.description || '',
      parseFloat(b.amount || 0), b.currency || 'CZK',
      b.type || 'Příjem',
      b.date || new Date().toISOString().split('T')[0], b.notes || '',
    );
    return reply.redirect('/ucetnictvi/banka');
  });
}
