import { getDb, generateId } from '../db.js';

export default async function crmRoutes(fastify) {
  const sql = getDb();

  // ── Firmy ──────────────────────────────────────────────────

  fastify.get('/crm/firmy', async (request, reply) => {
    const q          = (request.query.q    || '').trim();
    const typeFilter = (request.query.type || '').trim();
    const page    = Math.max(1, parseInt(request.query.page || '1', 10));
    const perPage = 25;
    const offset  = (page - 1) * perPage;

    const conditions = [];
    if (q)          conditions.push(sql`(name ILIKE ${'%' + q + '%'} OR city ILIKE ${'%' + q + '%'} OR country ILIKE ${'%' + q + '%'})`);
    if (typeFilter) conditions.push(sql`company_type = ${typeFilter}`);
    const where = conditions.length
      ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
      : sql``;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM crm_companies ${where}`;
    const companies   = await sql`SELECT * FROM crm_companies ${where} ORDER BY name LIMIT ${perPage} OFFSET ${offset}`;

    return reply.view('pages/crm/companies.ejs', {
      pageTitle: 'Firmy', currentPath: '/crm/firmy', user: request.user,
      companies, q, typeFilter, total: count,
      currentPage: page, totalPages: Math.ceil(count / perPage),
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/crm/firmy/vytvorit', async (request, reply) => {
    const b = request.body || {};
    await sql`
      INSERT INTO crm_companies (id, name, company_type, country, city, email, phone, website, notes)
      VALUES (${generateId()}, ${(b.name||'').trim()}, ${b.company_type||'Zákazník'},
              ${(b.country||'').trim()}, ${(b.city||'').trim()},
              ${(b.email||'').trim()}, ${(b.phone||'').trim()},
              ${(b.website||'').trim()}, ${(b.notes||'').trim()})
    `;
    return reply.redirect('/crm/firmy');
  });

  fastify.get('/crm/firmy/:id', async (request, reply) => {
    const [company] = await sql`SELECT * FROM crm_companies WHERE id = ${request.params.id}`;
    if (!company) return reply.code(404).send('Firma nenalezena');

    const contacts = await sql`
      SELECT * FROM crm_contacts WHERE company_id = ${company.id} ORDER BY last_name, first_name
    `;
    const orders = await sql`
      SELECT id, order_number, status, total_price, created_at, first_name, last_name
      FROM shop_orders WHERE crm_company_id = ${company.id}
      ORDER BY created_at DESC
    `;
    return reply.view('pages/crm/company-detail.ejs', {
      pageTitle: company.name, currentPath: '/crm/firmy', user: request.user,
      company, contacts, orders, aresUpdated: request.query.ares === '1',
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/crm/firmy/:id', async (request, reply) => {
    const b = request.body || {};
    await sql`
      UPDATE crm_companies SET
        name = ${(b.name||'').trim()},
        company_type = ${b.company_type||'Zákazník'},
        ico = ${(b.ico||'').trim()},
        dic = ${(b.dic||'').trim()},
        country = ${(b.country||'').trim()},
        city = ${(b.city||'').trim()},
        zip = ${(b.zip||'').trim()},
        address = ${(b.address||'').trim()},
        email = ${(b.email||'').trim()},
        phone = ${(b.phone||'').trim()},
        website = ${(b.website||'').trim()},
        notes = ${(b.notes||'').trim()},
        modified_at = NOW()
      WHERE id = ${request.params.id}
    `;
    return reply.redirect(`/crm/firmy/${request.params.id}`);
  });

  // ── Kontakty ───────────────────────────────────────────────

  fastify.get('/crm/kontakty', async (request, reply) => {
    const q             = (request.query.q       || '').trim();
    const companyFilter = (request.query.company || '').trim();
    const page    = Math.max(1, parseInt(request.query.page || '1', 10));
    const perPage = 25;
    const offset  = (page - 1) * perPage;

    const conditions = [];
    if (q)             conditions.push(sql`(c.first_name ILIKE ${'%'+q+'%'} OR c.last_name ILIKE ${'%'+q+'%'} OR c.email ILIKE ${'%'+q+'%'})`);
    if (companyFilter) conditions.push(sql`c.company_id = ${companyFilter}`);
    const where = conditions.length
      ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
      : sql``;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM crm_contacts c ${where}`;
    const contacts    = await sql`
      SELECT c.*, co.name AS company_display_name
      FROM crm_contacts c
      LEFT JOIN crm_companies co ON c.company_id = co.id
      ${where}
      ORDER BY c.last_name, c.first_name
      LIMIT ${perPage} OFFSET ${offset}
    `;
    const companies = await sql`SELECT id, name FROM crm_companies ORDER BY name`;

    return reply.view('pages/crm/contacts.ejs', {
      pageTitle: 'Kontakty', currentPath: '/crm/kontakty', user: request.user,
      contacts, q, companyFilter, total: count,
      currentPage: page, totalPages: Math.ceil(count / perPage), companies,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.get('/crm/kontakty/:id', async (request, reply) => {
    const [contact] = await sql`
      SELECT c.*, co.name AS company_display_name
      FROM crm_contacts c
      LEFT JOIN crm_companies co ON c.company_id = co.id
      WHERE c.id = ${request.params.id}
    `;
    if (!contact) return reply.code(404).send('Kontakt nenalezen');

    const orders = await sql`
      SELECT id, order_number, status, total_price, created_at, company
      FROM shop_orders WHERE crm_contact_id = ${contact.id}
      ORDER BY created_at DESC
    `;
    return reply.view('pages/crm/contact-detail.ejs', {
      pageTitle: `${contact.first_name} ${contact.last_name}`.trim(),
      currentPath: '/crm/kontakty', user: request.user,
      contact, orders,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/crm/kontakty/vytvorit', async (request, reply) => {
    const b = request.body || {};
    await sql`
      INSERT INTO crm_contacts (id, first_name, last_name, company_id, title, email, phone, notes)
      VALUES (${generateId()}, ${(b.first_name||'').trim()}, ${(b.last_name||'').trim()},
              ${b.company_id || null}, ${(b.title||'').trim()},
              ${(b.email||'').trim()}, ${(b.phone||'').trim()}, ${(b.notes||'').trim()})
    `;
    return reply.redirect('/crm/kontakty');
  });

  // ── ARES: načtení dat firmy dle IČO ──────────────────────────

  fastify.get('/api/ares/:ico', async (request, reply) => {
    const ico = request.params.ico.replace(/\s/g, '');
    if (!/^\d{8}$/.test(ico)) return reply.code(400).send({ error: 'IČO musí mít 8 číslic' });

    try {
      const res = await fetch(`https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${ico}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) return reply.code(404).send({ error: 'Subjekt nenalezen v ARES' });
      if (!res.ok) return reply.code(502).send({ error: `ARES API chyba: ${res.status}` });

      const data = await res.json();
      const addr = data.sidlo || {};
      return reply.send({
        ico:     data.ico,
        dic:     data.dic || '',
        name:    data.obchodniJmeno || '',
        address: [addr.nazevUlice, addr.cisloDomovni ? (addr.cisloDomovni + (addr.cisloOrientacni ? '/' + addr.cisloOrientacni : '')) : ''].filter(Boolean).join(' '),
        city:    addr.nazevObce || '',
        zip:     addr.psc ? String(addr.psc) : '',
        country: 'Česká republika',
        raw:     data,
      });
    } catch (err) {
      return reply.code(502).send({ error: `ARES nedostupný: ${err.message}` });
    }
  });

  // Uložení ARES dat na firmu
  fastify.post('/crm/firmy/:id/ares', async (request, reply) => {
    const b = request.body || {};
    await sql`
      UPDATE crm_companies SET
        name        = ${(b.name       ||'').trim()},
        ico         = ${(b.ico        ||'').trim()},
        dic         = ${(b.dic        ||'').trim()},
        address     = ${(b.address    ||'').trim()},
        city        = ${(b.city       ||'').trim()},
        zip         = ${(b.zip        ||'').trim()},
        ares_data   = ${b.raw ? JSON.stringify(b.raw) : sql`ares_data`}::jsonb,
        ares_synced_at = NOW(),
        modified_at = NOW()
      WHERE id = ${request.params.id}
    `;
    return reply.redirect(`/crm/firmy/${request.params.id}?ares=1`);
  });

  fastify.post('/crm/kontakty/:id', async (request, reply) => {
    const b = request.body || {};
    await sql`
      UPDATE crm_contacts SET
        first_name = ${(b.first_name||'').trim()},
        last_name  = ${(b.last_name||'').trim()},
        email      = ${(b.email||'').trim() || null},
        phone      = ${(b.phone||'').trim()},
        title      = ${(b.title||'').trim()},
        company_id = ${b.company_id || null},
        address    = ${(b.address||'').trim()},
        city       = ${(b.city||'').trim()},
        zip        = ${(b.zip||'').trim()},
        notes      = ${(b.notes||'').trim()},
        modified_at = NOW()
      WHERE id = ${request.params.id}
    `;
    return reply.redirect(`/crm/kontakty/${request.params.id}`);
  });
}
