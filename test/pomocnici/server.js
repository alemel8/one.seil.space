// Společné pro testy proti běžícímu serveru a lokální databázi (vzor
// test/eshop-nastaveni.test.js): kontrola, že DATABASE_URL míří na localhost,
// přihlášení vloženou session a fetch s cookie bez sledování přesměrování.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/<soubor>.test.js
//
// Bez DATABASE_URL se serverová část přeskakuje:
//   describe('proti serveru', { skip: PRESKOCIT }, () => { … })

import crypto from 'node:crypto';

export const BASE   = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
export const SECRET = process.env.SESSION_SECRET || 'one-seil-space-secret-change-in-production-32chars';
export const PRESKOCIT = !process.env.DATABASE_URL && 'bez DATABASE_URL (lokální testovací databáze) se serverová část přeskakuje';

/** DATABASE_URL, jen když míří na localhost – testy zakládají a mažou data. */
export function lokalniDatabaze() {
  const url = process.env.DATABASE_URL || '';
  const host = url ? new URL(url).hostname : '';
  if (!['127.0.0.1', 'localhost'].includes(host) && process.env.TEST_DB_ALLOW_REMOTE !== '1') {
    throw new Error(`Test zapisuje do databáze – DATABASE_URL musí mířit na 127.0.0.1/localhost, ne na "${host}"`);
  }
  return url;
}

/** Ověří, že server běží (GET /health). */
export async function serverBezi() {
  const health = await fetch(BASE + '/health').catch(() => null);
  if (!health?.ok) throw new Error(`server neběží na ${BASE}`);
}

/** Vloží session pro uživatele a vrátí { sid, cookie }; sid po testu smazat. */
export async function prihlas(sql, userId) {
  const sid = 'test' + crypto.randomBytes(12).toString('hex');
  const sig = crypto.createHmac('sha256', SECRET).update(sid).digest('base64').replace(/=/g, '');
  await sql`
    INSERT INTO session (sid, sess, expire) VALUES (${sid},
      ${{ cookie: { originalMaxAge: 28800000, httpOnly: true, path: '/', sameSite: 'lax', secure: false }, userId }},
      ${new Date(Date.now() + 3600_000)})
  `;
  return { sid, cookie: `sessionId=${sid}.${sig}` };
}

/** GET a POST (x-www-form-urlencoded) s cookie, přesměrování se nesleduje. */
export function pozadavky(cookie) {
  return {
    get: (p) => fetch(BASE + p, { headers: { cookie }, redirect: 'manual' }),
    post: (p, body = {}) => fetch(BASE + p, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    }),
  };
}
