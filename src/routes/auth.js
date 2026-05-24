import bcryptjs from 'bcryptjs';
import { getAppDb } from '../db.js';

export default async function authRoutes(fastify) {

  // GET /prihlasit — login form
  fastify.get('/prihlasit', async (request, reply) => {
    if (request.session.userId) return reply.redirect('/');
    return reply.view('pages/login.ejs', { error: null, email: '' });
  });

  // POST /prihlasit — process login
  fastify.post('/prihlasit', async (request, reply) => {
    const { email, password, remember } = request.body || {};

    if (!email || !password) {
      return reply.view('pages/login.ejs', { error: 'Vyplňte e-mail a heslo.', email: email || '' });
    }

    const db = getAppDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.trim().toLowerCase());

    if (!user || !bcryptjs.compareSync(password, user.password_hash)) {
      return reply.view('pages/login.ejs', { error: 'Nesprávný e-mail nebo heslo.', email: email || '' });
    }

    request.session.userId = user.id;
    if (remember) {
      request.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 dní
    }

    return reply.redirect('/');
  });

  // GET /odhlasit — logout
  fastify.get('/odhlasit', async (request, reply) => {
    await request.session.destroy();
    return reply.redirect('/prihlasit');
  });
}
