import bcryptjs from 'bcryptjs';
import { getDb } from '../db.js';
import { rezimUprav } from '../upravy.js';
import { zalozka } from '../zalozky.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.resolve(__dirname, '../../data/media');

/** Záložky Můj profil: klíč, popisek, id formuláře pro tužku (heslo a notifikace ji nemají). */
const ZALOZKY_PROFILU = [
  ['udaje',      'Osobní údaje', 'formProfil'],
  ['heslo',      'Heslo',        null],
  ['notifikace', 'Notifikace',   null],
];
const CHYBY_PROFILU = {
  __proto__: null,
  mismatch: 'Nová hesla se neshodují',
  wrongpwd: 'Nesprávné stávající heslo',
  prazdne: 'Zadejte nové heslo',
  nofile: 'Vyberte soubor s fotkou',
  notimage: 'Fotka musí být obrázek (JPG, PNG nebo WEBP)',
};

export default async function authRoutes(fastify) {
  const sql = getDb();

  // ── Profil přihlášeného uživatele ────────────────────────────
  fastify.get('/profil', async (request, reply) => {
    const tab = zalozka(ZALOZKY_PROFILU, request.query.tab);
    const [prefs] = tab === 'notifikace'
      ? await sql`SELECT notify_new_order FROM user_notification_prefs WHERE user_id = ${request.user.id}`
      : [];
    return reply.view('pages/profil.ejs', {
      pageTitle: 'Můj profil', currentPath: '/profil',
      user: request.user, tab, zalozky: ZALOZKY_PROFILU,
      prefs: prefs ?? { notify_new_order: true },
      saved: request.query.saved === '1',
      error: CHYBY_PROFILU[request.query.error] || null,
      rezimUprav: rezimUprav(request.query),
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Upload profilové fotky ────────────────────────────────────
  fastify.post('/profil/foto', async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.redirect('/profil?tab=udaje&error=nofile');

    const mime = data.mimetype || '';
    if (!mime.startsWith('image/')) return reply.redirect('/profil?tab=udaje&error=notimage');

    const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
    const filename = `user_${request.user.id}${ext}`;

    if (!existsSync(MEDIA_DIR)) await mkdir(MEDIA_DIR, { recursive: true });
    const buf = await data.toBuffer();
    await writeFile(path.join(MEDIA_DIR, filename), buf);

    await sql`UPDATE users SET photo = ${filename}, updated_at = NOW() WHERE id = ${request.user.id}`;
    return reply.redirect('/profil?tab=udaje&saved=1');
  });

  // ── Smazat profilovou fotku ───────────────────────────────────
  fastify.post('/profil/foto/smazat', async (request, reply) => {
    await sql`UPDATE users SET photo = NULL, updated_at = NOW() WHERE id = ${request.user.id}`;
    return reply.redirect('/profil?tab=udaje&saved=1');
  });

  fastify.post('/profil', async (request, reply) => {
    const b = request.body || {};
    const updates = [];
    if (b.first_name !== undefined) updates.push(sql`first_name = ${b.first_name.trim()}`);
    if (b.last_name  !== undefined) updates.push(sql`last_name  = ${b.last_name.trim()}`);

    // Změna hesla: formulář má vlastní záložku a posílá jen pole hesla.
    const zHesla = b.new_password !== undefined;
    if (zHesla && !b.new_password) return reply.redirect('/profil?tab=heslo&error=prazdne');
    if (b.new_password) {
      if (b.new_password !== b.new_password_confirm) {
        return reply.redirect('/profil?tab=heslo&error=mismatch');
      }
      const [u] = await sql`SELECT password_hash FROM users WHERE id = ${request.user.id}`;
      if (!bcryptjs.compareSync(b.current_password || '', u?.password_hash || '')) {
        return reply.redirect('/profil?tab=heslo&error=wrongpwd');
      }
      updates.push(sql`password_hash = ${bcryptjs.hashSync(b.new_password, 10)}`);
    }

    if (updates.length) {
      updates.push(sql`updated_at = NOW()`);
      await sql`UPDATE users SET ${updates.reduce((a, b) => sql`${a}, ${b}`)} WHERE id = ${request.user.id}`;
    }
    return reply.redirect(zHesla ? '/profil?tab=heslo&saved=1' : '/profil?tab=udaje&saved=1');
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
