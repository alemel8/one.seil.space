import { getAppDb, generateId } from '../db.js';

export default async function crmRoutes(fastify) {

  // ── Firmy ──────────────────────────────────────────────────

  fastify.get('/crm/firmy', async (request, reply) => {
    const db = getAppDb();
    const q = (request.query.q || '').trim();
    const typeFilter = (request.query.type || '').trim();
    const page = Math.max(1, parseInt(request.query.page || '1', 10));
    const perPage = 25;
    const offset = (page - 1) * perPage;

    let where = '1=1';
    const params = [];

    if (q) {
      where += ' AND (name LIKE ? OR country LIKE ? OR city LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (typeFilter) {
      where += ' AND company_type = ?';
      params.push(typeFilter);
    }

    const total = db.prepare(`SELECT COUNT(*) as n FROM crm_companies WHERE ${where}`).get(...params).n;
    const companies = db.prepare(`SELECT * FROM crm_companies WHERE ${where} ORDER BY name LIMIT ? OFFSET ?`).all(...params, perPage, offset);

    return reply.view('pages/crm/companies.ejs', {
      pageTitle: 'Firmy',
      currentPath: '/crm/firmy',
      user: request.user,
      companies,
      q,
      typeFilter,
      total,
      currentPage: page,
      totalPages: Math.ceil(total / perPage),
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/crm/firmy/vytvorit', async (request, reply) => {
    const db = getAppDb();
    const b = request.body || {};
    db.prepare(`INSERT INTO crm_companies (id, name, company_type, country, city, email, phone, website, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      generateId(),
      (b.name || '').trim(),
      b.company_type || 'Zákazník',
      (b.country || '').trim(),
      (b.city || '').trim(),
      (b.email || '').trim(),
      (b.phone || '').trim(),
      (b.website || '').trim(),
      (b.notes || '').trim(),
    );
    return reply.redirect('/crm/firmy');
  });

  fastify.get('/crm/firmy/:id', async (request, reply) => {
    const db = getAppDb();
    const company = db.prepare('SELECT * FROM crm_companies WHERE id = ?').get(request.params.id);
    if (!company) return reply.code(404).send('Firma nenalezena');
    const contacts = db.prepare('SELECT * FROM crm_contacts WHERE company_id = ? ORDER BY last_name, first_name').all(company.id);
    const orders = db.prepare(`
      SELECT id, order_number, status, total_price, created_at, first_name, last_name
      FROM toneracek_orders WHERE crm_company_id = ?
      ORDER BY order_number DESC
    `).all(company.id);
    return reply.view('pages/crm/company-detail.ejs', {
      pageTitle: company.name,
      currentPath: '/crm/firmy',
      user: request.user,
      company,
      contacts,
      orders,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Kontakty ───────────────────────────────────────────────

  fastify.get('/crm/kontakty', async (request, reply) => {
    const db = getAppDb();
    const q = (request.query.q || '').trim();
    const companyFilter = (request.query.company || '').trim();
    const page = Math.max(1, parseInt(request.query.page || '1', 10));
    const perPage = 25;
    const offset = (page - 1) * perPage;

    let where = '1=1';
    const params = [];

    if (q) {
      where += ' AND (c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (companyFilter) {
      where += ' AND c.company_id = ?';
      params.push(companyFilter);
    }

    const total = db.prepare(`SELECT COUNT(*) as n FROM crm_contacts c WHERE ${where}`).get(...params).n;
    const contacts = db.prepare(`
      SELECT c.*, co.name as company_name
      FROM crm_contacts c
      LEFT JOIN crm_companies co ON c.company_id = co.id
      WHERE ${where}
      ORDER BY c.last_name, c.first_name
      LIMIT ? OFFSET ?
    `).all(...params, perPage, offset);

    const companies = db.prepare('SELECT id, name FROM crm_companies ORDER BY name').all();

    return reply.view('pages/crm/contacts.ejs', {
      pageTitle: 'Kontakty',
      currentPath: '/crm/kontakty',
      user: request.user,
      contacts,
      q,
      companyFilter,
      total,
      currentPage: page,
      totalPages: Math.ceil(total / perPage),
      companies,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.get('/crm/kontakty/:id', async (request, reply) => {
    const db = getAppDb();
    const contact = db.prepare(`
      SELECT c.*, co.name as company_name
      FROM crm_contacts c
      LEFT JOIN crm_companies co ON c.company_id = co.id
      WHERE c.id = ?
    `).get(request.params.id);
    if (!contact) return reply.code(404).send('Kontakt nenalezen');
    const orders = db.prepare(`
      SELECT id, order_number, status, total_price, created_at, company
      FROM toneracek_orders WHERE crm_contact_id = ?
      ORDER BY order_number DESC
    `).all(contact.id);
    return reply.view('pages/crm/contact-detail.ejs', {
      pageTitle: `${contact.first_name} ${contact.last_name}`.trim(),
      currentPath: '/crm/kontakty',
      user: request.user,
      contact,
      orders,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/crm/kontakty/vytvorit', async (request, reply) => {
    const db = getAppDb();
    const b = request.body || {};
    db.prepare(`INSERT INTO crm_contacts (id, first_name, last_name, company_id, title, email, phone, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      generateId(),
      (b.first_name || '').trim(),
      (b.last_name || '').trim(),
      b.company_id || null,
      (b.title || '').trim(),
      (b.email || '').trim(),
      (b.phone || '').trim(),
      (b.notes || '').trim(),
    );
    return reply.redirect('/crm/kontakty');
  });
}
