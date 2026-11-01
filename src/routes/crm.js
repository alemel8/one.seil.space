import { getDb, generateId } from '../db.js';
import { rezimUprav } from '../upravy.js';
import { parametr, strankovani } from '../strankovani.js';
import { zalozka } from '../zalozky.js';
import { escapujLike } from '../hledani.js';

const ZALOZKY_FIRMY = [
  ['zakladni', 'Základní informace'],
  ['kontakty', 'Kontakty'],
  ['objednavky', 'Objednávky'],
  ['faktury', 'Faktury'],
  ['smlouvy', 'Smlouvy'],
  ['poznamky', 'Poznámky'],
];

const ZALOZKY_KONTAKTU = [
  ['prehled', 'Přehled'],
  ['objednavky', 'Objednávky'],
  ['faktury', 'Faktury'],
];

/** Záložky s počtem řádků v odznaku; záložka bez počtu odznak nemá. */
const sPocty = (seznam, pocty) => seznam.map(([klic, popisek]) => ({ klic, popisek, pocet: pocty[klic] }));

export default async function crmRoutes(fastify) {
  const sql = getDb();

  // Firma kontaktu: název připojené firmy, jinak text z účtu. Kontakt založený
  // v aplikaci má jen company_id, účet z e-shopu často jen company_name.
  const firmaKontaktu = sql`COALESCE(NULLIF(co.name, ''), c.company_name)`;

  // ── Firmy ──────────────────────────────────────────────────

  fastify.get('/crm/firmy', async (request, reply) => {
    const q            = parametr(request.query.q);
    const typeFilter   = parametr(request.query.type);
    const sourceFilter = parametr(request.query.source);
    const vzor = `%${escapujLike(q)}%`;

    const conditions = [];
    if (q)          conditions.push(sql`(name ILIKE ${vzor} OR city ILIKE ${vzor} OR country ILIKE ${vzor} OR ico ILIKE ${vzor})`);
    if (typeFilter) conditions.push(sql`company_type = ${typeFilter}`);
    // „(bez zdroje)" je vlastní volba, aby šlo najít ručně založené záznamy –
    // prázdný řetězec znamená „nefiltrovat", takže NULL potřebuje svůj klíč.
    if (sourceFilter === '-') conditions.push(sql`source IS NULL`);
    else if (sourceFilter)    conditions.push(sql`source = ${sourceFilter}`);
    const where = conditions.length
      ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
      : sql``;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM crm_companies ${where}`;
    const strany = strankovani({ cesta: '/crm/firmy', query: request.query, celkem: count, zachovat: ['q', 'type', 'source'] });
    const companies = await sql`
      SELECT id, name, company_type, source, country, city, email, phone, created_at
      FROM crm_companies ${where}
      ORDER BY name, id
      LIMIT ${strany.naStranku} OFFSET ${strany.offset}
    `;
    const sources     = await sql`
      SELECT DISTINCT source FROM crm_companies WHERE source IS NOT NULL ORDER BY source
    `;

    return reply.view('pages/crm/companies.ejs', {
      pageTitle: 'Firmy', currentPath: '/crm/firmy', user: request.user,
      companies, q, typeFilter, sourceFilter, sources, total: count, strany,
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

    const tab = zalozka(ZALOZKY_FIRMY, request.query.tab);

    // Počty v záložkách a KPI ze SQL: řádky se načítají jen pro otevřenou záložku
    // a po stránkách, z nich by to vyšlo špatně. Fakturováno sčítá všechny typy
    // dokladů i měny tak, jak to stránka ukazovala vždy.
    const [souhrn] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM crm_contacts  WHERE company_id = ${company.id}) AS kontaktu,
        (SELECT COUNT(*)::int FROM crm_contracts WHERE company_id = ${company.id}) AS smluv,
        o.objednavek, o.otevrenych, f.faktur, f.zaplacenych, f.fakturovano
      FROM (
        SELECT COUNT(*)::int AS objednavek,
               (COUNT(*) FILTER (WHERE status NOT IN ('Vyřízena', 'Stornována')))::int AS otevrenych
        FROM shop_orders WHERE crm_company_id = ${company.id}
      ) o CROSS JOIN (
        SELECT COUNT(*)::int AS faktur,
               (COUNT(*) FILTER (WHERE status = 'Zaplacena'))::int AS zaplacenych,
               COALESCE(SUM(total_amount), 0) AS fakturovano
        FROM accounting_invoices WHERE crm_company_id = ${company.id}
      ) f
    `;
    const stats = {
      totalInvoiced: Number(souhrn.fakturovano), paidInvoices: souhrn.zaplacenych, openOrders: souhrn.otevrenych,
      totalOrders: souhrn.objednavek, totalInvoices: souhrn.faktur, totalContacts: souhrn.kontaktu, totalContracts: souhrn.smluv,
    };

    const cesta = `/crm/firmy/${company.id}`;
    const osoba = async (id) => (id ? (await sql`SELECT first_name, last_name, email FROM users WHERE id = ${id}`)[0] || null : null);
    let contacts = [], orders = [], invoices = [], contracts = [], strany = null, creator = null, editor = null;
    if (tab === 'zakladni') {
      [creator, editor] = await Promise.all([osoba(company.created_by), osoba(company.modified_by)]);
    } else if (tab === 'kontakty') {
      contacts = await sql`SELECT * FROM crm_contacts WHERE company_id = ${company.id} ORDER BY last_name, first_name, id`;
    } else if (tab === 'objednavky') {
      strany = strankovani({ cesta, query: request.query, celkem: stats.totalOrders, pevne: { tab } });
      orders = await sql`
        SELECT id, order_number, status, total_price, currency, created_at, first_name, last_name
        FROM shop_orders WHERE crm_company_id = ${company.id}
        ORDER BY created_at DESC, id DESC
        LIMIT ${strany.naStranku} OFFSET ${strany.offset}
      `;
    } else if (tab === 'faktury') {
      strany = strankovani({ cesta, query: request.query, celkem: stats.totalInvoices, pevne: { tab } });
      invoices = await sql`
        SELECT id, type, number, status, issue_date, due_date, total_amount, currency
        FROM accounting_invoices WHERE crm_company_id = ${company.id}
        ORDER BY issue_date DESC, id DESC
        LIMIT ${strany.naStranku} OFFSET ${strany.offset}
      `;
    } else if (tab === 'smlouvy') {
      contracts = await sql`SELECT * FROM crm_contracts WHERE company_id = ${company.id} ORDER BY created_at DESC, id DESC`;
    }

    return reply.view('pages/crm/company-detail.ejs', {
      pageTitle: company.name, currentPath: '/crm/firmy', user: request.user,
      company, contacts, orders, invoices, contracts, stats, strany,
      creator, editor,
      aresUpdated: request.query.ares === '1',
      saved: request.query.saved === '1',
      tab,
      zalozky: sPocty(ZALOZKY_FIRMY, { kontakty: stats.totalContacts, objednavky: stats.totalOrders, faktury: stats.totalInvoices, smlouvy: stats.totalContracts }),
      rezimUprav: rezimUprav(request.query),
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

  // Záložka Poznámky má formulář jen s textarea. Přes POST /crm/firmy/:id, který
  // přepisuje celý řádek, by musela posílat zbytek firmy v hidden polích – a když
  // se některé zapomnělo (web), každé uložení poznámek ho firmě smazalo.
  fastify.post('/crm/firmy/:id/poznamky', async (request, reply) => {
    const b = request.body || {};
    if (b.notes === undefined) return reply.code(400).send('Chybí pole notes'); // nesmí poznámky smazat
    await sql`
      UPDATE crm_companies SET
        notes       = ${b.notes.trim()},
        modified_by = ${request.user?.id || null},
        modified_at = NOW()
      WHERE id = ${request.params.id}
    `;
    return reply.redirect(`/crm/firmy/${request.params.id}?tab=poznamky&saved=1`);
  });

  // ── Kontakty ───────────────────────────────────────────────

  fastify.get('/crm/kontakty', async (request, reply) => {
    const q             = parametr(request.query.q);
    const companyFilter = parametr(request.query.company);
    const sourceFilter  = parametr(request.query.source);
    const vzor = `%${escapujLike(q)}%`;

    const conditions = [];
    if (q)             conditions.push(sql`(c.first_name ILIKE ${vzor} OR c.last_name ILIKE ${vzor} OR c.email ILIKE ${vzor} OR c.phone ILIKE ${vzor})`);
    if (companyFilter) conditions.push(sql`c.company_id = ${companyFilter}`);
    if (sourceFilter === '-') conditions.push(sql`c.source IS NULL`);
    else if (sourceFilter)    conditions.push(sql`c.source = ${sourceFilter}`);
    const where = conditions.length
      ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
      : sql``;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM crm_contacts c ${where}`;
    const strany = strankovani({ cesta: '/crm/kontakty', query: request.query, celkem: count, zachovat: ['q', 'company', 'source'] });
    const contacts = await sql`
      SELECT c.id, c.first_name, c.last_name, c.title, c.email, c.phone, c.company_id, c.source, c.is_registered, c.created_at,
             ${firmaKontaktu} AS company_display_name
      FROM crm_contacts c
      LEFT JOIN crm_companies co ON c.company_id = co.id
      ${where}
      ORDER BY c.last_name, c.first_name, c.id
      LIMIT ${strany.naStranku} OFFSET ${strany.offset}
    `;
    const companies = await sql`SELECT id, name FROM crm_companies ORDER BY name, id`;
    const sources   = await sql`
      SELECT DISTINCT source FROM crm_contacts WHERE source IS NOT NULL ORDER BY source
    `;

    return reply.view('pages/crm/contacts.ejs', {
      pageTitle: 'Kontakty', currentPath: '/crm/kontakty', user: request.user,
      contacts, q, companyFilter, sourceFilter, sources, total: count, strany, companies,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.get('/crm/kontakty/:id', async (request, reply) => {
    const [contact] = await sql`
      SELECT c.*, ${firmaKontaktu} AS company_display_name
      FROM crm_contacts c
      LEFT JOIN crm_companies co ON c.company_id = co.id
      WHERE c.id = ${request.params.id}
    `;
    if (!contact) return reply.code(404).send('Kontakt nenalezen');

    const tab = zalozka(ZALOZKY_KONTAKTU, request.query.tab);

    /*
     * Zákazník e-shopu má v Seilu i doklady, jen se sem dosud netahaly.
     * Objednávka a faktura na sebe navazují, takže je užitečné vidět obojí
     * na jednom místě – kolik toho u nás nakoupil a co za to bylo vystaveno.
     *
     * Doklady se hledají i přes objednávky: `accounting_invoices` sice má
     * `crm_contact_id`, ale u dokladů vystavených ke starším objednávkám
     * bývá prázdné.
     */
    const dokladyKontaktu = sql`
      (i.crm_contact_id = ${contact.id}
       OR i.order_id IN (SELECT id FROM shop_orders WHERE crm_contact_id = ${contact.id}))
    `;

    // „Zaplaceno" se počítá z dokladů, ne z objednávek – objednávka může být
    // přijatá a nezaplacená a sečíst ji jako tržbu by bylo zavádějící.
    const [s] = await sql`
      SELECT o.objednavek, o.utraceno, o.posledni, f.faktur, f.zaplaceno
      FROM (
        SELECT COUNT(*)::int AS objednavek, COALESCE(SUM(total_price), 0) AS utraceno, MAX(created_at) AS posledni
        FROM shop_orders WHERE crm_contact_id = ${contact.id}
      ) o CROSS JOIN (
        SELECT COUNT(*)::int AS faktur,
               COALESCE(SUM(i.total_amount) FILTER (WHERE i.status = 'Zaplacena'), 0) AS zaplaceno
        FROM accounting_invoices i WHERE ${dokladyKontaktu}
      ) f
    `;
    const souhrn = {
      objednavek: s.objednavek, faktur: s.faktur, posledni: s.posledni,
      utraceno: Number(s.utraceno), zaplaceno: Number(s.zaplaceno),
    };

    const cesta = `/crm/kontakty/${contact.id}`;
    let orders = [], invoices = [], strany = null;
    if (tab === 'objednavky') {
      strany = strankovani({ cesta, query: request.query, celkem: souhrn.objednavek, pevne: { tab } });
      orders = await sql`
        SELECT id, order_number, status, total_price, currency, created_at
        FROM shop_orders WHERE crm_contact_id = ${contact.id}
        ORDER BY created_at DESC, id DESC
        LIMIT ${strany.naStranku} OFFSET ${strany.offset}
      `;
    } else if (tab === 'faktury') {
      strany = strankovani({ cesta, query: request.query, celkem: souhrn.faktur, pevne: { tab } });
      invoices = await sql`
        SELECT i.id, i.type, i.number, i.status, i.issue_date, i.due_date, i.total_amount, i.currency
        FROM accounting_invoices i
        WHERE ${dokladyKontaktu}
        ORDER BY i.issue_date DESC, i.id DESC
        LIMIT ${strany.naStranku} OFFSET ${strany.offset}
      `;
    }

    return reply.view('pages/crm/contact-detail.ejs', {
      pageTitle: `${contact.first_name} ${contact.last_name}`.trim() || contact.email || 'Kontakt',
      currentPath: '/crm/kontakty', user: request.user,
      contact, orders, invoices, souhrn, strany, tab,
      zalozky: sPocty(ZALOZKY_KONTAKTU, { objednavky: souhrn.objednavek, faktury: souhrn.faktur }),
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
