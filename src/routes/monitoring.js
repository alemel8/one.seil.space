import { getDb } from '../db.js';
import { bezpecnyNavrat } from '../navrat.js';
import { zalozka } from '../zalozky.js';

const ZALOZKY = [['aplikace', 'Sledované aplikace'], ['notifikace', 'Notifikace']];
const NA_APLIKACE = '/nastaveni/healthchecky?tab=aplikace';
const NA_NOTIFIKACE = '/nastaveni/healthchecky?tab=notifikace';

export default async function monitoringRoutes(fastify) {
  const sql = getDb();

  // ── Nastavení healthchecků ────────────────────────────────────
  fastify.get('/nastaveni/healthchecky', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');
    const tab = zalozka(ZALOZKY, request.query.tab);
    const [checks, channels, rules] = await Promise.all(tab === 'aplikace'
      ? [sql`SELECT * FROM healthchecks ORDER BY name`, [], []]
      : [[], sql`SELECT * FROM notification_channels ORDER BY name`, sql`SELECT r.*, c.name AS channel_name FROM notification_rules r LEFT JOIN notification_channels c ON r.channel_id = c.id ORDER BY r.event_type`]);
    return reply.view('pages/monitoring/settings.ejs', {
      pageTitle: 'Monitoring – nastavení', currentPath: '/nastaveni/healthchecky',
      user: request.user, checks, channels, rules, tab, zalozky: ZALOZKY,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/nastaveni/healthchecky/vytvorit', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');
    const b = request.body || {};
    const shopId = b.shop_id ? parseInt(b.shop_id, 10) : null;
    await sql`INSERT INTO healthchecks (name, url, interval_s, shop_id) VALUES (${b.name}, ${b.url}, ${parseInt(b.interval_s||300,10)}, ${shopId})`;
    return reply.redirect(bezpecnyNavrat(b.returnTo, NA_APLIKACE));
  });

  fastify.post('/nastaveni/healthchecky/:id/smazat', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');
    const b = request.body || {};
    await sql`DELETE FROM healthchecks WHERE id = ${request.params.id}`;
    return reply.redirect(bezpecnyNavrat(b.returnTo, NA_APLIKACE));
  });

  fastify.post('/nastaveni/healthchecky/:id/toggle', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');
    const b = request.body || {};
    await sql`UPDATE healthchecks SET active = NOT active WHERE id = ${request.params.id}`;
    return reply.redirect(bezpecnyNavrat(b.returnTo, NA_APLIKACE));
  });

  // ── Notifikační kanály ────────────────────────────────────────
  fastify.post('/nastaveni/notifikace/kanal/vytvorit', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');
    const b = request.body || {};
    await sql`INSERT INTO notification_channels (type, name, target) VALUES (${b.type}, ${b.name}, ${b.target || '*'})`;
    return reply.redirect(bezpecnyNavrat(b.returnTo, NA_NOTIFIKACE));
  });

  fastify.post('/nastaveni/notifikace/kanal/:id/smazat', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');
    const b = request.body || {};
    await sql`DELETE FROM notification_channels WHERE id = ${request.params.id}`;
    return reply.redirect(bezpecnyNavrat(b.returnTo, NA_NOTIFIKACE));
  });

  // ── Notifikační pravidla ──────────────────────────────────────
  fastify.post('/nastaveni/notifikace/pravidlo/vytvorit', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');
    const b = request.body || {};
    await sql`INSERT INTO notification_rules (event_type, threshold, channel_id) VALUES (${b.event_type}, ${b.threshold ? parseFloat(b.threshold) : null}, ${parseInt(b.channel_id,10)})`;
    return reply.redirect(bezpecnyNavrat(b.returnTo, NA_NOTIFIKACE));
  });

  fastify.post('/nastaveni/notifikace/pravidlo/:id/smazat', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');
    const b = request.body || {};
    await sql`DELETE FROM notification_rules WHERE id = ${request.params.id}`;
    return reply.redirect(bezpecnyNavrat(b.returnTo, NA_NOTIFIKACE));
  });

  // ── API: aktuální stav healthchecků (pro homepage dashboard) ──
  fastify.get('/api/healthchecks/status', async () => {
    const checks = await sql`
      SELECT h.id, h.name, h.url, h.active,
             r.ok, r.status_code, r.latency_ms, r.checked_at, r.error
      FROM healthchecks h
      LEFT JOIN LATERAL (
        SELECT ok, status_code, latency_ms, checked_at, error
        FROM healthcheck_results
        WHERE check_id = h.id
        ORDER BY checked_at DESC LIMIT 1
      ) r ON TRUE
      WHERE h.active = TRUE
      ORDER BY h.name
    `;
    return checks;
  });

  // Upomínky faktur řeší src/routes/invoices.js – mají tři stupně důrazu,
  // evidenci v invoice_reminders a log odeslání.
}
