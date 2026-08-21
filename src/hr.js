// Personální agenda — dotazy nad osobním účtem člověka.
//
// Airtable to nepojmenoval, ale je to běžný účet jednoho člověka:
//   příjmy   = co se za jeho práci vyfakturovalo (fakturační podklady)
//   výdaje   = co se mu vyplatilo na mzdě (reálně odeslané platby)
//   ostatní  = co dostal mimo mzdu (zálohy, proplacené nákupy)
//   zůstatek = příjmy − výdaje − ostatní
//
// Pozor na dvě různá čísla se stejným jménem. Do osobního zůstatku patří
// paid_total (co odešlo z účtu), do nákladů firmy a hrubého zisku naopak
// company_cost (hrubá + odvody zaměstnavatele). Nejsou zaměnitelné a u části
// měsíců se liší.

/** Zůstatek jednoho člověka; volitelně omezený na rok. */
export async function osobniUcet(sql, userId, { rok = null } = {}) {
  const obdobiPodkladu = rok
    ? sql`AND EXTRACT(YEAR FROM report_date) = ${rok}` : sql``;
  const obdobiMezd = rok
    ? sql`AND EXTRACT(YEAR FROM period) = ${rok}` : sql``;
  const obdobiPlateb = rok
    ? sql`AND EXTRACT(YEAR FROM paid_on) = ${rok}` : sql``;

  const [[prijmy], [mzdy], [ostatni]] = await Promise.all([
    sql`SELECT COALESCE(SUM(total_amount),0)::float8 AS castka, COUNT(*)::int AS pocet
          FROM hr_work_reports
         WHERE user_id = ${userId} AND status <> 'storno' ${obdobiPodkladu}`,
    // Hotovost se přičítá k UHRAZENO: u dohody šla část odměny mimo mzdový
    // list a bez ní by osobní účet tvrdil, že člověk nedostal nic.
    // U HPP je cash_paid nula, takže se kontrolní součty nehnou.
    sql`SELECT COALESCE(SUM(paid_total + cash_paid),0)::float8 AS castka,
               COALESCE(SUM(company_cost),0)::float8 AS naklad_firmy,
               COALESCE(SUM(hours),0)::float8        AS hodiny,
               COALESCE(SUM(earned),0)::float8       AS odmena,
               COUNT(*)::int AS pocet
          FROM hr_payroll_runs WHERE user_id = ${userId} ${obdobiMezd}`,
    sql`SELECT COALESCE(SUM(amount),0)::float8 AS castka, COUNT(*)::int AS pocet
          FROM hr_payroll_items WHERE user_id = ${userId} ${obdobiPlateb}`,
  ]);

  return {
    prijmy: prijmy.castka,   prijmyPocet: prijmy.pocet,
    vydaje: mzdy.castka,     vydajePocet: mzdy.pocet,
    nakladFirmy: mzdy.naklad_firmy,
    hodiny: mzdy.hodiny,     odmena: mzdy.odmena,
    ostatni: ostatni.castka, ostatniPocet: ostatni.pocet,
    zustatek: prijmy.castka - mzdy.castka - ostatni.castka,
  };
}

/** Osobní účty všech lidí naráz — pro přehled napříč týmem. */
export async function osobniUctyVsech(sql, { rok = null } = {}) {
  const lide = await sql`
    SELECT id, public_id, first_name, last_name, email, photo, is_active
      FROM users ORDER BY id
  `;
  const ucty = await Promise.all(lide.map(u => osobniUcet(sql, u.id, { rok })));
  return lide
    .map((u, i) => ({ ...u, ucet: ucty[i] }))
    // Kdo nemá žádná data, do přehledu ziskovosti nepatří — jen by ho ředil
    .filter(u => u.ucet.prijmyPocet || u.ucet.vydajePocet || u.ucet.ostatniPocet);
}

/**
 * Poslední pohyby na osobním účtu — sloučené ze všech tří zdrojů.
 * Bez tohohle jsou čísla v dlaždicích magie, na kterou se nedá kliknout.
 */
export async function posledniPohyby(sql, userId, limit = 12) {
  return sql`
    (SELECT 'podklad' AS typ, id, report_date AS datum,
            COALESCE(NULLIF(title,''), 'Fakturační podklad') AS popis,
            total_amount::float8 AS castka, status
       FROM hr_work_reports WHERE user_id = ${userId} AND status <> 'storno')
    UNION ALL
    (SELECT 'mzda', id, period,
            'Mzda ' || to_char(period, 'MM/YYYY'),
            -paid_total::float8, CASE WHEN paid THEN 'vyplaceno' ELSE 'nevyplaceno' END
       FROM hr_payroll_runs WHERE user_id = ${userId})
    UNION ALL
    (SELECT 'platba', id, paid_on,
            COALESCE(NULLIF(description,''), 'Platba mimo mzdu'),
            -amount::float8, kind
       FROM hr_payroll_items WHERE user_id = ${userId})
    ORDER BY datum DESC, typ
    LIMIT ${limit}
  `;
}

/** Fakturační podklady člověka i s počty příloh a stavem navázané faktury. */
export async function podkladyUzivatele(sql, userId) {
  return sql`
    SELECT w.*,
           i.number AS faktura_cislo, i.status AS faktura_stav, i.total_amount::float8 AS faktura_castka,
           COALESCE(ARRAY(SELECT DISTINCT project_code FROM hr_work_report_projects
                           WHERE report_id = w.id ORDER BY project_code), '{}') AS kody,
           COALESCE(ARRAY(SELECT DISTINCT city FROM hr_work_report_locations
                           WHERE report_id = w.id ORDER BY city), '{}') AS lokality,
           (SELECT COUNT(*)::int FROM attachments a
             WHERE a.work_report_id = w.id AND a.category = 'rozpis_prace')      AS priloh_rozpis,
           (SELECT COUNT(*)::int FROM attachments a
             WHERE a.work_report_id = w.id AND a.category = 'vydajovy_doklad')   AS priloh_doklady
      FROM hr_work_reports w
      LEFT JOIN accounting_invoices i ON i.id = w.invoice_id
     WHERE w.user_id = ${userId}
     ORDER BY w.report_date DESC
  `;
}

/** Mzdové listy člověka. Měsíc s víc listy označíme — Airtable jich vedl víc. */
export async function mzdyUzivatele(sql, userId) {
  const rows = await sql`
    SELECT r.*, r.paid_total::float8 AS paid_total, r.company_cost::float8 AS company_cost,
           (SELECT COUNT(*)::int FROM attachments a WHERE a.payroll_run_id = r.id) AS priloh
      FROM hr_payroll_runs r
     WHERE r.user_id = ${userId}
     ORDER BY r.period DESC, r.id
  `;
  const pocty = new Map();
  for (const r of rows) {
    const k = String(r.period).slice(0, 7);
    pocty.set(k, (pocty.get(k) ?? 0) + 1);
  }
  for (const r of rows) r.mesic_ma_vic_listu = pocty.get(String(r.period).slice(0, 7)) > 1;
  return rows;
}

/** Platby mimo mzdu. */
export async function platbyUzivatele(sql, userId) {
  return sql`
    SELECT p.*, p.amount::float8 AS amount,
           (SELECT COUNT(*)::int FROM attachments a WHERE a.payroll_item_id = p.id) AS priloh
      FROM hr_payroll_items p
     WHERE p.user_id = ${userId}
     ORDER BY p.paid_on DESC, p.id
  `;
}

/** Osobní a smluvní dokumenty. */
export async function dokumentyUzivatele(sql, userId) {
  return sql`
    SELECT d.*,
           (SELECT COUNT(*)::int FROM attachments a WHERE a.document_id = d.id) AS priloh
      FROM hr_documents d
     WHERE d.user_id = ${userId}
     ORDER BY COALESCE(d.document_date, d.created_at::date) DESC, d.id
  `;
}

/** Mzdy napříč lidmi za rok — mřížka měsíc × člověk. */
export async function mzdyPrehled(sql, rok) {
  const rows = await sql`
    SELECT r.id, r.user_id, r.period, r.paid, r.hours,
           r.gross::float8 AS gross, r.paid_total::float8 AS paid_total,
           r.company_cost::float8 AS company_cost,
           (SELECT COUNT(*)::int FROM attachments a WHERE a.payroll_run_id = r.id) AS priloh
      FROM hr_payroll_runs r
     WHERE EXTRACT(YEAR FROM r.period) = ${rok}
     ORDER BY r.period DESC, r.user_id
  `;
  const lide = await sql`
    SELECT DISTINCT u.id, u.public_id, u.first_name, u.last_name
      FROM users u JOIN hr_payroll_runs r ON r.user_id = u.id
     ORDER BY u.id
  `;
  // Mřížka ukáže i díru v měsíci — u souvislé řady je to to hlavní,
  // co chcete hlídat, a plochý seznam by ji schoval.
  const mesice = [...new Set(rows.map(r => String(r.period).slice(0, 7)))].sort().reverse();
  const bunky = new Map(rows.map(r => [`${String(r.period).slice(0, 7)}|${r.user_id}`, r]));
  return { lide, mesice, bunky, rows };
}

/** Roky, ve kterých vůbec nějaká mzda je — do přepínače období. */
export async function mzdoveRoky(sql) {
  const r = await sql`SELECT DISTINCT EXTRACT(YEAR FROM period)::int AS rok
                        FROM hr_payroll_runs ORDER BY rok DESC`;
  return r.map(x => x.rok);
}

/** Fakturační podklady napříč lidmi, s volitelnými filtry. */
export async function podkladyPrehled(sql, { q = '', stav = '', osoba = '' } = {}) {
  const kde = [];
  if (q)     kde.push(sql`(w.title ILIKE ${'%' + q + '%'} OR w.invoice_number ILIKE ${'%' + q + '%'})`);
  if (stav)  kde.push(sql`w.status = ${stav}`);
  if (osoba) kde.push(sql`u.public_id = ${osoba}`);
  const where = kde.length
    ? kde.reduce((a, b) => sql`${a} AND ${b}`, sql`WHERE TRUE`) : sql``;

  return sql`
    SELECT w.*, w.total_amount::float8 AS total_amount,
           u.public_id, u.first_name, u.last_name,
           i.number AS faktura_cislo, i.status AS faktura_stav,
           COALESCE(ARRAY(SELECT DISTINCT project_code FROM hr_work_report_projects
                           WHERE report_id = w.id ORDER BY project_code), '{}') AS kody,
           COALESCE(ARRAY(SELECT DISTINCT city FROM hr_work_report_locations
                           WHERE report_id = w.id ORDER BY city), '{}') AS lokality,
           (SELECT COUNT(*)::int FROM attachments a WHERE a.work_report_id = w.id) AS priloh
      FROM hr_work_reports w
      JOIN users u ON u.id = w.user_id
      LEFT JOIN accounting_invoices i ON i.id = w.invoice_id
      ${where}
     ORDER BY w.report_date DESC
  `;
}

/** Jeden mzdový list i s dokumenty rozdělenými podle typu. */
export async function mzdaDetail(sql, id) {
  const [mzda] = await sql`
    SELECT r.*, r.paid_total::float8 AS paid_total, r.company_cost::float8 AS company_cost,
           u.public_id, u.first_name, u.last_name, e.kind AS uvazek
      FROM hr_payroll_runs r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN hr_employments e ON e.id = r.employment_id
     WHERE r.id = ${id}
  `;
  if (!mzda) return null;
  const soubory = await sql`
    SELECT id, original_name, mime, size, category, created_at
      FROM attachments WHERE payroll_run_id = ${id} ORDER BY category, sort_order, id
  `;
  const [sousedi] = await sql`
    SELECT (SELECT id FROM hr_payroll_runs WHERE user_id = ${mzda.user_id}
             AND period < ${mzda.period} ORDER BY period DESC LIMIT 1) AS predchozi,
           (SELECT id FROM hr_payroll_runs WHERE user_id = ${mzda.user_id}
             AND period > ${mzda.period} ORDER BY period LIMIT 1) AS dalsi
  `;
  return { mzda, soubory, sousedi };
}

/** Jeden fakturační podklad i s přílohami v obou rolích. */
export async function podkladDetail(sql, id) {
  const [podklad] = await sql`
    SELECT w.*, w.total_amount::float8 AS total_amount,
           u.public_id, u.first_name, u.last_name,
           i.number AS faktura_cislo, i.status AS faktura_stav,
           i.total_amount::float8 AS faktura_castka, i.issue_date AS faktura_datum,
           COALESCE(ARRAY(SELECT DISTINCT project_code FROM hr_work_report_projects
                           WHERE report_id = w.id ORDER BY project_code), '{}') AS kody
      FROM hr_work_reports w
      JOIN users u ON u.id = w.user_id
      LEFT JOIN accounting_invoices i ON i.id = w.invoice_id
     WHERE w.id = ${id}
  `;
  if (!podklad) return null;
  const [lokality, soubory] = await Promise.all([
    sql`SELECT city, country FROM hr_work_report_locations WHERE report_id = ${id} ORDER BY city`,
    sql`SELECT id, original_name, mime, size, category, sort_order
          FROM attachments WHERE work_report_id = ${id} ORDER BY category, sort_order, id`,
  ]);
  return { podklad, lokality, soubory };
}

/** Popisky kategorií příloh — jedno místo pro celé UI. */
export const KATEGORIE_PRILOH = {
  vyplatni_paska:   'Výplatní páska',
  mzdovy_rozpis:    'Podklady od mzdové účetní',
  prikaz_k_uhrade:  'Příkaz k úhradě',
  epodani_cssz:     'E-podání na ČSSZ',
  rozpis_prace:     'Rozpis práce',
  vydajovy_doklad:  'Výdajové doklady',
  vystavena_faktura:'Vystavená faktura',
  smluvni_dokument: 'Dokument',
  doklad_o_nakupu:  'Doklad o nákupu',
  priloha_ukolu:    'Příloha úkolu',
};

export const PLATBA_DRUHY = [
  ['zaloha',            'Záloha'],
  ['proplaceny_naklad', 'Proplacený náklad'],
  ['odmena',            'Odměna'],
  ['srazka',            'Srážka'],
  ['jine',              'Jiné'],
];

export const PODKLAD_STAVY = [
  ['rozpracovano', 'Rozpracováno'],
  ['k_fakturaci',  'K fakturaci'],
  ['odeslano',     'Odesláno'],
  ['fakturovano',  'Vyfakturováno'],
  ['storno',       'Storno'],
];

export const UVAZKY = [
  ['hpp',      'Hlavní pracovní poměr'],
  ['dpp',      'Dohoda o provedení práce'],
  ['dpc',      'Dohoda o pracovní činnosti'],
  ['osvc',     'OSVČ / fakturace'],
  ['jednatel', 'Jednatel'],
];

/**
 * Naměřený čas po měsících, vedle hodin ve mzdě za tentýž měsíc.
 * Rozdíl se ZÁMĚRNĚ nedopočítává na nulu — v datech z Airtable jsou měsíce,
 * kde se hodiny vykázaly bez měření i naopak, a schovat to by znamenalo
 * tvářit se, že evidence sedí, když nesedí.
 */
export async function hodinyPoMesicich(sql, userId) {
  return sql`
    WITH mereni AS (
      SELECT date_trunc('month', started_at)::date AS obdobi,
             COUNT(*)::int                          AS zaznamu,
             COALESCE(SUM(duration_seconds), 0)::bigint AS sekund,
             COUNT(*) FILTER (WHERE ended_at IS NULL)::int AS bezi
        FROM time_entries WHERE user_id = ${userId}
       GROUP BY 1
    ), mzdy AS (
      SELECT period AS obdobi, SUM(hours)::float8 AS hodiny
        FROM hr_payroll_runs WHERE user_id = ${userId} AND hours IS NOT NULL
       GROUP BY 1
    )
    SELECT COALESCE(m.obdobi, z.obdobi)         AS obdobi,
           COALESCE(m.zaznamu, 0)               AS zaznamu,
           COALESCE(m.sekund, 0)::float8 / 3600 AS namereno,
           COALESCE(m.bezi, 0)                  AS bezi,
           z.hodiny                             AS ve_mzde
      FROM mereni m FULL OUTER JOIN mzdy z ON z.obdobi = m.obdobi
     ORDER BY 1 DESC
  `;
}
