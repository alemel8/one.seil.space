import bcryptjs from 'bcryptjs';
import { getAppDb, generateId } from '../db.js';

export default async function peopleRoutes(fastify) {

  // Pouze admin — musí být preHandler (request.user je nastaven v globálním preHandler)
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user || !request.user.is_admin) {
      return reply.code(403).send('Přístup odepřen');
    }
  });

  fastify.get('/lide/tym', async (request, reply) => {
    const db = getAppDb();
    const q = (request.query.q || '').trim();
    let members;

    if (q) {
      members = db.prepare(`
        SELECT * FROM users
        WHERE (first_name LIKE ? OR last_name LIKE ? OR email LIKE ?)
        ORDER BY last_name, first_name
      `).all(`%${q}%`, `%${q}%`, `%${q}%`);
    } else {
      members = db.prepare('SELECT * FROM users ORDER BY last_name, first_name').all();
    }

    return reply.view('pages/people/team.ejs', {
      pageTitle: 'Tým',
      currentPath: '/lide/tym',
      user: request.user,
      members,
      q,
      total: members.length,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/lide/tym/vytvorit', async (request, reply) => {
    const db = getAppDb();
    const b = request.body || {};

    if (!b.email || !b.password || b.password.length < 8) {
      return reply.redirect('/lide/tym?error=invalid');
    }

    const hash = bcryptjs.hashSync(b.password, 10);
    try {
      db.prepare(`INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
                  VALUES (?, ?, ?, ?, ?)`).run(
        b.email.trim().toLowerCase(),
        hash,
        (b.first_name || '').trim(),
        (b.last_name || '').trim(),
        b.is_admin ? 1 : 0,
      );
    } catch {
      return reply.redirect('/lide/tym?error=duplicate');
    }

    return reply.redirect('/lide/tym');
  });

  fastify.get('/lide/tym/:id', async (request, reply) => {
    const db = getAppDb();
    const member = db.prepare('SELECT id, email, first_name, last_name, is_admin, is_active, created_at FROM users WHERE id = ?').get(request.params.id);
    if (!member) return reply.code(404).send('Člen nenalezen');
    return reply.view('pages/people/member-detail.ejs', {
      pageTitle: ((member.first_name + ' ' + member.last_name).trim() || member.email),
      currentPath: '/lide/tym',
      user: request.user,
      member,
    }, { layout: 'layouts/base.ejs' });
  });
}
