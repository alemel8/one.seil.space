import { getDb } from '../db.js';

export default async function userSettingsRoutes(fastify) {
  const sql = getDb();

  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
  });

  fastify.get('/nastaveni', async (request, reply) => {
    const [prefs] = await sql`
      SELECT notify_new_order FROM user_notification_prefs WHERE user_id = ${request.user.id}
    `;
    return reply.view('pages/settings/user.ejs', {
      pageTitle: 'Nastavení', currentPath: '/nastaveni',
      user: request.user,
      prefs: prefs ?? { notify_new_order: true },
      saved: request.query.saved === '1',
    }, { layout: 'layouts/base.ejs' });
  });
}
