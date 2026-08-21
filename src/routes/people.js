import bcryptjs from 'bcryptjs';
import { getDb } from '../db.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCESS_SECTIONS, ACCESS_KEYS, isAllowed, loadAccessMatrix, saveUserAccess,
} from '../access.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.resolve(__dirname, '../../data/media');

export default async function peopleRoutes(fastify) {
  const sql = getDb();

  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Přístup odepřen');
  });

  // Hledá primárně podle public_id; číselné id bereme jen jako fallback
  // pro staré odkazy a záložky v prohlížeči.
  async function findMember(idParam) {
    const raw = String(idParam || '');
    const [byPublic] = await sql`SELECT * FROM users WHERE public_id = ${raw}`;
    if (byPublic) return { member: byPublic, legacy: false };

    if (/^\d+$/.test(raw)) {
      const [byId] = await sql`SELECT * FROM users WHERE id = ${Number(raw)}`;
      if (byId) return { member: byId, legacy: true };
    }
    return { member: null, legacy: false };
  }

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

  // ── Přístupová matice ────────────────────────────────────────
  // Řádky = sekce a jejich záložky, sloupce = uživatelé v pořadí, v jakém
  // do systému přibyli (Aleš, Nikola, Lukáš H., Lukáš T., …).
  fastify.get('/lide/pristupy', async (request, reply) => {
    const members = await sql`SELECT * FROM users ORDER BY id`;
    const matrix = await loadAccessMatrix(sql, members.map(m => m.id));

    return reply.view('pages/people/access.ejs', {
      pageTitle: 'Přístupy', currentPath: '/lide/pristupy', user: request.user,
      members, matrix, sections: ACCESS_SECTIONS, isAllowed,
      saved: request.query.saved === '1',
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/lide/pristupy', async (request, reply) => {
    const b = request.body || {};
    const known = new Set(ACCESS_KEYS);
    const existing = new Set((await sql`SELECT id FROM users`).map(m => m.id));

    // Ukládáme jen sloupce, které formulář opravdu poslal (skryté acc_user).
    // Kdybychom brali všechny uživatele z databáze, neúplný požadavek by
    // ostatním smazal celou matici — nezaškrtnutý checkbox se neodesílá.
    const perUser = new Map(
      [].concat(b.acc_user ?? [])
        .map(Number)
        .filter(id => existing.has(id))
        .map(id => [id, []])
    );
    if (!perUser.size) return reply.redirect('/lide/pristupy');

    for (const field of Object.keys(b)) {
      const match = /^acc__(\d+)__(.+)$/.exec(field);
      if (!match) continue;
      const userId = Number(match[1]);
      if (!perUser.has(userId) || !known.has(match[2])) continue;
      perUser.get(userId).push(match[2]);
    }

    await sql.begin(async tx => {
      for (const [userId, keys] of perUser) await saveUserAccess(tx, userId, keys);
    });

    return reply.redirect('/lide/pristupy?saved=1');
  });

  // ── Detail člena ─────────────────────────────────────────────
  fastify.get('/lide/tym/:id', async (request, reply) => {
    const { member, legacy } = await findMember(request.params.id);
    if (!member) return reply.code(404).send('Člen nenalezen');
    // Staré číselné odkazy pošleme na kanonickou adresu s public_id
    if (legacy) return reply.redirect(`/lide/tym/${member.public_id}`);

    const matrix = await loadAccessMatrix(sql, [member.id]);
    member.access = matrix[member.id] ?? {};

    return reply.view('pages/people/member-detail.ejs', {
      pageTitle: (`${member.first_name} ${member.last_name}`.trim() || member.email),
      currentPath: '/lide/tym', user: request.user, member,
      sections: ACCESS_SECTIONS, isAllowed,
      saved: request.query.saved === '1',
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Uložit detail člena ──────────────────────────────────────
  fastify.post('/lide/tym/:id', async (request, reply) => {
    const { member } = await findMember(request.params.id);
    if (!member) return reply.code(404).send('Člen nenalezen');
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
        is_active    = ${b.is_active === '1' || b.is_active === 'on'},
        updated_at   = NOW()
      WHERE id = ${member.id}
    `;
    return reply.redirect(`/lide/tym/${member.public_id}?saved=1`);
  });

  // ── Upload fotky člena (admin) ───────────────────────────────
  fastify.post('/lide/tym/:id/foto', async (request, reply) => {
    const { member } = await findMember(request.params.id);
    if (!member) return reply.code(404).send('Člen nenalezen');
    const data = await request.file();
    if (!data) return reply.redirect(`/lide/tym/${member.public_id}?error=nofile`);

    const mime = data.mimetype || '';
    if (!mime.startsWith('image/')) return reply.redirect(`/lide/tym/${member.public_id}?error=notimage`);

    const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
    const filename = `user_${member.id}${ext}`;

    if (!existsSync(MEDIA_DIR)) await mkdir(MEDIA_DIR, { recursive: true });
    const buf = await data.toBuffer();
    await writeFile(path.join(MEDIA_DIR, filename), buf);

    await sql`UPDATE users SET photo = ${filename}, updated_at = NOW() WHERE id = ${member.id}`;
    return reply.redirect(`/lide/tym/${member.public_id}?saved=1`);
  });
}
