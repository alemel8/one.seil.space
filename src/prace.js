// Úkoly a měření času.
//
// Zdrojem pravdy o běžících stopkách je řádek v time_entries s ended_at IS NULL.
// Žádný stav v prohlížeči ani v session — zavření okna, pád notebooku ani
// restart telefonu měření neztratí a napříč zařízeními vidí člověk totéž.
// Že běží nejvýš jedny stopky, hlídá částečný unikátní index v databázi.

import { generateId } from './db.js';

export const TASK_STAVY = [
  ['todo',        'Nezačato'],
  ['in_progress', 'Pracuje se'],
  ['testing',     'Testuje se'],
  ['on_hold',     'Odloženo'],
  ['done',        'Hotovo'],
];

/** Měření delší než tohle je skoro jistě zapomenuté, ne poctivá práce. */
export const PODEZRELE_HODIN = 10;

/** Běžící stopky přihlášeného, i s úkolem. Vrací null, když nic neběží. */
export async function beziciMereni(sql, userId) {
  const [r] = await sql`
    SELECT t.id, t.started_at, t.note, t.task_id,
           u.code AS ukol_kod, u.summary AS ukol_nazev,
           c.name AS klient,
           EXTRACT(EPOCH FROM (NOW() - t.started_at))::int AS bezi_sekund
      FROM time_entries t
      LEFT JOIN tasks u ON u.id = t.task_id
      LEFT JOIN crm_companies c ON c.id = u.company_id
     WHERE t.user_id = ${userId} AND t.ended_at IS NULL
  `;
  return r ?? null;
}

/**
 * Spustí stopky. Případné rozjeté měření se nejdřív zastaví — jinak by
 * INSERT spadl na unikátním indexu a uživatel by viděl jen chybu.
 */
export async function spustStopky(sql, userId, { taskId = null, note = '' } = {}) {
  return sql.begin(async tx => {
    const zastavene = await tx`
      UPDATE time_entries SET ended_at = NOW(), modified_at = NOW()
       WHERE user_id = ${userId} AND ended_at IS NULL
       RETURNING id, task_id
    `;
    const sazba = await tx`
      SELECT hourly_rate FROM hr_employments
       WHERE user_id = ${userId} AND active = TRUE AND hourly_rate IS NOT NULL
       ORDER BY started_on DESC NULLS LAST LIMIT 1
    `;
    const [nove] = await tx`
      INSERT INTO time_entries (user_id, task_id, started_at, note, source, hourly_rate)
      VALUES (${userId}, ${taskId}, NOW(), ${note}, 'stopky', ${sazba[0]?.hourly_rate ?? null})
      RETURNING id
    `;
    return { id: nove.id, zastaveno: zastavene[0] ?? null };
  });
}

export async function zastavStopky(sql, userId) {
  const [r] = await sql`
    UPDATE time_entries SET ended_at = NOW(), modified_at = NOW()
     WHERE user_id = ${userId} AND ended_at IS NULL
     RETURNING id, duration_seconds
  `;
  return r ?? null;
}

/** Záznamy jednoho dne. */
export async function zaznamyDne(sql, userId, den) {
  return sql`
    SELECT t.*, t.duration_seconds AS sekund,
           u.code AS ukol_kod, u.summary AS ukol_nazev
      FROM time_entries t
      LEFT JOIN tasks u ON u.id = t.task_id
     WHERE t.user_id = ${userId} AND t.started_at::date = ${den}
     ORDER BY t.started_at
  `;
}

/** Měření, která běží podezřele dlouho — nabídneme je k dořešení. */
export async function zapomenuteStopky(sql, userId = null) {
  const kdo = userId ? sql`AND t.user_id = ${userId}` : sql``;
  return sql`
    SELECT t.id, t.user_id, t.started_at,
           EXTRACT(EPOCH FROM (NOW() - t.started_at))/3600 AS hodin,
           u.code AS ukol_kod, u.summary AS ukol_nazev,
           us.first_name, us.last_name
      FROM time_entries t
      LEFT JOIN tasks u ON u.id = t.task_id
      JOIN users us ON us.id = t.user_id
     WHERE t.ended_at IS NULL
       AND t.started_at < NOW() - (${PODEZRELE_HODIN} || ' hours')::interval
       ${kdo}
     ORDER BY t.started_at
  `;
}

/** Úkoly s filtry a se součtem naměřeného času. */
export async function ukoly(sql, { q = '', stav = '', resitel = null, klient = '', jenNehotove = false } = {}) {
  const kde = [];
  if (q)      kde.push(sql`(t.summary ILIKE ${'%' + q + '%'} OR t.code ILIKE ${'%' + q + '%'})`);
  if (stav)   kde.push(sql`t.status = ${stav}`);
  if (resitel) kde.push(sql`t.assignee_id = ${resitel}`);
  if (klient) kde.push(sql`t.company_id = ${klient}`);
  if (jenNehotove) kde.push(sql`t.status <> 'done'`);
  const where = kde.length ? kde.reduce((a, b) => sql`${a} AND ${b}`, sql`WHERE TRUE`) : sql``;

  return sql`
    SELECT t.*, c.name AS klient,
           u.first_name AS resitel_jmeno, u.last_name AS resitel_prijmeni,
           COALESCE((SELECT SUM(duration_seconds) FROM time_entries e WHERE e.task_id = t.id), 0)::int AS sekund,
           EXISTS (SELECT 1 FROM time_entries e WHERE e.task_id = t.id AND e.ended_at IS NULL) AS bezi
      FROM tasks t
      LEFT JOIN crm_companies c ON c.id = t.company_id
      LEFT JOIN users u ON u.id = t.assignee_id
      ${where}
     ORDER BY t.status = 'done', COALESCE(t.due_date, '9999-12-31'), t.seq DESC NULLS LAST, t.created_at DESC
     LIMIT 300
  `;
}

/** Měsíční výkaz jednoho člověka: po dnech, po úkolech a kontrolní body. */
export async function vykaz(sql, userId, rok, mesic) {
  const od = `${rok}-${String(mesic).padStart(2, '0')}-01`;
  const do_ = new Date(rok, mesic, 0).toISOString().slice(0, 10);

  const [poDnech, poUkolech, [souhrn], problemy] = await Promise.all([
    sql`SELECT started_at::date AS den, SUM(duration_seconds)::int AS sekund, COUNT(*)::int AS pocet
          FROM time_entries WHERE user_id = ${userId}
           AND started_at::date BETWEEN ${od} AND ${do_} AND ended_at IS NOT NULL
         GROUP BY den ORDER BY den`,
    sql`SELECT t.task_id, u.code, u.summary, c.name AS klient,
               SUM(t.duration_seconds)::int AS sekund, COUNT(*)::int AS pocet
          FROM time_entries t
          LEFT JOIN tasks u ON u.id = t.task_id
          LEFT JOIN crm_companies c ON c.id = u.company_id
         WHERE t.user_id = ${userId} AND t.started_at::date BETWEEN ${od} AND ${do_}
           AND t.ended_at IS NOT NULL
         GROUP BY t.task_id, u.code, u.summary, c.name
         ORDER BY sekund DESC`,
    sql`SELECT COALESCE(SUM(duration_seconds),0)::int AS sekund, COUNT(*)::int AS pocet,
               MAX(hourly_rate) AS sazba
          FROM time_entries WHERE user_id = ${userId}
           AND started_at::date BETWEEN ${od} AND ${do_} AND ended_at IS NOT NULL`,
    // Co je potřeba dořešit, než se měsíc uzavře
    sql`SELECT
          (SELECT COUNT(*)::int FROM time_entries WHERE user_id = ${userId} AND ended_at IS NULL) AS bezi,
          (SELECT COUNT(*)::int FROM time_entries WHERE user_id = ${userId}
             AND started_at::date BETWEEN ${od} AND ${do_} AND duration_seconds = 0) AS nulove,
          (SELECT COUNT(*)::int FROM time_entries WHERE user_id = ${userId}
             AND started_at::date BETWEEN ${od} AND ${do_} AND task_id IS NULL AND ended_at IS NOT NULL) AS bez_ukolu`,
  ]);

  return { od, do: do_, poDnech, poUkolech, souhrn, problemy: problemy[0] };
}

/** Sekundy na „3:20" — hodiny a minuty, ne desetinná čísla. */
export function hodinyMinuty(sekund) {
  const s = Math.max(0, Number(sekund) || 0);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

export { generateId };
