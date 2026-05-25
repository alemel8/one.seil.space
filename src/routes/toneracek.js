import { getAppDb, generateId } from '../db.js';
import { sendOrderStatusEmail } from '../email.js';

const ORDER_STATUSES = ['Přijata', 'Ve zpracování', 'Vyřízena', 'Stornována'];

const PAYMENT_LABELS = {
  card: 'Platba kartou',
  transfer: 'Bankovní převod',
  cod: 'Dobírka',
};

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
}
