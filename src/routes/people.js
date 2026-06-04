import bcryptjs from 'bcryptjs';
import { getDb } from '../db.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.resolve(__dirname, '../../data/media');

export default async function peopleRoutes(fastify) {
  const sql = getDb();

  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Přístup odepřen');
  });

  // ── Seznam členů týmu ────────────────────────────────────────
  fastify.get('/lide/tym', async (request, reply) => {
    const q = (request.query.q || '').trim();
    const where = q
      ? sql`WHERE first_name ILIKE ${'%'+q+'%'} OR last_name ILIKE ${'%'+q+'%'} OR email ILIKE ${'%'+q+'%'}`
      : sql``;
    const members = await sql`SELECT * FROM users ${where} ORDER BY last_name, first_name`;

    return reply.view('pages/people/team.ejs', {
      pageTitle: 'SEIL tým', currentPath: '/lide/tym', user: request.user,
      members, q, total: members.length,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Vytvořit člena ──────────────────────────────────────────
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

  // ── Detail člena ─────────────────────────────────────────────
  fastify.get('/lide/tym/:id', async (request, reply) => {
    const [member] = await sql`SELECT * FROM users WHERE id = ${request.params.id}`;
    if (!member) return reply.code(404).send('Člen nenalezen');
    return reply.view('pages/people/member-detail.ejs', {
      pageTitle: (`${member.first_name} ${member.last_name}`.trim() || member.email),
      currentPath: '/lide/tym', user: request.user, member,
      saved: request.query.saved === '1',
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Uložit detail člena ──────────────────────────────────────
  fastify.post('/lide/tym/:id', async (request, reply) => {
    const b = request.body || {};
    await sql`
      UPDATE users SET
        email        = ${(b.email||'').trim().toLowerCase()},
        first_name   = ${(b.first_name||'').trim()},
        last_name    = ${(b.last_name||'').trim()},
        title        = ${(b.title||'').trim()},
        phone        = ${(b.phone||'').trim()},
        position     = ${(b.position||'').trim()},
        bio          = ${(b.bio||'').trim()},
        address      = ${(b.address||'').trim()},
        city         = ${(b.city||'').trim()},
        zip          = ${(b.zip||'').trim()},
        country      = ${(b.country||'').trim()},
        bank_account = ${(b.bank_account||'').trim()},
        bank_name    = ${(b.bank_name||'').trim()},
        iban         = ${(b.iban||'').trim()},
        is_admin     = ${b.is_admin === 'on' || b.is_admin === '1'},
        is_active    = ${b.is_active === '1' || b.is_active === 'on'}
      WHERE id = ${request.params.id}
    `;
    return reply.redirect(`/lide/tym/${request.params.id}?saved=1`);
  });

  // ── Upload fotky člena (admin) ───────────────────────────────
  fastify.post('/lide/tym/:id/foto', async (request, reply) => {
    const memberId = request.params.id;
    const data = await request.file();
    if (!data) return reply.redirect(`/lide/tym/${memberId}?error=nofile`);

    const mime = data.mimetype || '';
    if (!mime.startsWith('image/')) return reply.redirect(`/lide/tym/${memberId}?error=notimage`);

    const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
    const filename = `user_${memberId}${ext}`;

    if (!existsSync(MEDIA_DIR)) await mkdir(MEDIA_DIR, { recursive: true });
    const buf = await data.toBuffer();
    await writeFile(path.join(MEDIA_DIR, filename), buf);

    await sql`UPDATE users SET photo = ${filename} WHERE id = ${memberId}`;
    return reply.redirect(`/lide/tym/${memberId}?saved=1`);
  });
}
