// Personální agenda napříč lidmi — přehledy, které nejsou vázané na jeden
// profil. Osobní pohled zůstává na detailu člena (src/routes/people.js).
//
// Celá sekce je admin-only jako zbytek Lidé & Kultura; mzdy a ekonomika mají
// navíc v přístupové matici defaultDeny, takže se musí vědomě zapnout.

import { getDb } from '../db.js';
import {
  osobniUctyVsech, mzdyPrehled, mzdoveRoky, podkladyPrehled, PODKLAD_STAVY,
} from '../hr.js';

export default async function hrRoutes(fastify) {
  const sql = getDb();

  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Přístup odepřen');
  });

  // ── Ekonomika lidí ───────────────────────────────────────────
  fastify.get('/lide/ekonomika', async (request, reply) => {
    const rok = /^\d{4}$/.test(request.query.rok || '') ? Number(request.query.rok) : null;
    const [lide, roky] = await Promise.all([
      osobniUctyVsech(sql, { rok }),
      mzdoveRoky(sql),
    ]);
    const celkem = lide.reduce((a, u) => ({
      prijmy: a.prijmy + u.ucet.prijmy,
      vydaje: a.vydaje + u.ucet.vydaje,
      ostatni: a.ostatni + u.ucet.ostatni,
      zustatek: a.zustatek + u.ucet.zustatek,
    }), { prijmy: 0, vydaje: 0, ostatni: 0, zustatek: 0 });

    return reply.view('pages/people/ekonomika.ejs', {
      pageTitle: 'Ekonomika lidí', currentPath: '/lide/ekonomika',
      user: request.user, lide, celkem, rok, roky,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Mzdy ─────────────────────────────────────────────────────
  fastify.get('/lide/mzdy', async (request, reply) => {
    const roky = await mzdoveRoky(sql);
    const rok = /^\d{4}$/.test(request.query.rok || '')
      ? Number(request.query.rok) : (roky[0] ?? new Date().getFullYear());
    const { lide, mesice, bunky, rows } = await mzdyPrehled(sql, rok);
    const souhrn = rows.reduce((a, r) => ({
      naklad: a.naklad + r.company_cost,
      uhrazeno: a.uhrazeno + r.paid_total,
      nevyplaceno: a.nevyplaceno + (r.paid ? 0 : 1),
    }), { naklad: 0, uhrazeno: 0, nevyplaceno: 0 });

    return reply.view('pages/people/mzdy.ejs', {
      pageTitle: 'Mzdy', currentPath: '/lide/mzdy',
      user: request.user, lide, mesice, bunky, souhrn, rok, roky,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Fakturační podklady ──────────────────────────────────────
  fastify.get('/lide/podklady', async (request, reply) => {
    const filtry = {
      q: (request.query.q || '').trim(),
      stav: PODKLAD_STAVY.some(s => s[0] === request.query.stav) ? request.query.stav : '',
      osoba: (request.query.osoba || '').trim(),
    };
    const [podklady, lide] = await Promise.all([
      podkladyPrehled(sql, filtry),
      sql`SELECT DISTINCT u.public_id, u.first_name, u.last_name
            FROM users u JOIN hr_work_reports w ON w.user_id = u.id ORDER BY u.last_name`,
    ]);
    const celkem = podklady.reduce((a, p) => a + p.total_amount, 0);

    return reply.view('pages/people/podklady.ejs', {
      pageTitle: 'Fakturační podklady', currentPath: '/lide/podklady',
      user: request.user, podklady, lide, filtry, celkem, PODKLAD_STAVY,
    }, { layout: 'layouts/base.ejs' });
  });
}
