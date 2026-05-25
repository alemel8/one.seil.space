import { getAppDb, generateId } from '../db.js';
import { sendOrderStatusEmail } from '../email.js';

const ORDER_STATUSES = ['Přijata', 'Ve zpracování', 'Vyřízena', 'Stornována'];

const PAYMENT_LABELS = {
  card: 'Platba kartou',
  transfer: 'Bankovní převod',
  cod: 'Dobírka',
};

// ── CRM upsert zákazníka ──────────────────────────────────────
// Vrací { contactId, companyId } — oba mohou být null

function upsertCustomerToCRM(db, { email, firstName, lastName, company, phone, city, country, isRegistered }) {
  if (!email) return { contactId: null, companyId: null };

  let companyId = null;
  if (company && company.trim()) {
    const existingCo = db.prepare('SELECT id FROM crm_companies WHERE name = ?').get(company.trim());
    if (existingCo) {
      companyId = existingCo.id;
    } else {
      companyId = generateId();
      db.prepare(`
        INSERT INTO crm_companies (id, name, company_type, city, country, modified_at)
        VALUES (?, ?, 'Zákazník', ?, ?, datetime('now'))
      `).run(companyId, company.trim(), city || '', country || '');
    }
  }

  const isReg = isRegistered ? 1 : 0;
  const existing = db.prepare('SELECT id, is_registered FROM crm_contacts WHERE email = ?').get(email);
  let contactId;
  if (existing) {
    // Registrovaný status se nikdy nesníží (jednou registrovaný = vždy)
    const newIsReg = Math.max(existing.is_registered || 0, isReg);
    db.prepare(`
      UPDATE crm_contacts SET
        first_name = ?, last_name = ?, phone = ?,
        company_id = COALESCE(company_id, ?),
        is_registered = ?,
        modified_at = datetime('now')
      WHERE email = ?
    `).run(firstName || '', lastName || '', phone || '', companyId, newIsReg, email);
    contactId = existing.id;
  } else {
    contactId = generateId();
    db.prepare(`
      INSERT INTO crm_contacts (id, first_name, last_name, email, phone, company_id, is_registered, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Zákazník Toneráček.cz')
    `).run(contactId, firstName || '', lastName || '', email, phone || '', companyId, isReg);
  }

  return { contactId, companyId };
}

// ── API: ověření klíče ─────────────────────────────────────────

function verifyApiKey(request) {
  const auth = request.headers['authorization'] || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const expected = process.env.TONERACEK_API_KEY;
  return expected && key === expected;
}

export default async function toneracekRoutes(fastify) {

  // ── API: Příjem nové objednávky z e-shopu ──────────────────

  fastify.post('/api/toneracek/orders', async (request, reply) => {
    if (!verifyApiKey(request)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const b = request.body;
    if (!b || !b.customer || !b.items || !b.totalPrice) {
      return reply.code(400).send({ error: 'Chybí povinná data objednávky' });
    }

    const db = getAppDb();
    const { customer, shipping, paymentMethod, items, totalPrice, ipAddress } = b;

    // Číslo objednávky
    const last = db.prepare('SELECT order_number FROM toneracek_orders ORDER BY order_number DESC LIMIT 1').get();
    const orderNumber = last ? last.order_number + 1 : 10001;

    const now = new Date();
    const invoiceNumber = `FV-${now.getFullYear()}-${orderNumber}`;
    const orderId = generateId();

    db.prepare(`
      INSERT INTO toneracek_orders (
        id, order_number, status, payment_method, shipping_method,
        first_name, last_name, company, ic, dic,
        email, phone, address, city, zip, country,
        shipping_first_name, shipping_last_name, shipping_company,
        shipping_phone, shipping_address, shipping_city, shipping_zip,
        pickup_point_id, pickup_point_name,
        total_price, invoice_number, ip_address
      ) VALUES (
        ?, ?, 'Přijata', ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?
      )
    `).run(
      orderId, orderNumber,
      PAYMENT_LABELS[paymentMethod] ?? paymentMethod,
      shipping?.method ?? 'Zásilkovna',
      customer.firstName ?? '', customer.lastName ?? '',
      customer.company ?? '', customer.ic ?? '', customer.dic ?? '',
      customer.email ?? '', customer.phone ?? '',
      customer.address ?? '', customer.city ?? '', customer.zip ?? '',
      customer.stat ?? 'Česká republika',
      customer.shippingFirstName ?? customer.firstName ?? '',
      customer.shippingLastName ?? customer.lastName ?? '',
      customer.shippingCompany ?? customer.company ?? '',
      customer.shippingPhone ?? customer.phone ?? '',
      customer.shippingAddress ?? customer.address ?? '',
      customer.shippingCity ?? customer.city ?? '',
      customer.shippingZip ?? customer.zip ?? '',
      shipping?.pickupPointId ?? '',
      shipping?.pickupPointName ?? '',
      totalPrice, invoiceNumber, ipAddress ?? '',
    );

    const insertItem = db.prepare(`
      INSERT INTO toneracek_order_items (order_id, sku, name, quantity, price)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insertItem.run(orderId, item.sku ?? '', item.name, item.quantity, item.price);
    }

    // Upsert zákazníka do CRM a propoj s objednávkou (nekritické)
    try {
      const { contactId, companyId } = upsertCustomerToCRM(db, {
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        company: customer.company,
        phone: customer.phone,
        city: customer.city,
        country: customer.stat || 'Česká republika',
        isRegistered: b.isRegistered ?? false,
      });
      if (contactId || companyId) {
        db.prepare(
          `UPDATE toneracek_orders SET crm_contact_id = ?, crm_company_id = ? WHERE id = ?`
        ).run(contactId || null, companyId || null, orderId);
      }
    } catch (err) {
      fastify.log.warn({ err }, 'CRM upsert selhal (nekritické)');
    }

    return reply.send({ orderId, orderNumber, invoiceNumber });
  });

  // ── API: Aktualizace trackingu ─────────────────────────────

  fastify.patch('/api/toneracek/orders/:id/tracking', async (request, reply) => {
    if (!verifyApiKey(request)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { trackingNumber, labelUrl } = request.body ?? {};
    const db = getAppDb();
    const result = db.prepare(
      `UPDATE toneracek_orders SET tracking_number = ?, label_url = ?, modified_at = datetime('now') WHERE id = ?`
    ).run(trackingNumber ?? '', labelUrl ?? '', request.params.id);

    if (result.changes === 0) return reply.code(404).send({ error: 'Objednávka nenalezena' });
    return reply.send({ ok: true });
  });

  // ── Admin: Seznam objednávek ───────────────────────────────

  fastify.get('/toneracek/objednavky', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const db = getAppDb();

    const q = (request.query.q || '').trim();
    const statusFilter = (request.query.status || '').trim();
    const page = Math.max(1, parseInt(request.query.page || '1', 10));
    const perPage = 25;
    const offset = (page - 1) * perPage;

    let where = '1=1';
    const params = [];

    if (q) {
      where += ` AND (
        CAST(order_number AS TEXT) LIKE ? OR
        first_name LIKE ? OR last_name LIKE ? OR
        email LIKE ? OR phone LIKE ? OR
        invoice_number LIKE ?
      )`;
      const like = `%${q}%`;
      params.push(like, like, like, like, like, like);
    }
    if (statusFilter) {
      where += ' AND status = ?';
      params.push(statusFilter);
    }

    const total = db.prepare(`SELECT COUNT(*) as n FROM toneracek_orders WHERE ${where}`).get(...params).n;
    const orders = db.prepare(
      `SELECT * FROM toneracek_orders WHERE ${where} ORDER BY order_number DESC LIMIT ? OFFSET ?`
    ).all(...params, perPage, offset);

    const statusCounts = db.prepare(
      'SELECT status, COUNT(*) as n FROM toneracek_orders GROUP BY status'
    ).all();

    return reply.view('pages/toneracek/orders.ejs', {
      pageTitle: 'Toneráček – Objednávky',
      currentPath: '/toneracek/objednavky',
      user: request.user,
      orders,
      total,
      currentPage: page,
      totalPages: Math.ceil(total / perPage),
      q,
      statusFilter,
      statusCounts,
      ORDER_STATUSES,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Admin: Detail objednávky ───────────────────────────────

  fastify.get('/toneracek/objednavky/:id', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const db = getAppDb();

    const order = db.prepare('SELECT * FROM toneracek_orders WHERE id = ?').get(request.params.id);
    if (!order) return reply.code(404).send('Objednávka nenalezena');

    const items = db.prepare('SELECT * FROM toneracek_order_items WHERE order_id = ?').all(order.id);

    return reply.view('pages/toneracek/order-detail.ejs', {
      pageTitle: `Objednávka #${order.order_number}`,
      currentPath: '/toneracek/objednavky',
      user: request.user,
      order,
      items,
      ORDER_STATUSES,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Admin: Změna stavu ─────────────────────────────────────

  fastify.post('/toneracek/objednavky/:id/stav', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const db = getAppDb();

    const { status, send_email } = request.body ?? {};
    if (!ORDER_STATUSES.includes(status)) {
      return reply.code(400).send('Neplatný stav');
    }

    const order = db.prepare('SELECT * FROM toneracek_orders WHERE id = ?').get(request.params.id);
    if (!order) return reply.code(404).send('Objednávka nenalezena');

    db.prepare(
      `UPDATE toneracek_orders SET status = ?, modified_at = datetime('now') WHERE id = ?`
    ).run(status, order.id);

    if (send_email === 'on' || send_email === '1' || send_email === true) {
      try {
        await sendOrderStatusEmail({
          orderNumber: order.order_number,
          email: order.email,
          customerName: `${order.first_name} ${order.last_name}`.trim() || 'zákazníku',
          status,
          trackingNumber: order.tracking_number || undefined,
        });
      } catch (err) {
        fastify.log.error({ err }, 'Chyba při odesílání emailu o stavu objednávky');
      }
    }

    return reply.redirect(`/toneracek/objednavky/${order.id}`);
  });

  // ── Admin: Uložení poznámky ────────────────────────────────

  fastify.post('/toneracek/objednavky/:id/poznamka', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const db = getAppDb();

    const { notes } = request.body ?? {};
    db.prepare(
      `UPDATE toneracek_orders SET notes = ?, modified_at = datetime('now') WHERE id = ?`
    ).run(notes ?? '', request.params.id);

    return reply.redirect(`/toneracek/objednavky/${request.params.id}`);
  });

  // ── Admin: Migrace z Airtable (jednorázová) ───────────────

  fastify.get('/toneracek/migrace', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');
    return reply.view('pages/toneracek/migrace.ejs', {
      pageTitle: 'Migrace z Airtable',
      currentPath: '/toneracek/objednavky',
      user: request.user,
      result: null,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/toneracek/migrace', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');

    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return reply.view('pages/toneracek/migrace.ejs', {
        pageTitle: 'Migrace z Airtable',
        currentPath: '/toneracek/objednavky',
        user: request.user,
        result: { error: 'Chybí AIRTABLE_API_KEY nebo AIRTABLE_BASE_ID v prostředí.' },
      }, { layout: 'layouts/base.ejs' });
    }

    const AT_ORDERS    = 'tblhP8tvVl0KdJQeR';
    const AT_ITEMS     = 'tblqjU6x9KTGEH7YW';
    const AT_CUSTOMERS = 'tblk6MpLpLpe7wTq7'; // tabulka Uzivatele
    const FC = {
      email:        'fldalJniBJAO6SSFB',
      orderLinks:   'fldiTbjYcUsE0e5d2',
      isRegistered: 'fldRegistrace',  // "Registrovaný" / "Neregistrovaný"
      firstName:    'fldJmeno',
      lastName:     'fldPrijmeni',
      phone:        'fldTelefon',
      company:      'fldFirma',
    };
    const F = {
      orderNumber: 'fldrpOS8rh4zFuQhf', createdAt: 'fldBoq3y26qLLmFmf',
      status: 'fldqYJ0WgbNktvodr', firstName: 'fldSXFWeGZWP5p78m',
      lastName: 'fldHWnihHavgvzd7C', company: 'fld0baVKNA2s8Ew30',
      phone: 'fldM1HKgq9JG7z1Qv', address: 'fldRPHZNBLGIYctDq',
      city: 'fldz9ziSCPL4nhyRN', zip: 'fldNgmNrv1cwC2j4A',
      ipAddress: 'fldFT6kBX0IFpKf7F', shippingMethod: 'fld8Q8OjYH7vtGmK6',
      paymentMethod: 'fldfS6nqK4WallV4P', shippingFirstName: 'fld4IdoOPmcyrhp5L',
      shippingLastName: 'fld2sRyKXxE72cHM8', shippingCompany: 'fldeUtp0EUC74ycKf',
      shippingPhone: 'fldsWCHPNEkxI185x', shippingAddress: 'fldDi1E3Zc8PTyRnu',
      shippingCity: 'fldGluke3JodUfPc6', shippingZip: 'fldBBzDOdot41I90S',
      totalPrice: 'flds7bIEsbE2cEWWj', pickupPointName: 'fldcrzmuNe6XcYURH',
      pickupPointId: 'fldniFThX5tVAh1aB', trackingNumber: 'fldCZ1TBBTGgBMfVg',
      labelUrl: 'fldIMKECXvDhNCUct',
    };
    const FI = {
      orderLink: 'fldY2RggE06sKFJ8y', name: 'fldvB5z3lFM8JLTQT', quantity: 'fld8hRuAjAkk1VnSL',
    };

    async function fetchAll(table, fieldIds) {
      const records = [];
      let offset;
      do {
        const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table}`);
        url.searchParams.set('returnFieldsByFieldId', 'true');
        url.searchParams.set('pageSize', '100');
        if (offset) url.searchParams.set('offset', offset);
        fieldIds.forEach(f => url.searchParams.append('fields[]', f));
        const res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
        });
        if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
        const data = await res.json();
        records.push(...data.records);
        offset = data.offset;
      } while (offset);
      return records;
    }

    const s = v => { if (!v && v !== 0) return ''; if (Array.isArray(v)) return v.filter(x => typeof x === 'string').join(', '); return String(v); };
    const n = v => { if (typeof v === 'number') return v; if (Array.isArray(v) && typeof v[0] === 'number') return v[0]; return 0; };

    try {
      const [orderRecords, itemRecords] = await Promise.all([
        fetchAll(AT_ORDERS, Object.values(F)),
        fetchAll(AT_ITEMS, Object.values(FI)),
      ]);

      // Mapa order ID → zákazník (tabulka Uzivatele) — selže tiše při 403
      const customerByOrder = {};
      let emailsNote = null;
      try {
        const customerRecords = await fetchAll(AT_CUSTOMERS, Object.values(FC));
        for (const rec of customerRecords) {
          const email = s(rec.fields[FC.email]);
          const links = rec.fields[FC.orderLinks];
          if (!email || !Array.isArray(links)) continue;
          const cust = {
            email,
            isRegistered: s(rec.fields[FC.isRegistered]) === 'Registrovaný',
            firstName: s(rec.fields[FC.firstName]),
            lastName:  s(rec.fields[FC.lastName]),
            phone:     s(rec.fields[FC.phone]),
            company:   s(rec.fields[FC.company]),
          };
          for (const orderId of links) customerByOrder[orderId] = cust;
        }
      } catch (err) {
        emailsNote = `Emaily zákazníků nebyly načteny (${err.message}). Přidej tabulce Uzivatele práva pro API token.`;
        fastify.log.warn(emailsNote);
      }

      const itemsByOrder = {};
      for (const rec of itemRecords) {
        const links = rec.fields[FI.orderLink];
        const orderId = Array.isArray(links) ? links[0] : links;
        if (!orderId) continue;
        if (!itemsByOrder[orderId]) itemsByOrder[orderId] = [];
        itemsByOrder[orderId].push({ name: s(rec.fields[FI.name]), quantity: n(rec.fields[FI.quantity]) || 1 });
      }

      const db = getAppDb();
      const insertOrder = db.prepare(`
        INSERT OR IGNORE INTO toneracek_orders (
          id, order_number, status, payment_method, shipping_method,
          first_name, last_name, company, email, phone, address, city, zip,
          shipping_first_name, shipping_last_name, shipping_company,
          shipping_phone, shipping_address, shipping_city, shipping_zip,
          pickup_point_id, pickup_point_name, total_price, invoice_number,
          tracking_number, label_url, ip_address, created_at, modified_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      const insertItem = db.prepare(`
        INSERT INTO toneracek_order_items (order_id, sku, name, quantity, price)
        VALUES (?, '', ?, ?, 0)
      `);

      const stats = { imported: 0, skipped: 0, items: 0, contacts: 0 };

      const migrate = db.transaction(() => {
        for (const rec of orderRecords) {
          const f = rec.fields;
          const atId = rec.id;
          const orderNum = n(f[F.orderNumber]);
          if (!orderNum) { stats.skipped++; continue; }

          const exists = db.prepare('SELECT id FROM toneracek_orders WHERE id = ? OR order_number = ?').get(atId, orderNum);
          if (exists) { stats.skipped++; continue; }

          const cust = customerByOrder[atId] || null;
          const email = cust?.email || '';
          const createdAt = s(f[F.createdAt]) || new Date().toISOString();
          const year = new Date(createdAt).getFullYear();

          insertOrder.run(
            atId, orderNum, s(f[F.status]) || 'Přijata', s(f[F.paymentMethod]), s(f[F.shippingMethod]) || 'Zásilkovna',
            s(f[F.firstName]), s(f[F.lastName]), s(f[F.company]), email, s(f[F.phone]),
            s(f[F.address]), s(f[F.city]), s(f[F.zip]),
            s(f[F.shippingFirstName]) || s(f[F.firstName]), s(f[F.shippingLastName]) || s(f[F.lastName]),
            s(f[F.shippingCompany]) || s(f[F.company]), s(f[F.shippingPhone]) || s(f[F.phone]),
            s(f[F.shippingAddress]) || s(f[F.address]), s(f[F.shippingCity]) || s(f[F.city]),
            s(f[F.shippingZip]) || s(f[F.zip]),
            s(f[F.pickupPointId]), s(f[F.pickupPointName]),
            n(f[F.totalPrice]), `FV-${year}-${orderNum}`,
            s(f[F.trackingNumber]), s(f[F.labelUrl]), s(f[F.ipAddress]),
            createdAt, createdAt,
          );

          for (const item of (itemsByOrder[atId] || [])) {
            insertItem.run(atId, item.name, item.quantity);
            stats.items++;
          }

          if (email) {
            try {
              const { contactId, companyId } = upsertCustomerToCRM(db, {
                email,
                firstName:    cust?.firstName || s(f[F.firstName]),
                lastName:     cust?.lastName  || s(f[F.lastName]),
                company:      cust?.company   || s(f[F.company]),
                phone:        cust?.phone     || s(f[F.phone]),
                city:         s(f[F.city]),
                country:      'Česká republika',
                isRegistered: cust?.isRegistered ?? false,
              });
              if (contactId || companyId) {
                db.prepare(`UPDATE toneracek_orders SET crm_contact_id = ?, crm_company_id = ? WHERE id = ?`).run(contactId || null, companyId || null, atId);
              }
              stats.contacts++;
            } catch {}
          }

          stats.imported++;
        }
      });

      migrate();

      fastify.log.info(stats, 'Airtable migrace dokončena');
      return reply.view('pages/toneracek/migrace.ejs', {
        pageTitle: 'Migrace z Airtable',
        currentPath: '/toneracek/objednavky',
        user: request.user,
        result: { ...stats, total: orderRecords.length, totalItems: itemRecords.length, emailsNote },
      }, { layout: 'layouts/base.ejs' });

    } catch (err) {
      fastify.log.error({ err }, 'Airtable migrace selhala');
      return reply.view('pages/toneracek/migrace.ejs', {
        pageTitle: 'Migrace z Airtable',
        currentPath: '/toneracek/objednavky',
        user: request.user,
        result: { error: err.message },
      }, { layout: 'layouts/base.ejs' });
    }
  });
}
