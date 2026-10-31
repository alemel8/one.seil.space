// Globální hledání napříč systémem (pole v horní liště, stránka /hledat).
//
// Čistá logika bez Fastify: skupiny výsledků, jejich dotazy a filtrování
// podle přístupové matice. Routy jsou v src/routes/hledani.js.
//
// Smlouva „hledání = seznam“: skupina hledá přesně v těch sloupcích, ve
// kterých filtruje seznam, na který odkazuje „Všechny v seznamu“ — kdo
// najde firmu podle IČO tady, musí ji najít i v seznamu firem. Kdo přidá
// sloupec sem, přidá ho i do filtru seznamu (a naopak).
//
// Práva: skupina se vůbec nedotáže, když uživatel nesmí na její seznam
// (isAllowed s týmž klíčem, kterým strážce rout hlídá URL detailu). Proto
// /hledat nepatří do katalogu v access.js — nemá vlastní data.

import { ACCESS_KEYS, isAllowed, visibleSections } from './access.js';

export const MIN_DELKA = 2;
export const MAX_DELKA = 100;

/** Slug výchozího e-shopu — seznam objednávek ho bere bez parametru (toneracek.js). */
const VYCHOZI_ESHOP = 'toneracek';

/**
 * Jen řetězec (`?q=a&q=b` dá pole), bez NUL (Postgres ho v parametru
 * odmítne a stránka by spadla na 500), sbalené mezery, oříznuté.
 */
export function normalizujDotaz(vstup) {
  if (typeof vstup !== 'string') return '';
  return vstup.replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_DELKA);
}

/** `%` a `_` jsou v LIKE zástupné znaky, `\` je výchozí escape. */
export function escapujLike(s) {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

/** Bez diakritiky a malými písmeny — pro hledání v názvech stránek menu. */
export function bezDiakritiky(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const datum  = (d) => (d ? new Date(d).toLocaleDateString('cs-CZ') : '');
const castka = (n) => (n == null ? '' : Number(n).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Kč');
const spoj   = (...casti) => casti.filter(Boolean).join(' · ');
const jmeno  = (r) => [r.first_name, r.last_name].filter(Boolean).join(' ').trim();

const STAVY_UKOLU = { todo: 'Nezačato', in_progress: 'Pracuje se', testing: 'Testuje se', on_hold: 'Odloženo', done: 'Hotovo' };

/**
 * Skupiny výsledků v pořadí, v jakém se ukazují. `pravo` je klíč položky
 * z ACCESS_SECTIONS; `dotaz` dostane LIKE vzor a limit; `polozka` převede
 * řádek na { titulek, popis, url, stitek }; `odkazSeznam` dostane dotaz
 * a nalezené řádky (objednávky podle nich volí e-shop).
 */
export const SKUPINY = [
  {
    klic: 'firmy', nazev: 'Firmy', pravo: 'crm.firmy',
    odkazSeznam: (q) => `/crm/firmy?q=${encodeURIComponent(q)}`,
    dotaz: (sql, vzor, limit) => sql`
      SELECT id, name, company_type, ico, city
        FROM crm_companies
       WHERE name ILIKE ${vzor} OR city ILIKE ${vzor} OR country ILIKE ${vzor} OR ico ILIKE ${vzor}
       ORDER BY name LIMIT ${limit}`,
    polozka: (r) => ({ titulek: r.name, popis: spoj(r.ico && `IČO ${r.ico}`, r.city), url: `/crm/firmy/${r.id}`, stitek: r.company_type || '' }),
  },
  {
    klic: 'kontakty', nazev: 'Kontakty', pravo: 'crm.kontakty',
    odkazSeznam: (q) => `/crm/kontakty?q=${encodeURIComponent(q)}`,
    dotaz: (sql, vzor, limit) => sql`
      SELECT c.id, c.first_name, c.last_name, c.email, c.phone, co.name AS firma
        FROM crm_contacts c LEFT JOIN crm_companies co ON co.id = c.company_id
       WHERE c.first_name ILIKE ${vzor} OR c.last_name ILIKE ${vzor} OR c.email ILIKE ${vzor} OR c.phone ILIKE ${vzor}
       ORDER BY c.last_name, c.first_name LIMIT ${limit}`,
    polozka: (r) => ({ titulek: jmeno(r) || r.email || '—', popis: spoj(r.email, r.firma), url: `/crm/kontakty/${r.id}`, stitek: '' }),
  },
  {
    klic: 'objednavky', nazev: 'Objednávky', pravo: 'ucetnictvi.objednavky',
    // Seznam ukazuje jeden e-shop (bez parametru Toneráček). Když všechny
    // nalezené objednávky patří jinému e-shopu, odkaz ho předá; jinak vede
    // na výchozí seznam a e-shop je v popisu řádku.
    odkazSeznam: (q, radky = []) => {
      const slugy = new Set(radky.map((r) => r.eshop_slug));
      const slug = slugy.size === 1 ? [...slugy][0] : null;
      const p = [`q=${encodeURIComponent(q)}`];
      if (slug && slug !== VYCHOZI_ESHOP) p.push(`eshop=${encodeURIComponent(slug)}`);
      return `/ucetnictvi/objednavky?${p.join('&')}`;
    },
    dotaz: (sql, vzor, limit) => sql`
      SELECT o.id, o.order_number, o.status, o.first_name, o.last_name, o.company, o.email,
             o.total_price, o.created_at, s.name AS eshop, s.slug AS eshop_slug
        FROM shop_orders o JOIN shops s ON s.id = o.shop_id
       WHERE o.order_number ILIKE ${vzor} OR o.first_name ILIKE ${vzor} OR o.last_name ILIKE ${vzor}
          OR o.email ILIKE ${vzor} OR o.phone ILIKE ${vzor} OR o.invoice_number ILIKE ${vzor} OR o.company ILIKE ${vzor}
       ORDER BY o.created_at DESC LIMIT ${limit}`,
    polozka: (r) => ({
      titulek: spoj(`#${r.order_number}`, r.company || jmeno(r) || r.email),
      popis: spoj(r.eshop, datum(r.created_at), castka(r.total_price)),
      url: `/ucetnictvi/objednavky/${r.id}`, stitek: r.status || '',
    }),
  },
  {
    klic: 'vydane-faktury', nazev: 'Vydané faktury', pravo: 'ucetnictvi.vydane-faktury',
    odkazSeznam: (q) => `/ucetnictvi/vydane-faktury?q=${encodeURIComponent(q)}`,
    // Detail bere i zálohové faktury (proforma), seznam jen vydané — proto
    // štítek „Zálohová“, ať je jasné, proč ji seznam neukáže.
    dotaz: (sql, vzor, limit) => sql`
      SELECT id, number, type, status, client_name, issue_date, total_amount
        FROM accounting_invoices
       WHERE type IN ('issued', 'proforma') AND (number ILIKE ${vzor} OR client_name ILIKE ${vzor})
       ORDER BY issue_date DESC, number DESC LIMIT ${limit}`,
    polozka: (r) => ({
      titulek: r.number, popis: spoj(r.client_name, datum(r.issue_date), castka(r.total_amount)),
      url: `/ucetnictvi/vydane-faktury/${r.id}`, stitek: r.type === 'proforma' ? 'Zálohová' : (r.status || ''),
    }),
  },
  {
    klic: 'prijate-faktury', nazev: 'Přijaté faktury', pravo: 'ucetnictvi.prijate-faktury',
    odkazSeznam: (q) => `/ucetnictvi/prijate-faktury?q=${encodeURIComponent(q)}`,
    dotaz: (sql, vzor, limit) => sql`
      SELECT id, number, status, supplier, issue_date, total_amount
        FROM accounting_invoices
       WHERE type = 'received' AND (number ILIKE ${vzor} OR supplier ILIKE ${vzor})
       ORDER BY issue_date DESC LIMIT ${limit}`,
    polozka: (r) => ({
      titulek: r.number, popis: spoj(r.supplier, datum(r.issue_date), castka(r.total_amount)),
      url: `/ucetnictvi/prijate-faktury/${r.id}`, stitek: r.status || '',
    }),
  },
  {
    klic: 'uctenky', nazev: 'Účtenky', pravo: 'ucetnictvi.uctenky',
    odkazSeznam: (q) => `/ucetnictvi/uctenky?q=${encodeURIComponent(q)}`,
    dotaz: (sql, vzor, limit) => sql`
      SELECT id, vendor, number, receipt_date, category, total_amount, status
        FROM receipts
       WHERE vendor ILIKE ${vzor} OR number ILIKE ${vzor} OR notes ILIKE ${vzor}
       ORDER BY receipt_date DESC, id DESC LIMIT ${limit}`,
    polozka: (r) => ({
      titulek: r.vendor || r.number || 'Účtenka', popis: spoj(r.vendor && r.number, datum(r.receipt_date), r.category, castka(r.total_amount)),
      url: `/ucetnictvi/uctenky/${r.id}`, stitek: r.status || '',
    }),
  },
  {
    klic: 'projekty', nazev: 'Projekty', pravo: 'projekty.seznam',
    odkazSeznam: (q) => `/projekty?q=${encodeURIComponent(q)}`,
    dotaz: (sql, vzor, limit) => sql`
      SELECT p.id, p.name, p.status, c.name AS firma
        FROM projects p JOIN crm_companies c ON c.id = p.company_id
       WHERE p.name ILIKE ${vzor} OR c.name ILIKE ${vzor}
       ORDER BY p.modified_at DESC LIMIT ${limit}`,
    polozka: (r) => ({ titulek: r.name, popis: r.firma || '', url: `/projekty/${r.id}`, stitek: r.status || '' }),
  },
  {
    klic: 'ukoly', nazev: 'Úkoly', pravo: 'prace.ukoly',
    // /prace/ukoly ukazuje všem všechny úkoly, hledání dělá totéž; `vse=1`
    // kvůli tomu, že seznam bez něj skrývá hotové.
    odkazSeznam: (q) => `/prace/ukoly?q=${encodeURIComponent(q)}&vse=1`,
    dotaz: (sql, vzor, limit) => sql`
      SELECT t.id, t.code, t.summary, t.status, c.name AS klient
        FROM tasks t LEFT JOIN crm_companies c ON c.id = t.company_id
       WHERE t.summary ILIKE ${vzor} OR t.code ILIKE ${vzor}
       ORDER BY (t.status = 'done'), t.modified_at DESC LIMIT ${limit}`,
    polozka: (r) => ({ titulek: spoj(r.code, r.summary) || 'Úkol', popis: r.klient || '', url: `/prace/ukoly/${r.id}`, stitek: STAVY_UKOLU[r.status] || '' }),
  },
  {
    klic: 'tym', nazev: 'Tým', pravo: 'lide.tym',
    odkazSeznam: (q) => `/lide/tym?q=${encodeURIComponent(q)}`,
    dotaz: (sql, vzor, limit) => sql`
      SELECT public_id, first_name, last_name, email, is_admin, is_active
        FROM users
       WHERE first_name ILIKE ${vzor} OR last_name ILIKE ${vzor} OR email ILIKE ${vzor}
       ORDER BY last_name, first_name LIMIT ${limit}`,
    polozka: (r) => ({
      titulek: jmeno(r) || r.email, popis: r.email, url: `/lide/tym/${r.public_id}`,
      stitek: r.is_admin ? 'Správce' : (r.is_active === false ? 'Neaktivní' : ''),
    }),
  },
];

for (const s of SKUPINY) {
  // Překlep v právu by skupinu otevřel všem — isAllowed neznámý klíč neomezuje.
  if (!ACCESS_KEYS.includes(s.pravo)) throw new Error(`Hledání: skupina ${s.klic} má právo mimo katalog: ${s.pravo}`);
}

/** Skupiny, na jejichž seznam uživatel smí. */
export function povoleneSkupiny(user) {
  return SKUPINY.filter((s) => isAllowed(user, s.pravo));
}

/**
 * Stránky z levého menu, na které uživatel vidí — porovnání bez diakritiky,
 * ať „ucetnictvi“ najde Účetnictví. Dotaz už je normalizovaný.
 */
export function hledejStranky(user, q) {
  const hledany = bezDiakritiky(q);
  if (!hledany) return [];
  const polozky = [];
  for (const section of visibleSections(user)) {
    for (const item of section.items) {
      if (!bezDiakritiky(`${section.label} ${item.label}`).includes(hledany)) continue;
      polozky.push({ titulek: item.label, popis: item.label === section.label ? '' : section.label, url: item.path, stitek: '' });
    }
  }
  return polozky;
}

/**
 * Výsledky po skupinách: [{ klic, nazev, odkazSeznam, polozky, plny }].
 * `plny` = skupina dosáhla limitu, seznam má víc. Pod MIN_DELKA se do
 * databáze nejde vůbec.
 */
export async function hledej(sql, user, vstup, { limitNaSkupinu = 10 } = {}) {
  const q = normalizujDotaz(vstup);
  if (q.length < MIN_DELKA) return [];
  const limit = Math.min(50, Math.max(1, limitNaSkupinu | 0));
  const vzor = '%' + escapujLike(q) + '%';

  const povolene = povoleneSkupiny(user);
  const radky = await Promise.all(povolene.map((s) => s.dotaz(sql, vzor, limit)));

  const skupiny = [];
  const stranky = hledejStranky(user, q);
  if (stranky.length) {
    skupiny.push({ klic: 'stranky', nazev: 'Stránky', odkazSeznam: '', polozky: stranky.slice(0, limit), plny: stranky.length > limit });
  }
  povolene.forEach((s, i) => {
    if (!radky[i].length) return;
    skupiny.push({
      klic: s.klic, nazev: s.nazev, odkazSeznam: s.odkazSeznam(q, radky[i]),
      polozky: radky[i].map(s.polozka), plny: radky[i].length >= limit,
    });
  });
  return skupiny;
}
