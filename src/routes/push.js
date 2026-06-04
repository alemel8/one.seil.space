import { getDb } from '../db.js';
import { getVapidPublicKey } from '../push.js';

export default async function pushRoutes(fastify) {
  const sql = getDb();

  fastify.get('/api/push/vapid-key', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const key = getVapidPublicKey();
    if (!key) return reply.code(503).send({ error: 'Push není nakonfigurován' });
    return reply.send({ publicKey: key });
  });

  fastify.post('/api/push/subscribe', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const { endpoint, keys } = request.body ?? {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return reply.code(400).send({ error: 'Neplatná subscription' });
    }
    await sql`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES (${request.user.id}, ${endpoint}, ${keys.p256dh}, ${keys.auth})
      ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
    `;
    return reply.send({ ok: true });
  });

  fastify.post('/api/push/unsubscribe', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const { endpoint } = request.body ?? {};
    if (!endpoint) return reply.code(400).send({ error: 'Chybí endpoint' });
    await sql`DELETE FROM push_subscriptions WHERE user_id = ${request.user.id} AND endpoint = ${endpoint}`;
    return reply.send({ ok: true });
  });

  // Vrátí stav (má uživatel aktivní subscription z tohoto zařízení)
  fastify.post('/api/push/status', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const { endpoint } = request.body ?? {};
    if (!endpoint) return reply.send({ subscribed: false });
    const [row] = await sql`
      SELECT id FROM push_subscriptions WHERE user_id = ${request.user.id} AND endpoint = ${endpoint}
    `;
    return reply.send({ subscribed: !!row });
  });
}
