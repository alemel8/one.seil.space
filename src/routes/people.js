import bcryptjs from 'bcryptjs';
import { getDb } from '../db.js';

export default async function peopleRoutes(fastify) {
  const sql = getDb();

  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Přístup odepřen');
  });

  fastify.get('/lide/tym', async (request, reply) => {
    const q = (request.query.q || '').trim();
    const where = q
      ? sql`WHERE first_name ILIKE ${'%'+q+'%'} OR last_name ILIKE ${'%'+q+'%'} OR email ILIKE ${'%'+q+'%'}`
      : sql``;
    const members = await sql`SELECT * FROM users ${where} ORDER BY last_name, first_name`;

    return reply.view('pages/people/team.ejs', {
      pageTitle: 'Tým', currentPath: '/lide/tym', user: request.user,
      members, q, total: members.length,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/lide/tym/vytvorit', async (request, reply) => {
    const b = request.body || {};
    if (!b.email || !b.password || b.password.length < 8) {
      return reply.redirect('/lide/tym?error=invalid');
    }
    const hash = bcryptjs.hashSync(b.password, 10);
    try {
      await sql`
        INSERT INTO users (email, password_hash, first_name, last_name, is_admin)
        VALUES (${b.email.trim().toLowerCase()}, ${hash},
                ${(b.first_name||'').trim()}, ${(b.last_name||'').trim()},
                ${b.is_admin === 'on' || b.is_admin === '1'})
      `;
    } catch {
      return reply.redirect('/lide/tym?error=duplicate');
    }
    return reply.redirect('/lide/tym');
  });

  fastify.get('/lide/tym/:id', async (request, reply) => {
    const [member] = await sql`
      SELECT id, email, first_name, last_name, is_admin, is_active, created_at
      FROM users WHERE id = ${request.params.id}
    `;
    if (!member) return reply.code(404).send('Člen nenalezen');
    return reply.view('pages/people/member-detail.ejs', {
      pageTitle: (`${member.first_name} ${member.last_name}`.trim() || member.email),
      currentPath: '/lide/tym', user: request.user, member,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/lide/tym/:id', async (request, reply) => {
    const b = request.body || {};
    await sql`
      UPDATE users SET
        first_name = ${(b.first_name||'').trim()},
        last_name  = ${(b.last_name||'').trim()},
        is_admin   = ${b.is_admin === 'on' || b.is_admin === '1'},
        is_active  = ${b.is_active !== '0'}
      WHERE id = ${request.params.id}
    `;
    return reply.redirect(`/lide/tym/${request.params.id}`);
  });
}
