import { getDb, generateId } from '../db.js';

// ── Ověření API klíče ────────────────────────────────────────

async function verifyApiKey(request) {
  const key = (request.headers['x-api-key'] || '').trim();
  if (!key) return null;
  const sql = getDb();
  const rows = await sql`
    SELECT k.shop_id, s.slug AS shop_id_slug, s.name AS shop_name
    FROM api_keys k
    JOIN shops s ON k.shop_id = s.id
    WHERE k.key = ${key} AND k.active = TRUE
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ── CRM upsert ───────────────────────────────────────────────

async function upsertCustomerToCRM(sql, { email, firstName, lastName, company, phone, city, country, isRegistered, shopName }) {
  if (!email) return { contactId: null, companyId: null };

  let companyId = null;
  if (company?.trim()) {
    const [existing] = await sql`SELECT id FROM crm_companies WHERE name = ${company.trim()} LIMIT 1`;
    if (existing) {
      companyId = existing.id;
    } else {
      companyId = generateId();
      await sql`
        INSERT INTO crm_companies (id, name, company_type, city, country)
        VALUES (${companyId}, ${company.trim()}, 'Zákazník', ${city||''}, ${country||''})
      `;
    }
  }

  const isReg = !!isRegistered;
  const [existing] = await sql`SELECT id, is_registered FROM crm_contacts WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;

  let contactId;
  if (existing) {
    await sql`
      UPDATE crm_contacts SET
        first_name   = ${firstName||''},
        last_name    = ${lastName ||''},
        phone        = ${phone    ||''},
        company_id   = COALESCE(company_id, ${companyId}),
        is_registered = ${existing.is_registered || isReg},
        modified_at  = NOW()
      WHERE id = ${existing.id}
    `;
    contactId = existing.id;
  } else {
    contactId = generateId();
    await sql`
      INSERT INTO crm_contacts
        (id, first_name, last_name, email, phone, company_id, is_registered, notes)
      VALUES
        (${contactId}, ${firstName||''}, ${lastName||''}, ${email},
         ${phone||''}, ${companyId}, ${isReg}, ${`Zákazník ${shopName}`})
    `;
  }

  return { contactId, companyId };
}

// ── Swagger schémata ─────────────────────────────────────────

const customerSchema = {
  type: 'object', required: ['email'],
  properties: {
    email:     { type: 'string', format: 'email' },
    firstName: { type: 'string' }, lastName: { type: 'string' },
    phone:     { type: 'string' }, company:  { type: 'string' },
    ic:        { type: 'string' }, dic:      { type: 'string' },
    address:   { type: 'string' }, city:     { type: 'string' },
    zip:       { type: 'string' }, country:  { type: 'string', default: 'Česká republika' },
  },
};

const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

// ── Plugin ───────────────────────────────────────────────────

export default async function apiRoutes(fastify) {
  const sql = getDb();

  // ── POST /api/v1/orders ───────────────────────────────────

  fastify.post('/api/v1/orders', {
    schema: {
      summary: 'Vytvořit objednávku',
      description: 'Přijme novou objednávku z eshopu. Automaticky propojí zákazníka s CRM.',
      tags: ['Objednávky'], security: [{ apiKey: [] }],
      body: {
        type: 'object', required: ['customer', 'items', 'totalPrice'],
        properties: {
          customer:      { ...customerSchema, description: 'Fakturační adresa' },
          shipping: {
            type: 'object',
            properties: {
              method: { type: 'string' }, firstName: { type: 'string' },
              lastName: { type: 'string' }, company: { type: 'string' },
              phone: { type: 'string' }, address: { type: 'string' },
              city: { type: 'string' }, zip: { type: 'string' },
              pickupPointId: { type: 'string' }, pickupPointName: { type: 'string' },
            },
          },
          paymentMethod: { type: 'string' },
          currency:      { type: 'string', default: 'CZK' },
          totalPrice:    { type: 'number' },
          items: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', required: ['name', 'quantity', 'price'],
              properties: {
                sku: { type: 'string' }, name: { type: 'string' },
                quantity: { type: 'integer', minimum: 1 },
                price: { type: 'number' }, productId: { type: 'string' },
              },
            },
          },
          isRegistered:  { type: 'boolean', default: false },
          orderNumber:   { type: 'string' },
          ipAddress:     { type: 'string' },
          notes:         { type: 'string' },
        },
      },
      response: {
        201: { type: 'object', properties: { orderId: { type: 'string' }, orderNumber: { type: 'string' }, sourceShop: { type: 'string' }, invoiceNumber: { type: 'string' } } },
        400: errorSchema, 401: errorSchema,
      },
    },
  }, async (request, reply) => {
    const shop = await verifyApiKey(request);
    if (!shop) return reply.code(401).send({ error: 'Unauthorized — použijte platný X-API-Key' });

    const b = request.body;
    if (!b.customer?.email) return reply.code(400).send({ error: 'customer.email je povinný' });
    if (!b.items?.length)   return reply.code(400).send({ error: 'items nesmí být prázdné' });

    const { customer, shipping, items } = b;

    let orderNumber = b.orderNumber;
    if (!orderNumber) {
      const [last] = await sql`
        SELECT order_number FROM shop_orders WHERE shop_id = ${shop.shop_id}
        ORDER BY CAST(order_number AS INTEGER) DESC LIMIT 1
      `;
      orderNumber = last ? String(parseInt(last.order_number, 10) + 1) : '1';
    }

    const now = new Date();
    const invoiceNumber = `${shop.shop_id_slug.toUpperCase()}-${now.getFullYear()}-${orderNumber}`;
    const orderId = generateId();

    await sql`
      INSERT INTO shop_orders (
        id, shop_id, order_number, status, payment_method, shipping_method, currency,
        first_name, last_name, company, ic, dic,
        email, phone, address, city, zip, country,
        shipping_first_name, shipping_last_name, shipping_company,
        shipping_phone, shipping_address, shipping_city, shipping_zip,
        pickup_point_id, pickup_point_name,
        total_price, invoice_number, ip_address, notes
      ) VALUES (
        ${orderId}, ${shop.shop_id}, ${orderNumber}, 'Nová',
        ${b.paymentMethod??''}, ${shipping?.method??''}, ${b.currency??'CZK'},
        ${customer.firstName??''}, ${customer.lastName??''},
        ${customer.company??''}, ${customer.ic??''}, ${customer.dic??''},
        ${customer.email}, ${customer.phone??''},
        ${customer.address??''}, ${customer.city??''}, ${customer.zip??''},
        ${customer.country??'Česká republika'},
        ${shipping?.firstName??customer.firstName??''},
        ${shipping?.lastName ??customer.lastName ??''},
        ${shipping?.company  ??customer.company  ??''},
        ${shipping?.phone    ??customer.phone    ??''},
        ${shipping?.address  ??customer.address  ??''},
        ${shipping?.city     ??customer.city     ??''},
        ${shipping?.zip      ??customer.zip      ??''},
        ${shipping?.pickupPointId  ??''},
        ${shipping?.pickupPointName??''},
        ${b.totalPrice}, ${invoiceNumber}, ${b.ipAddress??''}, ${b.notes??''}
      )
    `;

    for (const item of items) {
      await sql`
        INSERT INTO shop_order_items (order_id, sku, name, quantity, price, product_id)
        VALUES (${orderId}, ${item.sku??''}, ${item.name}, ${item.quantity}, ${item.price}, ${item.productId??null})
      `;
    }

    try {
      const { contactId, companyId } = await upsertCustomerToCRM(sql, {
        email: customer.email, firstName: customer.firstName, lastName: customer.lastName,
        company: customer.company, phone: customer.phone, city: customer.city,
        country: customer.country||'Česká republika',
        isRegistered: b.isRegistered??false, shopName: shop.shop_name,
      });
      if (contactId || companyId) {
        await sql`UPDATE shop_orders SET crm_contact_id = ${contactId??null}, crm_company_id = ${companyId??null} WHERE id = ${orderId}`;
      }
    } catch (err) {
      fastify.log.warn({ err }, 'CRM upsert selhal (nekritické)');
    }

    return reply.code(201).send({ orderId, orderNumber, sourceShop: shop.shop_id_slug, invoiceNumber });
  });

  // ── GET /api/v1/orders ────────────────────────────────────

  fastify.get('/api/v1/orders', {
    schema: {
      summary: 'Seznam objednávek eshopu', tags: ['Objednávky'], security: [{ apiKey: [] }],
      querystring: {
        type: 'object',
        properties: { email: { type: 'string' }, limit: { type: 'integer', default: 50 } },
      },
    },
  }, async (request, reply) => {
    const shop = await verifyApiKey(request);
    if (!shop) return reply.code(401).send({ error: 'Unauthorized' });

    const email = (request.query.email || '').trim().toLowerCase();
    const limit = request.query.limit ?? 50;
    const conditions = [sql`shop_id = ${shop.shop_id}`];
    if (email) conditions.push(sql`LOWER(email) = ${email}`);
    const where = sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`;

    const orders = await sql`SELECT * FROM shop_orders ${where} ORDER BY created_at DESC LIMIT ${limit}`;
    const result = await Promise.all(orders.map(async o => {
      const items = await sql`SELECT sku, name, quantity, price FROM shop_order_items WHERE order_id = ${o.id}`;
      return { ...o, items };
    }));
    return reply.send({ orders: result });
  });

  // ── GET /api/v1/orders/:id ────────────────────────────────

  fastify.get('/api/v1/orders/:id', {
    schema: { summary: 'Detail objednávky', tags: ['Objednávky'], security: [{ apiKey: [] }] },
  }, async (request, reply) => {
    const shop = await verifyApiKey(request);
    if (!shop) return reply.code(401).send({ error: 'Unauthorized' });
    const [order] = await sql`SELECT * FROM shop_orders WHERE id = ${request.params.id} AND shop_id = ${shop.shop_id}`;
    if (!order) return reply.code(404).send({ error: 'Objednávka nenalezena' });
    const items = await sql`SELECT * FROM shop_order_items WHERE order_id = ${order.id}`;
    return reply.send({ order: { ...order, items } });
  });

  // ── PATCH /api/v1/orders/:id/status ──────────────────────

  fastify.patch('/api/v1/orders/:id/status', {
    schema: {
      summary: 'Aktualizovat stav objednávky', tags: ['Objednávky'], security: [{ apiKey: [] }],
      body: {
        type: 'object', required: ['status'],
        properties: {
          status: { type: 'string' }, trackingNumber: { type: 'string' }, labelUrl: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const shop = await verifyApiKey(request);
    if (!shop) return reply.code(401).send({ error: 'Unauthorized' });

    const { status, trackingNumber, labelUrl } = request.body;
    const sets = [sql`status = ${status}`, sql`modified_at = NOW()`];
    if (trackingNumber !== undefined) sets.push(sql`tracking_number = ${trackingNumber}`);
    if (labelUrl !== undefined)       sets.push(sql`label_url = ${labelUrl}`);

    const result = await sql`
      UPDATE shop_orders SET ${sets.reduce((a, b) => sql`${a}, ${b}`)}
      WHERE id = ${request.params.id} AND shop_id = ${shop.shop_id}
    `;
    if (result.count === 0) return reply.code(404).send({ error: 'Objednávka nenalezena' });
    return reply.send({ ok: true });
  });

  // ── POST /api/v1/customers ────────────────────────────────

  fastify.post('/api/v1/customers', {
    schema: {
      summary: 'Registrovat zákazníka', tags: ['Zákazníci'], security: [{ apiKey: [] }],
      body: {
        type: 'object', required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
          firstName: { type: 'string' }, lastName: { type: 'string' },
          phone: { type: 'string' }, company: { type: 'string' },
          address: { type: 'string' }, city: { type: 'string' }, zip: { type: 'string' },
          marketingConsent: { type: 'boolean', default: false },
          notificationsConsent: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    const shop = await verifyApiKey(request);
    if (!shop) return reply.code(401).send({ error: 'Unauthorized' });

    const b = request.body;
    const email = b.email.toLowerCase();
    const [existing] = await sql`SELECT id FROM crm_contacts WHERE LOWER(email) = ${email} LIMIT 1`;

    if (existing) {
      const sets = [sql`is_registered = TRUE`, sql`modified_at = NOW()`];
      if (b.firstName !== undefined)            sets.push(sql`first_name = ${b.firstName}`);
      if (b.lastName !== undefined)             sets.push(sql`last_name = ${b.lastName}`);
      if (b.phone !== undefined)                sets.push(sql`phone = ${b.phone}`);
      if (b.address !== undefined)              sets.push(sql`address = ${b.address}`);
      if (b.city !== undefined)                 sets.push(sql`city = ${b.city}`);
      if (b.zip !== undefined)                  sets.push(sql`zip = ${b.zip}`);
      if (b.marketingConsent !== undefined)     sets.push(sql`marketing_consent = ${!!b.marketingConsent}`);
      if (b.notificationsConsent !== undefined) sets.push(sql`notifications_consent = ${!!b.notificationsConsent}`);
      await sql`UPDATE crm_contacts SET ${sets.reduce((a, b) => sql`${a}, ${b}`)} WHERE id = ${existing.id}`;
      const [row] = await sql`SELECT * FROM crm_contacts WHERE id = ${existing.id}`;
      return reply.send(_mapContact(row));
    }

    const id = generateId();
    await sql`
      INSERT INTO crm_contacts
        (id, first_name, last_name, email, phone, company_name, address, city, zip,
         marketing_consent, notifications_consent, is_registered, active, notes)
      VALUES (${id}, ${b.firstName??''}, ${b.lastName??''}, ${email}, ${b.phone??''},
              ${b.company??''}, ${b.address??''}, ${b.city??''}, ${b.zip??''},
              ${!!b.marketingConsent}, ${!!b.notificationsConsent},
              TRUE, TRUE, ${`Zákazník ${shop.shop_name}`})
    `;
    const [row] = await sql`SELECT * FROM crm_contacts WHERE id = ${id}`;
    return reply.code(201).send(_mapContact(row));
  });

  // ── GET /api/v1/customers ─────────────────────────────────

  fastify.get('/api/v1/customers', {
    schema: {
      summary: 'Vyhledat zákazníka dle e-mailu', tags: ['Zákazníci'], security: [{ apiKey: [] }],
      querystring: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const shop = await verifyApiKey(request);
    if (!shop) return reply.code(401).send({ error: 'Unauthorized' });
    const email = (request.query.email || '').trim().toLowerCase();
    if (!email) return reply.code(400).send({ error: 'email je povinný' });
    const [row] = await sql`SELECT * FROM crm_contacts WHERE LOWER(email) = ${email} LIMIT 1`;
    if (!row) return reply.code(404).send({ error: 'Zákazník nenalezen' });
    return reply.send(_mapContact(row));
  });

  // ── GET /api/v1/customers/:id ─────────────────────────────

  fastify.get('/api/v1/customers/:id', {
    schema: { summary: 'Detail zákazníka', tags: ['Zákazníci'], security: [{ apiKey: [] }] },
  }, async (request, reply) => {
    const shop = await verifyApiKey(request);
    if (!shop) return reply.code(401).send({ error: 'Unauthorized' });
    const [row] = await sql`SELECT * FROM crm_contacts WHERE id = ${request.params.id} LIMIT 1`;
    if (!row) return reply.code(404).send({ error: 'Zákazník nenalezen' });
    return reply.send(_mapContact(row));
  });

  // ── PATCH /api/v1/customers/:id ───────────────────────────

  fastify.patch('/api/v1/customers/:id', {
    schema: { summary: 'Aktualizovat zákazníka', tags: ['Zákazníci'], security: [{ apiKey: [] }] },
  }, async (request, reply) => {
    const shop = await verifyApiKey(request);
    if (!shop) return reply.code(401).send({ error: 'Unauthorized' });

    const b = request.body || {};
    const sets = [sql`modified_at = NOW()`];
    if (b.firstName !== undefined)            sets.push(sql`first_name = ${b.firstName}`);
    if (b.lastName !== undefined)             sets.push(sql`last_name = ${b.lastName}`);
    if (b.phone !== undefined)                sets.push(sql`phone = ${b.phone}`);
    if (b.company !== undefined)              sets.push(sql`company_name = ${b.company}`);
    if (b.address !== undefined)              sets.push(sql`address = ${b.address}`);
    if (b.city !== undefined)                 sets.push(sql`city = ${b.city}`);
    if (b.zip !== undefined)                  sets.push(sql`zip = ${b.zip}`);
    if (b.marketingConsent !== undefined)     sets.push(sql`marketing_consent = ${!!b.marketingConsent}`);
    if (b.notificationsConsent !== undefined) sets.push(sql`notifications_consent = ${!!b.notificationsConsent}`);
    if (b.lastLogin !== undefined)            sets.push(sql`last_login = ${b.lastLogin}`);

    const result = await sql`
      UPDATE crm_contacts SET ${sets.reduce((a, b) => sql`${a}, ${b}`)} WHERE id = ${request.params.id}
    `;
    if (result.count === 0) return reply.code(404).send({ error: 'Zákazník nenalezen' });
    const [row] = await sql`SELECT * FROM crm_contacts WHERE id = ${request.params.id}`;
    return reply.send(_mapContact(row));
  });
}

function _mapContact(row) {
  return {
    id:                   row.id,
    email:                row.email,
    firstName:            row.first_name,
    lastName:             row.last_name,
    phone:                row.phone || '',
    company:              row.company_name || '',
    address:              row.address || '',
    city:                 row.city || '',
    zip:                  row.zip || '',
    isRegistered:         !!row.is_registered,
    active:               row.active !== false,
    marketingConsent:     !!row.marketing_consent,
    notificationsConsent: !!row.notifications_consent,
    lastLogin:            row.last_login || null,
    createdAt:            row.created_at,
  };
}
