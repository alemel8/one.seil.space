// Sekce Práce — úkoly, stopky a výkazy.
//
// Není admin-only: kdo si měří čas, musí se ke svým úkolům dostat.
// Rozsah dat řeší routy, ne přístupová matice — ta umí jen „vidí / nevidí
// URL", ne „vidí jen svoje". /prace a /prace/vykazy jsou proto vždy
// omezené na přihlášeného a parametr osoby se běžnému uživateli ignoruje,
// místo aby padalo 403.

import { getDb, generateId } from '../db.js';
import {
  beziciMereni, spustStopky, zastavStopky, zaznamyDne, zapomenuteStopky,
  ukoly, vykaz, hodinyMinuty, TASK_STAVY, PODEZRELE_HODIN,
} from '../prace.js';

const dnesek = () => new Date().toISOString().slice(0, 10);

function zpet(request, vychozi) {
  const b = request.body?.back || request.query?.back || '';
  // Jen relativní cesta v rámci aplikace — ať se z toho nedá udělat
  // odrazový můstek na cizí web.
  return /^\/[A-Za-z0-9/_?=&.-]*$/.test(b) ? b : vychozi;
}

export default async function workRoutes(fastify) {
  const sql = getDb();

  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
  });

  // ── Můj čas ──────────────────────────────────────────────────
  fastify.get('/prace', async (request, reply) => {
    const [bezi, dnes, zapomenute, posledni] = await Promise.all([
      beziciMereni(sql, request.user.id),
      zaznamyDne(sql, request.user.id, dnesek()),
      zapomenuteStopky(sql, request.user.id),
      sql`SELECT DISTINCT ON (t.id) t.id, t.code, t.summary
            FROM tasks t JOIN time_entries e ON e.task_id = t.id
           WHERE e.user_id = ${request.user.id} AND t.status <> 'done'
           ORDER BY t.id, e.started_at DESC LIMIT 6`,
    ]);
    const celkemDnes = dnes.reduce((a, z) => a + (z.sekund ?? 0), 0);

    return reply.view('pages/prace/dnes.ejs', {
      pageTitle: 'Můj čas', currentPath: '/prace', user: request.user,
      bezi, dnes, zapomenute, posledni, celkemDnes, hodinyMinuty, PODEZRELE_HODIN,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/prace/stopky/start', async (request, reply) => {
    const b = request.body || {};
    await spustStopky(sql, request.user.id, {
      taskId: b.ukol_id || null,
      note: (b.poznamka || '').trim(),
    });
    return reply.redirect(zpet(request, '/prace'));
  });

  fastify.post('/prace/stopky/stop', async (request, reply) => {
    await zastavStopky(sql, request.user.id);
    return reply.redirect(zpet(request, '/prace'));
  });

  // Zapomenuté stopky nikdy neukončujeme sami — vymyšlený čas ve výkazu
  // je horší než chybějící. Tohle je ruční dořešení s konkrétním časem.
  fastify.post('/prace/stopky/:id/dokoncit', async (request, reply) => {
    const b = request.body || {};
    const kdy = b.konec === 'ted' ? sql`NOW()`
      : b.konec === 'vecer' ? sql`date_trunc('day', started_at) + interval '18 hours'`
      : b.konec_rucne ? sql`${b.konec_rucne}::timestamptz` : sql`NOW()`;
    await sql`
      UPDATE time_entries SET ended_at = GREATEST(${kdy}, started_at), source = 'rucne', modified_at = NOW()
       WHERE id = ${request.params.id} AND user_id = ${request.user.id} AND ended_at IS NULL
    `;
    return reply.redirect(zpet(request, '/prace'));
  });

  fastify.post('/prace/zaznamy/vytvorit', async (request, reply) => {
    const b = request.body || {};
    const den = b.den || dnesek();
    if (!b.od || !b.do) return reply.redirect('/prace?error=cas');
    await sql`
      INSERT INTO time_entries (user_id, task_id, started_at, ended_at, note, source)
      VALUES (${request.user.id}, ${b.ukol_id || null},
              ${`${den} ${b.od}`}::timestamptz, ${`${den} ${b.do}`}::timestamptz,
              ${(b.poznamka || '').trim()}, 'rucne')
    `;
    return reply.redirect(zpet(request, '/prace'));
  });

  fastify.post('/prace/zaznamy/:id/smazat', async (request, reply) => {
    // user_id v podmínce, aby nešlo smazat cizí měření podvrženým ID
    await sql`DELETE FROM time_entries WHERE id = ${request.params.id} AND user_id = ${request.user.id}`;
    return reply.redirect(zpet(request, '/prace'));
  });

  // ── Úkoly ────────────────────────────────────────────────────
  fastify.get('/prace/ukoly', async (request, reply) => {
    const filtry = {
      q: (request.query.q || '').trim(),
      stav: TASK_STAVY.some(s => s[0] === request.query.stav) ? request.query.stav : '',
      klient: (request.query.klient || '').trim(),
      jenNehotove: request.query.vse !== '1',
    };
    const [seznam, klienti, bezi] = await Promise.all([
      ukoly(sql, filtry),
      sql`SELECT DISTINCT c.id, c.name FROM crm_companies c
            JOIN tasks t ON t.company_id = c.id ORDER BY c.name`,
      beziciMereni(sql, request.user.id),
    ]);
    return reply.view('pages/prace/ukoly.ejs', {
      pageTitle: 'Úkoly', currentPath: '/prace/ukoly', user: request.user,
      ukoly: seznam, klienti, filtry, bezi, hodinyMinuty, TASK_STAVY,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.get('/prace/ukoly/:id', async (request, reply) => {
    const [ukol] = await sql`
      SELECT t.*, c.name AS klient, u.first_name, u.last_name
        FROM tasks t
        LEFT JOIN crm_companies c ON c.id = t.company_id
        LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.id = ${request.params.id}
    `;
    if (!ukol) return reply.code(404).send('Úkol nenalezen');
    const [mereni, podukoly, prilohy, bezi] = await Promise.all([
      sql`SELECT e.*, e.duration_seconds AS sekund, us.first_name, us.last_name
            FROM time_entries e JOIN users us ON us.id = e.user_id
           WHERE e.task_id = ${ukol.id} ORDER BY e.started_at DESC LIMIT 100`,
      sql`SELECT id, code, summary, status FROM tasks WHERE parent_id = ${ukol.id} ORDER BY seq`,
      sql`SELECT id, original_name, mime, size, category FROM attachments
           WHERE task_id = ${ukol.id} ORDER BY sort_order, id`,
      beziciMereni(sql, request.user.id),
    ]);
    const celkem = mereni.reduce((a, m) => a + (m.sekund ?? 0), 0);
    return reply.view('pages/prace/ukol-detail.ejs', {
      pageTitle: ukol.code || 'Úkol', currentPath: '/prace/ukoly', user: request.user,
      ukol, mereni, podukoly, prilohy, celkem, bezi, hodinyMinuty, TASK_STAVY,
      KATEGORIE_PRILOH: (await import('../hr.js')).KATEGORIE_PRILOH,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/prace/ukoly/vytvorit', async (request, reply) => {
    const b = request.body || {};
    const souhrn = (b.summary || '').trim();
    if (!souhrn) return reply.redirect('/prace/ukoly?error=souhrn');
    const [{ max }] = await sql`SELECT COALESCE(MAX(seq), 0) AS max FROM tasks`;
    await sql`
      INSERT INTO tasks (id, seq, code, summary, description, company_id, status,
                         due_date, assignee_id, author_id, created_by)
      VALUES (${generateId()}, ${max + 1}, ${'GUK-' + (max + 1)}, ${souhrn},
              ${(b.description || '').trim()}, ${b.company_id || null}, 'todo',
              ${b.due_date || null}, ${b.assignee_id || request.user.id},
              ${request.user.id}, ${request.user.id})
    `;
    return reply.redirect('/prace/ukoly');
  });

  fastify.post('/prace/ukoly/:id/stav', async (request, reply) => {
    const stav = TASK_STAVY.some(s => s[0] === request.body?.status) ? request.body.status : null;
    if (stav) {
      await sql`
        UPDATE tasks SET status = ${stav}, modified_by = ${request.user.id}, modified_at = NOW(),
                         done_at = ${stav === 'done' ? sql`NOW()` : sql`NULL`}
         WHERE id = ${request.params.id}
      `;
    }
    return reply.redirect(zpet(request, '/prace/ukoly'));
  });

  // ── Výkazy ───────────────────────────────────────────────────
  fastify.get('/prace/vykazy', async (request, reply) => {
    const ted = new Date();
    const rok = /^\d{4}$/.test(request.query.rok || '') ? Number(request.query.rok) : ted.getFullYear();
    const mesic = /^\d{1,2}$/.test(request.query.mesic || '') ? Number(request.query.mesic) : ted.getMonth() + 1;

    // Cizí osobu smí zobrazit jen správce; běžnému uživateli se parametr
    // prostě ignoruje, takže se sem nedá omylem prokliknout.
    let osoba = request.user;
    if (request.user.is_admin && request.query.osoba) {
      const [j] = await sql`SELECT id, public_id, first_name, last_name FROM users WHERE public_id = ${request.query.osoba}`;
      if (j) osoba = j;
    }
    const [data, lide] = await Promise.all([
      vykaz(sql, osoba.id, rok, mesic),
      request.user.is_admin
        ? sql`SELECT DISTINCT u.public_id, u.first_name, u.last_name FROM users u
                JOIN time_entries e ON e.user_id = u.id ORDER BY u.last_name`
        : Promise.resolve([]),
    ]);
    return reply.view('pages/prace/vykaz.ejs', {
      pageTitle: 'Výkaz hodin', currentPath: '/prace/vykazy', user: request.user,
      ...data, rok, mesic, osoba, lide, hodinyMinuty,
    }, { layout: 'layouts/base.ejs' });
  });
}
