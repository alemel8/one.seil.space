import bcryptjs from 'bcryptjs';
import { getDb } from '../db.js';

export default async function authRoutes(fastify) {
  const sql = getDb();

  // ── Profil přihlášeného uživatele ────────────────────────────
  fastify.get('/profil', async (request, reply) => {
    return reply.view('pages/profil.ejs', {
      pageTitle: 'Můj profil', currentPath: '/profil',
      user: request.user,
      saved: request.query.saved === '1',
      error: request.query.error || null,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/profil', async (request, reply) => {
    const b = request.body || {};
    const updates = [];
    if (b.first_name !== undefined) updates.push(sql`first_name = ${b.first_name.trim()}`);
    if (b.last_name  !== undefined) updates.push(sql`last_name  = ${b.last_name.trim()}`);

    // Změna hesla
    if (b.new_password) {
      if (b.new_password !== b.new_password_confirm) {
        return reply.redirect('/profil?error=mismatch');
      }
      if (!bcryptjs.compareSync(b.current_password || '', request.user.password_hash)) {
        return reply.redirect('/profil?error=wrongpwd');
      }
      updates.push(sql`password_hash = ${bcryptjs.hashSync(b.new_password, 10)}`);
    }

    if (updates.length) {
      await sql`UPDATE users SET ${updates.reduce((a, b) => sql`${a}, ${b}`)} WHERE id = ${request.user.id}`;
    }
    return reply.redirect('/profil?saved=1');
  });

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
