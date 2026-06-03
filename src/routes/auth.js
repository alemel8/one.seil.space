import bcryptjs from 'bcryptjs';
import { getDb } from '../db.js';

export default async function authRoutes(fastify) {
  const sql = getDb();

  fastify.get('/prihlasit', async (request, reply) => {
    if (request.session.userId) return reply.redirect('/');
    return reply.view('pages/login.ejs', { error: null, email: '' });
  });

  fastify.post('/prihlasit', async (request, reply) => {
    const { email, password, remember } = request.body || {};

    if (!email || !password) {
      return reply.view('pages/login.ejs', { error: 'Vyplňte e-mail a heslo.', email: email || '' });
    }

    const rows = await sql`
      SELECT * FROM users WHERE LOWER(email) = LOWER(${email.trim()}) AND is_active = TRUE
    `;
    const user = rows[0];

    if (!user || !bcryptjs.compareSync(password, user.password_hash)) {
      return reply.view('pages/login.ejs', { error: 'Nesprávný e-mail nebo heslo.', email: email || '' });
    }

    request.session.userId = user.id;
    if (remember) {
      request.session.options({ maxAge: 30 * 24 * 60 * 60 * 1000 });
    }

    await request.session.save();
    return reply.redirect('/');
  });

  fastify.get('/odhlasit', async (request, reply) => {
    await request.session.destroy();
    return reply.redirect('/prihlasit');
  });
}
