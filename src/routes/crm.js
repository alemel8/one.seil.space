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
      INSERT INTO crm_companies (id, name, company_type, country, city, email, phone, website, notes, created_by, modified_by)
      VALUES (${generateId()}, ${(b.name||'').trim()}, ${b.company_type||'Zákazník'},
              ${(b.country||'').trim()}, ${(b.city||'').trim()},
              ${(b.email||'').trim()}, ${(b.phone||'').trim()},
              ${(b.website||'').trim()}, ${(b.notes||'').trim()},
              ${request.user?.id || null}, ${request.user?.id || null})
    `;
    return reply.redirect('/crm/firmy');
  });

  fastify.get('/crm/firmy/:id', async (request, reply) => {
    const [company] = await sql`SELECT * FROM crm_companies WHERE id = ${request.params.id}`;
    if (!company) return reply.code(404).send('Firma nenalezena');

    const [contacts, orders, invoices, contracts, creatorRow, editorRow] = await Promise.all([
      sql`SELECT * FROM crm_contacts WHERE company_id = ${company.id} ORDER BY last_name, first_name`,
      sql`SELECT id, order_number, status, total_price, created_at, first_name, last_name
          FROM shop_orders WHERE crm_company_id = ${company.id} ORDER BY created_at DESC`,
      sql`SELECT id, type, number, status, issue_date, due_date, total_amount, currency
          FROM accounting_invoices WHERE crm_company_id = ${company.id} ORDER BY issue_date DESC`,
      sql`SELECT * FROM crm_contracts WHERE company_id = ${company.id} ORDER BY created_at DESC`,
      company.created_by ? sql`SELECT first_name, last_name, email FROM users WHERE id = ${company.created_by}` : Promise.resolve([]),
      company.modified_by ? sql`SELECT first_name, last_name, email FROM users WHERE id = ${company.modified_by}` : Promise.resolve([]),
    ]);

    // Dashboard stats
    const totalInvoiced = invoices.reduce((s, i) => s + Number(i.total_amount || 0), 0);
    const paidInvoices  = invoices.filter(i => i.status === 'Zaplacena').length;
    const openOrders    = orders.filter(o => !['Vyřízena','Stornována'].includes(o.status)).length;

    return reply.view('pages/crm/company-detail.ejs', {
      pageTitle: company.name, currentPath: '/crm/firmy', user: request.user,
      company, contacts, orders, invoices, contracts,
      stats: { totalInvoiced, paidInvoices, openOrders,
               totalOrders: orders.length, totalInvoices: invoices.length, totalContacts: contacts.length },
      creator: creatorRow[0] || null,
      editor:  editorRow[0]  || null,
      aresUpdated: request.query.ares === '1',
      saved: request.query.saved === '1',
      tab: request.query.tab || 'zakladni',
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/crm/firmy/:id', async (request, reply) => {
    const b = request.body || {};
    await sql`
      UPDATE crm_companies SET
        name              = ${(b.name             ||'').trim()},
        company_type      = ${b.company_type      ||'Zákazník'},
        ico               = ${(b.ico              ||'').trim()},
        dic               = ${(b.dic              ||'').trim()},
        country           = ${(b.country          ||'').trim()},
        city              = ${(b.city             ||'').trim()},
        zip               = ${(b.zip              ||'').trim()},
        address           = ${(b.address          ||'').trim()},
        email             = ${(b.email            ||'').trim()},
        phone             = ${(b.phone            ||'').trim()},
        website           = ${(b.website          ||'').trim()},
        notes             = ${(b.notes            ||'').trim()},
        legal_form        = ${(b.legal_form       ||'').trim()},
        founded_date      = ${b.founded_date      || null},
        registration_info = ${(b.registration_info||'').trim()},
        company_status    = ${(b.company_status   ||'').trim()},
        modified_by       = ${request.user?.id    || null},
        modified_at       = NOW()
      WHERE id = ${request.params.id}
    `;
    return reply.redirect(`/crm/firmy/${request.params.id}?saved=1`);
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
    const companyId = b.company_id || null;
    await sql`
      INSERT INTO crm_contacts (id, first_name, last_name, company_id, title, email, phone, notes, created_by, modified_by)
      VALUES (${generateId()}, ${(b.first_name||'').trim()}, ${(b.last_name||'').trim()},
              ${companyId}, ${(b.title||'').trim()},
              ${(b.email||'').trim()}, ${(b.phone||'').trim()}, ${(b.notes||'').trim()},
              ${request.user?.id || null}, ${request.user?.id || null})
    `;
    return reply.redirect(companyId ? `/crm/firmy/${companyId}?tab=kontakty` : '/crm/kontakty');
  });

  // ── Smlouvy (CRUD) ─────────────────────────────────────────────

  fastify.post('/crm/firmy/:id/smlouvy/vytvorit', async (request, reply) => {
    const b = request.body || {};
    await sql`
      INSERT INTO crm_contracts (id, company_id, title, type, status, signed_date, end_date, amount, currency, notes, created_by, modified_by)
      VALUES (${generateId()}, ${request.params.id},
              ${(b.title||'').trim()}, ${(b.type||'').trim()}, ${b.status||'Aktivní'},
              ${b.signed_date || null}, ${b.end_date || null},
              ${b.amount ? parseFloat(b.amount) : null}, ${b.currency||'CZK'},
              ${(b.notes||'').trim()},
              ${request.user?.id || null}, ${request.user?.id || null})
    `;
    return reply.redirect(`/crm/firmy/${request.params.id}?tab=smlouvy`);
  });

  fastify.post('/crm/smlouvy/:id/smazat', async (request, reply) => {
    const [c] = await sql`SELECT company_id FROM crm_contracts WHERE id = ${request.params.id}`;
    await sql`DELETE FROM crm_contracts WHERE id = ${request.params.id}`;
    return reply.redirect(c ? `/crm/firmy/${c.company_id}?tab=smlouvy` : '/crm/firmy');
  });

  // ── ARES: načtení dat firmy dle IČO ──────────────────────────

  const LEGAL_FORMS = {
    '101': 'Fyzická osoba – podnikatel (OSVČ)',
    '104': 'Zemědělský podnikatel',
    '105': 'Veřejná obchodní společnost (v.o.s.)',
    '106': 'Komanditní společnost (k.s.)',
    '111': 'Akciová společnost (stará)',
    '112': 'Společnost s ručením omezeným (s.r.o.)',
    '113': 'Komanditní spol. na akciích',
    '118': 'Evropská společnost (SE)',
    '121': 'Akciová společnost (a.s.)',
    '141': 'Obecně prospěšná společnost',
    '145': 'Fundace',
    '151': 'Nadace',
    '161': 'Spolek',
    '205': 'Bytové družstvo',
    '211': 'Státní podnik',
    '231': 'Příspěvková organizace',
    '301': 'Příspěvková organizace (státní)',
    '325': 'Organizační složka státu',
    '421': 'Obec',
    '422': 'Město',
  };

  fastify.get('/api/ares/:ico', async (request, reply) => {
    const ico = request.params.ico.replace(/\D/g, '');
    if (ico.length < 6 || ico.length > 8) return reply.code(400).send({ error: 'Neplatné IČO' });
    const ico8 = ico.padStart(8, '0');

    try {
      const res = await fetch(`https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${ico8}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404) return reply.code(404).send({ error: 'Subjekt nenalezen v ARES' });
      if (!res.ok) return reply.code(502).send({ error: `ARES API chyba: ${res.status}` });

      const data = await res.json();
      const addr = data.sidlo || {};

      // Sestavení ulice
      const streetNum = addr.cisloDomovni
        ? `${addr.cisloDomovni}${addr.cisloOrientacni ? '/' + addr.cisloOrientacni : ''}`
        : '';
      const street = [addr.nazevUlice, streetNum].filter(Boolean).join(' ');

      // Spisová značka z dalšíUdaje
      let registrationInfo = '';
      for (const item of data.dalsiUdaje || []) {
        if (item.spisovaZnacka) {
          registrationInfo = item.spisovaZnacka;
          break;
        }
      }

      // Stav subjektu
      const companyStatus = data.seznamRegistraci?.stavZdrojeVr === 'AKTIVNI'
        ? 'Aktivní'
        : data.seznamRegistraci?.stavZdrojeRos === 'AKTIVNI' ? 'Aktivní' : 'Neaktivní';

      return reply.send({
        ico:              data.ico,
        dic:              data.dic || '',
        name:             data.obchodniJmeno || '',
        address:          street,
        city:             addr.nazevObce || '',
        zip:              addr.psc ? String(addr.psc) : '',
        country:          addr.nazevStatu || 'Česká republika',
        country_code:     addr.kodStatu || 'CZ',
        legal_form:       LEGAL_FORMS[data.pravniForma] || data.pravniForma || '',
        founded_date:     data.datumVzniku || null,
        registration_info: registrationInfo,
        company_status:   companyStatus,
        raw:              data,
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
        name              = ${(b.name             ||'').trim()},
        ico               = ${(b.ico              ||'').trim()},
        dic               = ${(b.dic              ||'').trim()},
        address           = ${(b.address          ||'').trim()},
        city              = ${(b.city             ||'').trim()},
        zip               = ${(b.zip              ||'').trim()},
        country           = ${(b.country          ||'').trim()},
        legal_form        = ${(b.legal_form       ||'').trim()},
        founded_date      = ${b.founded_date || null},
        registration_info = ${(b.registration_info||'').trim()},
        company_status    = ${(b.company_status   ||'').trim()},
        ares_data         = ${b.raw ? JSON.stringify(b.raw) : sql`ares_data`}::jsonb,
        ares_synced_at    = NOW(),
        modified_by       = ${request.user?.id || null},
        modified_at       = NOW()
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
