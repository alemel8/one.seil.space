// Přístupová matice — katalog sekcí systému a vyhodnocení práv.
//
// Jeden zdroj pravdy pro tři místa: matici v Lidé & Kultura → Přístupy,
// položky v levém menu a strážce rout na serveru. Kdo přidá novou sekci do
// sidebaru, přidá ji i sem — jinak ji matice nezná a zůstane přístupná všem.
//
// Práva umí jen ubírat, ne přidávat: co je adminOnly, zůstane adminOnly i
// se zaškrtnutým políčkem. Bez uloženého záznamu platí „vidí“ — jinak by
// nasazení migrace odřízlo všechny od všeho. Výjimkou jsou položky
// s defaultDeny, které se otevřou až vědomým zaškrtnutím v matici.

export const ACCESS_SECTIONS = [
  {
    key: 'home',
    label: 'Domovská stránka',
    items: [
      { key: 'home.prehled', label: 'Přehled', path: '/', exact: true },
    ],
  },
  {
    key: 'projekty',
    label: 'Projekty',
    items: [
      { key: 'projekty.seznam', label: 'Projekty', path: '/projekty' },
    ],
  },
  {
    key: 'monitoring',
    label: 'Monitoring',
    items: [
      { key: 'monitoring.vps', label: 'Aktuální stav VPS', path: '/monitoring' },
      {
        key: 'monitoring.healthchecky', label: 'Healthchecky & notifikace',
        path: '/nastaveni/healthchecky', extraPaths: ['/nastaveni/notifikace'],
        adminOnly: true,
      },
    ],
  },
  {
    key: 'ucetnictvi',
    label: 'Účetnictví',
    items: [
      { key: 'ucetnictvi.prehled',         label: 'Finanční přehled', path: '/ucetnictvi/prehled' },
      { key: 'ucetnictvi.objednavky',      label: 'Objednávky',       path: '/ucetnictvi/objednavky', extraPaths: ['/ucetnictvi/migrace'] },
      { key: 'ucetnictvi.prijate-faktury', label: 'Přijaté faktury',  path: '/ucetnictvi/prijate-faktury' },
      { key: 'ucetnictvi.vydane-faktury',  label: 'Vydané faktury',   path: '/ucetnictvi/vydane-faktury' },
      { key: 'ucetnictvi.upominky',        label: 'Upomínky',         path: '/ucetnictvi/upominky' },
      { key: 'ucetnictvi.sablony-faktur',  label: 'Šablony faktur',   path: '/ucetnictvi/sablony-faktur' },
      { key: 'ucetnictvi.uctenky',         label: 'Účtenky',          path: '/ucetnictvi/uctenky' },
      { key: 'ucetnictvi.banka',           label: 'Banka',            path: '/ucetnictvi/banka' },
    ],
  },
  {
    key: 'crm',
    label: 'CRM',
    items: [
      { key: 'crm.firmy',    label: 'Firmy',    path: '/crm/firmy', extraPaths: ['/crm/smlouvy'] },
      { key: 'crm.kontakty', label: 'Kontakty', path: '/crm/kontakty' },
    ],
  },
  {
    key: 'trade',
    label: 'Trade SEIL',
    items: [
      { key: 'trade.prehled', label: 'Paper trading', path: '/trade' },
    ],
  },
  {
    key: 'nastaveni',
    label: 'Nastavení',
    adminOnly: true,
    items: [
      { key: 'nastaveni.firma',         label: 'Nastavení firmy',   path: '/nastaveni/firma' },
      { key: 'nastaveni.ciselne-rady',  label: 'Číselné řady',      path: '/nastaveni/ciselne-rady' },
      { key: 'nastaveni.ucetni-osnova', label: 'Účetní osnova',     path: '/nastaveni/ucetni-osnova' },
      { key: 'nastaveni.eshopy',        label: 'Eshopy & API klíče', path: '/nastaveni/eshopy' },
    ],
  },
  {
    key: 'lide',
    label: 'Lidé & Kultura',
    adminOnly: true,
    items: [
      { key: 'lide.tym',       label: 'Tým',                 path: '/lide/tym' },
      { key: 'lide.ekonomika', label: 'Ekonomika lidí',      path: '/lide/ekonomika', defaultDeny: true },
      { key: 'lide.mzdy',      label: 'Mzdy',                path: '/lide/mzdy',      defaultDeny: true },
      { key: 'lide.podklady',  label: 'Fakturační podklady', path: '/lide/podklady' },
      // Editor přístupů si nelze odebrat — viz isAllowed()
      { key: 'lide.pristupy',  label: 'Přístupy',            path: '/lide/pristupy', locked: true },
    ],
  },
];

// Plochý seznam všech položek i s odkazem na nadřazenou sekci.
export const ACCESS_ITEMS = ACCESS_SECTIONS.flatMap(
  section => section.items.map(item => ({ ...item, section }))
);

export const ACCESS_KEYS = ACCESS_ITEMS.map(i => i.key);

const ITEMS_BY_KEY = new Map(ACCESS_ITEMS.map(i => [i.key, i]));

export function accessItem(key) {
  return ITEMS_BY_KEY.get(key) ?? null;
}

// ── Vyhodnocení práv ────────────────────────────────────────────

/**
 * Vidí uživatel danou položku?
 * @param user  řádek z users, včetně `access` (objekt key → bool)
 * @param item  položka katalogu nebo její klíč
 */
export function isAllowed(user, item) {
  if (!user) return false;
  const it = typeof item === 'string' ? accessItem(item) : item;
  if (!it) return true;               // co katalog nezná, to neomezuje

  // Role je tvrdší než matice — zaškrtnutí nepovýší uživatele na správce.
  if ((it.adminOnly || it.section?.adminOnly) && !user.is_admin) return false;

  // Pojistka proti zamčení: správce vždy dosáhne na editor přístupů.
  if (it.locked && user.is_admin) return true;

  const saved = user.access?.[it.key];
  if (saved !== undefined && saved !== null) return Boolean(saved);

  // Bez uloženého záznamu platí „vidí" — jinak by přidání nové sekce
  // odřízlo všechny, dokud by někdo neproklikal matici. U citlivých
  // položek je to ale obráceně: výplatní pásku má vidět ten, komu ji
  // někdo vědomě zpřístupní, ne každý, kdo se náhodou stal správcem.
  return !it.defaultDeny;
}

/** Sekce je vidět, pokud je vidět aspoň jedna její položka. */
export function visibleItems(user, section) {
  return section.items.filter(item => isAllowed(user, { ...item, section }));
}

/**
 * Strom katalogu ořezaný na to, co uživatel vidí — pro sidebar.
 * Prázdné sekce vypadnou.
 */
export function visibleSections(user) {
  return ACCESS_SECTIONS
    .map(section => ({ ...section, items: visibleItems(user, section) }))
    .filter(section => section.items.length > 0);
}

// ── Mapování URL → položka katalogu ─────────────────────────────

/** Sedí cesta `pathname` na `base` (přesně, nebo jako podstrom)? */
function matchesPath(pathname, base, exact) {
  if (pathname === base) return true;
  if (exact) return false;
  return pathname.startsWith(base.endsWith('/') ? base : base + '/');
}

/**
 * Najde položku katalogu, pod kterou spadá URL požadavku.
 * Vrací null pro cesty mimo katalog (API, profil, statika) — ty matice neřeší.
 * Při překryvu vyhrává nejdelší shoda (/nastaveni/eshopy před /nastaveni).
 */
export function matchAccessItem(url) {
  const pathname = String(url || '').split('?')[0].split('#')[0] || '/';
  let best = null;
  let bestLen = -1;

  for (const item of ACCESS_ITEMS) {
    for (const base of [item.path, ...(item.extraPaths || [])]) {
      if (matchesPath(pathname, base, item.exact) && base.length > bestLen) {
        best = item;
        bestLen = base.length;
      }
    }
  }
  return best;
}

// ── Načtení z DB ────────────────────────────────────────────────

/** Uloží celou matici jednoho uživatele; `allowedKeys` je seznam zaškrtnutých. */
export async function saveUserAccess(sql, userId, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const rows = ACCESS_KEYS.map(key => ({
    user_id: userId,
    access_key: key,
    allowed: allowed.has(key),
  }));

  await sql`
    INSERT INTO user_access ${sql(rows, 'user_id', 'access_key', 'allowed')}
    ON CONFLICT (user_id, access_key)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = NOW()
  `;
}

/** Matice více uživatelů najednou: { [user_id]: { [key]: bool } }. */
export async function loadAccessMatrix(sql, userIds) {
  if (!userIds.length) return {};
  const rows = await sql`
    SELECT user_id, access_key, allowed FROM user_access
    WHERE user_id = ANY(${userIds})
  `;
  const out = {};
  for (const id of userIds) out[id] = {};
  for (const r of rows) {
    if (out[r.user_id]) out[r.user_id][r.access_key] = r.allowed;
  }
  return out;
}
