import { getDb, generateId } from '../db.js';
import { sendOrderStatusEmail } from '../email.js';

const ORDER_STATUSES = ['Přijata', 'Ve zpracování', 'Vyřízena', 'Stornována'];

const PAYMENT_LABELS = {
  card: 'Platba kartou',
  transfer: 'Bankovní převod',
  cod: 'Dobírka',
};

// ── CRM upsert zákazníka ──────────────────────────────────────

async function upsertCustomerToCRM(sql, { email, firstName, lastName, company, phone, city, country, isRegistered }) {
  if (!email) return { contactId: null, companyId: null };

  let companyId = null;
  if (company?.trim()) {
    const existing = await sql`SELECT id FROM crm_companies WHERE name = ${company.trim()} LIMIT 1`;
    if (existing[0]) {
      companyId = existing[0].id;
    } else {
      companyId = generateId();
      await sql`
        INSERT INTO crm_companies (id, name, company_type, city, country)
        VALUES (${companyId}, ${company.trim()}, 'Zákazník', ${city||''}, ${country||''})
      `;
    }
  }

  const isReg = isRegistered ? true : false;
  const existing = await sql`SELECT id, is_registered FROM crm_contacts WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;

  let contactId;
  if (existing[0]) {
    const newIsReg = existing[0].is_registered || isReg;
    await sql`
      UPDATE crm_contacts SET
        first_name   = ${firstName || ''},
        last_name    = ${lastName  || ''},
        phone        = ${phone     || ''},
        company_id   = COALESCE(company_id, ${companyId}),
        is_registered = ${newIsReg},
        modified_at  = NOW()
      WHERE id = ${existing[0].id}
    `;
    contactId = existing[0].id;
  } else {
    contactId = generateId();
    await sql`
      INSERT INTO crm_contacts
        (id, first_name, last_name, email, phone, company_id, is_registered, notes)
      VALUES
        (${contactId}, ${firstName||''}, ${lastName||''}, ${email},
         ${phone||''}, ${companyId}, ${isReg}, 'Zákazník Toneráček.cz')
    `;
  }

  return { contactId, companyId };
}

// ── Ověření API klíče (Toneráček — env var Bearer) ───────────

function verifyApiKey(request) {
  const auth = request.headers['authorization'] || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const expected = process.env.TONERACEK_API_KEY;
  return expected && key === expected;
}

// ── Helper: toneráček shop_id ─────────────────────────────────

async function getToneracekShopId(sql) {
  const rows = await sql`SELECT id FROM shops WHERE slug = 'toneracek' LIMIT 1`;
  return rows[0]?.id ?? null;
}

export default async function toneracekRoutes(fastify) {
  const sql = getDb();

  // ── Helpers ────────────────────────────────────────────────

  function mapContact(row) {
    return {
      id:               row.id,
      email:            row.email,
      jmeno:            row.first_name,
      prijmeni:         row.last_name,
      telefon:          row.phone || '',
      firma:            row.company_name || '',
      ulice:            row.address || '',
      mesto:            row.city || '',
      psc:              row.zip || '',
      datumRegistrace:  row.created_at,
      souhlasMarketing: !!row.marketing_consent,
      souhlasNotifikace:!!row.notifications_consent,
      aktivni:          row.active !== false,
      poznamka:         row.notes || null,
    };
  }

  // ── API: Uživatelé (zákazníci Toneráček) ───────────────────

  fastify.get('/api/toneracek/users', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const email = (request.query.email || '').trim().toLowerCase();
    if (!email) return reply.code(400).send({ error: 'email required' });

    const rows = await sql`
      SELECT * FROM crm_contacts
      WHERE LOWER(email) = ${email} AND is_registered = TRUE
      LIMIT 1
    `;
    if (!rows[0]) return reply.code(404).send({ error: 'Not found' });
    return reply.send(mapContact(rows[0]));
  });

  fastify.get('/api/toneracek/users/:id', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const rows = await sql`
      SELECT * FROM crm_contacts WHERE id = ${request.params.id} AND is_registered = TRUE LIMIT 1
    `;
    if (!rows[0]) return reply.code(404).send({ error: 'Not found' });
    return reply.send(mapContact(rows[0]));
  });

  fastify.post('/api/toneracek/users', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const b = request.body;
    if (!b?.email) return reply.code(400).send({ error: 'email required' });

    const email = b.email.toLowerCase();
    const existing = await sql`SELECT id FROM crm_contacts WHERE LOWER(email) = ${email} LIMIT 1`;
    if (existing[0]) return reply.code(409).send({ error: 'Účet s tímto e-mailem již existuje' });

    const id = generateId();
    await sql`
      INSERT INTO crm_contacts
        (id, first_name, last_name, email, phone, company_name, address, city, zip,
         marketing_consent, is_registered, active, notes)
      VALUES (${id}, ${b.jmeno||''}, ${b.prijmeni||''}, ${email}, ${b.telefon||''},
              ${b.firma||''}, ${b.ulice||''}, ${b.mesto||''}, ${b.psc||''},
              ${b.souhlasMarketing ? true : false}, TRUE, TRUE, 'Zákazník Toneráček.cz')
    `;
    const [row] = await sql`SELECT * FROM crm_contacts WHERE id = ${id}`;
    return reply.code(201).send(mapContact(row));
  });

  fastify.patch('/api/toneracek/users/:id', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const b = request.body || {};

    const sets = [];
    if (b.jmeno       !== undefined) sets.push(sql`first_name = ${b.jmeno}`);
    if (b.prijmeni    !== undefined) sets.push(sql`last_name = ${b.prijmeni}`);
    if (b.telefon     !== undefined) sets.push(sql`phone = ${b.telefon}`);
    if (b.firma       !== undefined) sets.push(sql`company_name = ${b.firma}`);
    if (b.ulice       !== undefined) sets.push(sql`address = ${b.ulice}`);
    if (b.mesto       !== undefined) sets.push(sql`city = ${b.mesto}`);
    if (b.psc         !== undefined) sets.push(sql`zip = ${b.psc}`);
    if (b.souhlasMarketing  !== undefined) sets.push(sql`marketing_consent = ${!!b.souhlasMarketing}`);
    if (b.souhlasNotifikace !== undefined) sets.push(sql`notifications_consent = ${!!b.souhlasNotifikace}`);
    if (b.posledniPrihlaseni !== undefined) sets.push(sql`last_login = ${b.posledniPrihlaseni}`);
    if (b.poznamka    !== undefined) sets.push(sql`notes = ${b.poznamka}`);

    if (sets.length === 0) {
      const [row] = await sql`SELECT * FROM crm_contacts WHERE id = ${request.params.id}`;
      return reply.send(mapContact(row));
    }

    sets.push(sql`modified_at = NOW()`);
    const setClause = sets.reduce((a, b) => sql`${a}, ${b}`);
    const result = await sql`
      UPDATE crm_contacts SET ${setClause}
      WHERE id = ${request.params.id} AND is_registered = TRUE
    `;
    if (result.count === 0) return reply.code(404).send({ error: 'Not found' });
    const [row] = await sql`SELECT * FROM crm_contacts WHERE id = ${request.params.id}`;
    return reply.send(mapContact(row));
  });

  // ── API: Dotazy na objednávky ──────────────────────────────

  fastify.get('/api/toneracek/orders', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const email = (request.query.email || '').trim().toLowerCase();
    if (!email) return reply.code(400).send({ error: 'email required' });

    const shopId = await getToneracekShopId(sql);
    const orders = await sql`
      SELECT * FROM shop_orders
      WHERE shop_id = ${shopId} AND LOWER(email) = ${email}
      ORDER BY created_at DESC LIMIT 50
    `;
    const result = await Promise.all(orders.map(async o => {
      const items = await sql`SELECT name, quantity FROM shop_order_items WHERE order_id = ${o.id}`;
      return { ...o, items };
    }));
    return reply.send({ orders: result });
  });

  fastify.get('/api/toneracek/orders/by-number/:orderNumber', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const orderNumber = request.params.orderNumber;
    const email = (request.query.email || '').trim().toLowerCase();

    const shopId = await getToneracekShopId(sql);
    const [order] = await sql`
      SELECT * FROM shop_orders WHERE shop_id = ${shopId} AND order_number = ${orderNumber} LIMIT 1
    `;
    if (!order) return reply.code(404).send({ error: 'Not found' });
    if (email && order.email.toLowerCase() !== email) return reply.code(403).send({ error: 'Forbidden' });
    const items = await sql`SELECT * FROM shop_order_items WHERE order_id = ${order.id}`;
    return reply.send({ order: { ...order, items } });
  });

  fastify.patch('/api/toneracek/orders/:id/payment-status', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const { status } = request.body || {};
    if (!status) return reply.code(400).send({ error: 'status required' });

    const shopId = await getToneracekShopId(sql);
    const result = await sql`
      UPDATE shop_orders SET status = ${status}, modified_at = NOW()
      WHERE id = ${request.params.id} AND shop_id = ${shopId}
    `;
    if (result.count === 0) return reply.code(404).send({ error: 'Not found' });
    return reply.send({ ok: true });
  });

  // ── API: Příjem nové objednávky z e-shopu ──────────────────

  fastify.post('/api/toneracek/orders', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });

    const b = request.body;
    if (!b?.customer || !b?.items || !b?.totalPrice) {
      return reply.code(400).send({ error: 'Chybí povinná data objednávky' });
    }

    const shopId = await getToneracekShopId(sql);
    if (!shopId) return reply.code(500).send({ error: 'Toneráček shop není nakonfigurován' });

    const { customer, shipping, paymentMethod, items, totalPrice, ipAddress } = b;

    // Číslo objednávky — per-shop sekvence
    const [last] = await sql`
      SELECT order_number FROM shop_orders WHERE shop_id = ${shopId}
      ORDER BY CAST(order_number AS INTEGER) DESC LIMIT 1
    `;
    const orderNumber = last ? String(parseInt(last.order_number, 10) + 1) : '10001';

    const now = new Date();
    const invoiceNumber = `FV-${now.getFullYear()}-${orderNumber}`;
    const orderId = generateId();

    await sql`
      INSERT INTO shop_orders (
        id, shop_id, order_number, status, payment_method, shipping_method,
        first_name, last_name, company, ic, dic,
        email, phone, address, city, zip, country,
        shipping_first_name, shipping_last_name, shipping_company,
        shipping_phone, shipping_address, shipping_city, shipping_zip,
        pickup_point_id, pickup_point_name,
        total_price, invoice_number, ip_address
      ) VALUES (
        ${orderId}, ${shopId}, ${orderNumber}, 'Přijata',
        ${PAYMENT_LABELS[paymentMethod] ?? paymentMethod ?? ''},
        ${shipping?.method ?? 'Zásilkovna'},
        ${customer.firstName??''}, ${customer.lastName??''},
        ${customer.company??''}, ${customer.ic??''}, ${customer.dic??''},
        ${customer.email??''}, ${customer.phone??''},
        ${customer.address??''}, ${customer.city??''}, ${customer.zip??''},
        ${customer.stat??'Česká republika'},
        ${customer.shippingFirstName??customer.firstName??''},
        ${customer.shippingLastName ??customer.lastName ??''},
        ${customer.shippingCompany  ??customer.company  ??''},
        ${customer.shippingPhone    ??customer.phone    ??''},
        ${customer.shippingAddress  ??customer.address  ??''},
        ${customer.shippingCity     ??customer.city     ??''},
        ${customer.shippingZip      ??customer.zip      ??''},
        ${shipping?.pickupPointId   ??''},
        ${shipping?.pickupPointName ??''},
        ${totalPrice}, ${invoiceNumber}, ${ipAddress??''}
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
        country: customer.stat || 'Česká republika', isRegistered: b.isRegistered ?? false,
      });
      if (contactId || companyId) {
        await sql`
          UPDATE shop_orders SET crm_contact_id = ${contactId}, crm_company_id = ${companyId}
          WHERE id = ${orderId}
        `;
      }
    } catch (err) {
      fastify.log.warn({ err }, 'CRM upsert selhal (nekritické)');
    }

    return reply.send({ orderId, orderNumber, invoiceNumber });
  });

  // ── API: Aktualizace trackingu ─────────────────────────────

  fastify.patch('/api/toneracek/orders/:id/tracking', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });

    const { trackingNumber, labelUrl } = request.body ?? {};
    const shopId = await getToneracekShopId(sql);
    const result = await sql`
      UPDATE shop_orders
      SET tracking_number = ${trackingNumber??''}, label_url = ${labelUrl??''}, modified_at = NOW()
      WHERE id = ${request.params.id} AND shop_id = ${shopId}
    `;
    if (result.count === 0) return reply.code(404).send({ error: 'Objednávka nenalezena' });
    return reply.send({ ok: true });
  });

  // ── Admin: Seznam objednávek ───────────────────────────────

  fastify.get('/ucetnictvi/objednavky', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');

    const q            = (request.query.q      || '').trim();
    const statusFilter = (request.query.status || '').trim();
    const page    = Math.max(1, parseInt(request.query.page || '1', 10));
    const perPage = 25;
    const offset  = (page - 1) * perPage;

    const shopId = await getToneracekShopId(sql);

    const conditions = [sql`shop_id = ${shopId}`];
    if (q) conditions.push(sql`(
      order_number ILIKE ${'%'+q+'%'} OR
      first_name ILIKE ${'%'+q+'%'} OR last_name ILIKE ${'%'+q+'%'} OR
      email ILIKE ${'%'+q+'%'} OR phone ILIKE ${'%'+q+'%'} OR
      invoice_number ILIKE ${'%'+q+'%'}
    )`);
    if (statusFilter) conditions.push(sql`status = ${statusFilter}`);

    const where = sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM shop_orders ${where}`;
    const orders      = await sql`
      SELECT * FROM shop_orders ${where}
      ORDER BY created_at DESC LIMIT ${perPage} OFFSET ${offset}
    `;
    const statusCounts = await sql`
      SELECT status, COUNT(*)::int AS n FROM shop_orders WHERE shop_id = ${shopId} GROUP BY status
    `;

    return reply.view('pages/toneracek/orders.ejs', {
      pageTitle: 'Objednávky Toneráček', currentPath: '/ucetnictvi/objednavky',
      user: request.user, orders, total: count,
      currentPage: page, totalPages: Math.ceil(count / perPage),
      q, statusFilter, statusCounts, ORDER_STATUSES,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Admin: Detail objednávky ───────────────────────────────

  fastify.get('/ucetnictvi/objednavky/:id', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const shopId = await getToneracekShopId(sql);
    const [order] = await sql`
      SELECT * FROM shop_orders WHERE id = ${request.params.id} AND shop_id = ${shopId}
    `;
    if (!order) return reply.code(404).send('Objednávka nenalezena');
    const items        = await sql`SELECT * FROM shop_order_items WHERE order_id = ${order.id}`;
    const [invoice]    = await sql`SELECT id, number FROM accounting_invoices WHERE order_id = ${order.id} LIMIT 1`;
    const invoiceSeries = await sql`SELECT id, name FROM invoice_number_series WHERE active = TRUE ORDER BY name`;

    return reply.view('pages/toneracek/order-detail.ejs', {
      pageTitle: `Objednávka #${order.order_number}`,
      currentPath: '/ucetnictvi/objednavky', user: request.user,
      order, items, ORDER_STATUSES, invoice: invoice || null, invoiceSeries,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Admin: Změna stavu ─────────────────────────────────────

  fastify.post('/ucetnictvi/objednavky/:id/stav', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const { status, send_email } = request.body ?? {};
    if (!ORDER_STATUSES.includes(status)) return reply.code(400).send('Neplatný stav');

    const shopId = await getToneracekShopId(sql);
    const [order] = await sql`
      SELECT o.*, s.name AS shop_name
      FROM shop_orders o
      LEFT JOIN shops s ON o.shop_id = s.id
      WHERE o.id = ${request.params.id} AND o.shop_id = ${shopId}
    `;
    if (!order) return reply.code(404).send('Objednávka nenalezena');

    await sql`UPDATE shop_orders SET status = ${status}, modified_at = NOW() WHERE id = ${order.id}`;

    // ── Automatické akce při dokončení ────────────────────────
    if (status === 'dokoncena') {
      try {
        // 1. Auto-generace faktury (pokud ještě neexistuje)
        const [existing] = await sql`SELECT id FROM accounting_invoices WHERE order_id = ${order.id} LIMIT 1`;
        let invoiceId = existing?.id;

        if (!invoiceId) {
          const { generateId, getDb } = await import('../db.js');
          const { renderInvoicePdf } = await import('../pdf.js');
          const { sendInvoiceEmail } = await import('../email.js');

          // Auto-vybrat řadu podle shop_id
          const [series] = await sql`
            SELECT * FROM invoice_number_series
            WHERE shop_id = ${order.shop_id} AND active = TRUE
            LIMIT 1
          `;
          const seriesId = series?.id || null;

          // Číslo faktury
          let number = order.invoice_number || '';
          if (!number && seriesId) {
            const { nextInvoiceNumber } = await import('./invoices.js').then(() => ({})).catch(() => ({}));
            // Inline next number logic
            const [s] = await sql`UPDATE invoice_number_series SET current_number = current_number + 1 WHERE id = ${seriesId} RETURNING *`;
            const n = s.current_number;
            number = `${s.prefix}-${String(n).padStart(s.padding, '0')}`;
          }
          if (!number) number = `FV-${new Date().getFullYear()}-${order.order_number}`;

          const vatRate = 21;
          const totalWithVat = Number(order.total_price);
          const base   = +(totalWithVat / (1 + vatRate / 100)).toFixed(2);
          const vatAmt = +(totalWithVat - base).toFixed(2);

          invoiceId = generateId();
          await sql`
            INSERT INTO accounting_invoices
              (id, type, series_id, number, status,
               shop_id, order_id, crm_contact_id, crm_company_id,
               client_name, client_ico, client_dic, client_address,
               amount, vat_amount, total_amount, currency, issue_date, due_date, notes)
            VALUES (
              ${invoiceId}, 'issued', ${seriesId}, ${number}, 'Nezaplacena',
              ${order.shop_id}, ${order.id},
              ${order.crm_contact_id || null}, ${order.crm_company_id || null},
              ${`${order.first_name} ${order.last_name}`.trim() || order.company || ''},
              ${order.ic || ''}, ${order.dic || ''},
              ${[order.address, (order.zip + ' ' + order.city).trim()].filter(Boolean).join(', ')},
              ${base}, ${vatAmt}, ${totalWithVat},
              ${order.currency || 'CZK'},
              ${new Date().toISOString().split('T')[0]}, NULL,
              ${order.payment_method ? `Platba: ${order.payment_method}` : ''}
            )
          `;

          // Položky faktury
          const orderItems = await sql`SELECT * FROM shop_order_items WHERE order_id = ${order.id}`;
          for (const item of orderItems) {
            const itemBase  = +(Number(item.price) / (1 + vatRate / 100) * item.quantity).toFixed(2);
            const itemVat   = +(Number(item.price) * item.quantity - itemBase).toFixed(2);
            const itemTotal = +(Number(item.price) * item.quantity).toFixed(2);
            await sql`
              INSERT INTO accounting_invoice_items
                (invoice_id, name, quantity, unit, price_per_unit, vat_rate, amount, vat_amount, total)
              VALUES (
                ${invoiceId}, ${item.name}, ${item.quantity}, 'ks',
                ${Number(item.price)}, ${vatRate}, ${itemBase}, ${itemVat}, ${itemTotal}
              )
            `;
          }

          fastify.log.info({ invoiceId, number }, 'Auto-faktura vygenerována');
        }

        // 2. Odeslat email s potvrzením + fakturou v příloze
        if (order.email) {
          const { renderInvoicePdf } = await import('../pdf.js');
          const { sendInvoiceEmail } = await import('../email.js');
          const [invoice] = await sql`SELECT * FROM accounting_invoices WHERE id = ${invoiceId}`;
          const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${invoiceId}`;
          const [company] = await sql`SELECT * FROM company_settings LIMIT 1`;
          const issuer = company || {};

          // Výpočet DPH souhrnu
          const vatMap = {};
          for (const it of items) {
            const r = it.vat_rate;
            if (!vatMap[r]) vatMap[r] = { rate: r, base: 0, vat: 0 };
            vatMap[r].base += Number(it.amount);
            vatMap[r].vat  += Number(it.vat_amount);
          }
          const vatSummary = Object.values(vatMap);

          const pdfBuffer = await renderInvoicePdf({ invoice, items, issuer, vatSummary });
          await sendInvoiceEmail({
            invoice, issuer, email: order.email, pdfBuffer,
            subject: `Objednávka #${order.order_number} vyřízena — faktura v příloze`,
            intro: `Vaše objednávka č. <strong>${order.order_number}</strong> byla úspěšně vyřízena.<br>V příloze naleznete fakturu.`,
          });
          fastify.log.info({ email: order.email }, 'Email s fakturou odeslán');
        }

      } catch (err) {
        fastify.log.error({ err }, 'Chyba auto-generace faktury/emailu při dokončení objednávky');
      }
    }

    // Ruční email o stavu (jiné statusy)
    if ((send_email === 'on' || send_email === '1') && status !== 'dokoncena') {
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

    return reply.redirect(`/ucetnictvi/objednavky/${order.id}`);
  });

  // ── Admin: Uložení poznámky ────────────────────────────────

  fastify.post('/ucetnictvi/objednavky/:id/poznamka', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const { notes } = request.body ?? {};
    await sql`
      UPDATE shop_orders SET notes = ${notes??''}, modified_at = NOW()
      WHERE id = ${request.params.id}
    `;
    return reply.redirect(`/ucetnictvi/objednavky/${request.params.id}`);
  });

  // ── Admin: Migrace z Airtable ──────────────────────────────

  fastify.get('/ucetnictvi/migrace', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');
    return reply.view('pages/toneracek/migrace.ejs', {
      pageTitle: 'Migrace z Airtable', currentPath: '/ucetnictvi/objednavky',
      user: request.user, result: null,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/migrace', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');

    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return reply.view('pages/toneracek/migrace.ejs', {
        pageTitle: 'Migrace z Airtable', currentPath: '/ucetnictvi/objednavky',
        user: request.user,
        result: { error: 'Chybí AIRTABLE_API_KEY nebo AIRTABLE_BASE_ID v prostředí.' },
      }, { layout: 'layouts/base.ejs' });
    }

    const shopId = await getToneracekShopId(sql);
    if (!shopId) {
      return reply.view('pages/toneracek/migrace.ejs', {
        pageTitle: 'Migrace z Airtable', currentPath: '/ucetnictvi/objednavky',
        user: request.user,
        result: { error: 'Toneráček shop není nakonfigurován v databázi.' },
      }, { layout: 'layouts/base.ejs' });
    }

    const AT_ORDERS    = 'tblhP8tvVl0KdJQeR';
    const AT_ITEMS     = 'tblqjU6x9KTGEH7YW';
    const AT_CUSTOMERS = 'tblk6MpLpLpe7wTq7';
    const FC = {
      email: 'fldalJniBJAO6SSFB', orderLinks: 'fldiTbjYcUsE0e5d2',
      isRegistered: 'fldRegistrace', firstName: 'fldJmeno',
      lastName: 'fldPrijmeni', phone: 'fldTelefon', company: 'fldFirma',
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
        const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
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

      const customerByOrder = {};
      let emailsNote = null;
      try {
        const customerRecords = await fetchAll(AT_CUSTOMERS, Object.values(FC));
        for (const rec of customerRecords) {
          const email = s(rec.fields[FC.email]);
          const links = rec.fields[FC.orderLinks];
          if (!email || !Array.isArray(links)) continue;
          const cust = {
            email, isRegistered: s(rec.fields[FC.isRegistered]) === 'Registrovaný',
            firstName: s(rec.fields[FC.firstName]), lastName: s(rec.fields[FC.lastName]),
            phone: s(rec.fields[FC.phone]), company: s(rec.fields[FC.company]),
          };
          for (const orderId of links) customerByOrder[orderId] = cust;
        }
      } catch (err) {
        emailsNote = `Emaily zákazníků nebyly načteny (${err.message}).`;
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

      const stats = { imported: 0, skipped: 0, items: 0, contacts: 0 };

      for (const rec of orderRecords) {
        const f = rec.fields;
        const atId = rec.id;
        const orderNum = n(f[F.orderNumber]);
        if (!orderNum) { stats.skipped++; continue; }

        const existing = await sql`
          SELECT id FROM shop_orders WHERE id = ${atId} OR (shop_id = ${shopId} AND order_number = ${String(orderNum)})
          LIMIT 1
        `;
        if (existing[0]) { stats.skipped++; continue; }

        const cust = customerByOrder[atId] || null;
        const email = cust?.email || '';
        const createdAt = s(f[F.createdAt]) || new Date().toISOString();
        const year = new Date(createdAt).getFullYear();

        await sql`
          INSERT INTO shop_orders (
            id, shop_id, order_number, status, payment_method, shipping_method,
            first_name, last_name, company, email, phone, address, city, zip,
            shipping_first_name, shipping_last_name, shipping_company,
            shipping_phone, shipping_address, shipping_city, shipping_zip,
            pickup_point_id, pickup_point_name, total_price, invoice_number,
            tracking_number, label_url, ip_address, created_at, modified_at
          ) VALUES (
            ${atId}, ${shopId}, ${String(orderNum)},
            ${s(f[F.status])||'Přijata'}, ${s(f[F.paymentMethod])}, ${s(f[F.shippingMethod])||'Zásilkovna'},
            ${s(f[F.firstName])}, ${s(f[F.lastName])}, ${s(f[F.company])},
            ${email}, ${s(f[F.phone])},
            ${s(f[F.address])}, ${s(f[F.city])}, ${s(f[F.zip])},
            ${s(f[F.shippingFirstName])||s(f[F.firstName])},
            ${s(f[F.shippingLastName]) ||s(f[F.lastName])},
            ${s(f[F.shippingCompany]) ||s(f[F.company])},
            ${s(f[F.shippingPhone])   ||s(f[F.phone])},
            ${s(f[F.shippingAddress]) ||s(f[F.address])},
            ${s(f[F.shippingCity])    ||s(f[F.city])},
            ${s(f[F.shippingZip])     ||s(f[F.zip])},
            ${s(f[F.pickupPointId])}, ${s(f[F.pickupPointName])},
            ${n(f[F.totalPrice])}, ${`FV-${year}-${orderNum}`},
            ${s(f[F.trackingNumber])}, ${s(f[F.labelUrl])}, ${s(f[F.ipAddress])},
            ${createdAt}, ${createdAt}
          )
        `;

        for (const item of (itemsByOrder[atId] || [])) {
          await sql`INSERT INTO shop_order_items (order_id, name, quantity) VALUES (${atId}, ${item.name}, ${item.quantity})`;
          stats.items++;
        }

        if (email) {
          try {
            const { contactId, companyId } = await upsertCustomerToCRM(sql, {
              email, firstName: cust?.firstName||s(f[F.firstName]),
              lastName: cust?.lastName||s(f[F.lastName]),
              company: cust?.company||s(f[F.company]),
              phone: cust?.phone||s(f[F.phone]),
              city: s(f[F.city]), country: 'Česká republika',
              isRegistered: cust?.isRegistered ?? false,
            });
            if (contactId || companyId) {
              await sql`
                UPDATE shop_orders SET crm_contact_id = ${contactId}, crm_company_id = ${companyId}
                WHERE id = ${atId}
              `;
            }
            stats.contacts++;
          } catch {}
        }

        stats.imported++;
      }

      fastify.log.info(stats, 'Airtable migrace dokončena');
      return reply.view('pages/toneracek/migrace.ejs', {
        pageTitle: 'Migrace z Airtable', currentPath: '/ucetnictvi/objednavky',
        user: request.user,
        result: { ...stats, total: orderRecords.length, totalItems: itemRecords.length, emailsNote },
      }, { layout: 'layouts/base.ejs' });

    } catch (err) {
      fastify.log.error({ err }, 'Airtable migrace selhala');
      return reply.view('pages/toneracek/migrace.ejs', {
        pageTitle: 'Migrace z Airtable', currentPath: '/ucetnictvi/objednavky',
        user: request.user, result: { error: err.message },
      }, { layout: 'layouts/base.ejs' });
    }
  });
}
