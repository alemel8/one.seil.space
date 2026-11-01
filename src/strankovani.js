// Stránkování seznamů: čísla, odkazy a okno stran bez databáze a bez šablon.
// Zobrazení je views/includes/strankovani.ejs, popis v docs/moduly.md (Stránkování).
//
//   const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM crm_companies ${where}`;
//   const strany = strankovani({ cesta: '/crm/firmy', query: request.query, celkem: n, zachovat: ['q', 'type'] });
//   const firmy = await sql`SELECT * ... ORDER BY name, id LIMIT ${strany.naStranku} OFFSET ${strany.offset}`;
//
// Pořadí je podstatné: číslo stránky se omezí až podle počtu řádků, takže stránka
// za koncem (třeba po smazání posledního řádku) ukáže poslední řádky, ne prázdnou
// tabulku. ORDER BY musí končit jednoznačným klíčem, jinak se řádek se stejnou
// hodnotou může mezi stránkami opakovat nebo ztratit.

export const VELIKOSTI = [25, 50, 100];

/** První hodnota parametru z query jako text. ?q=a&q=b dá pole, NUL odmítne Postgres. */
export function parametr(hodnota) {
  const v = Array.isArray(hodnota) ? hodnota[0] : hodnota;
  return typeof v === 'string' ? v.replace(/\0/g, '').trim() : '';
}

/** Číslo stránky: jen kladné celé číslo v desítkovém zápisu, cokoli jiného je první stránka. */
export function cisloStranky(hodnota) {
  const text = parametr(hodnota);
  if (!/^\d+$/.test(text)) return 1;
  const n = Number(text);
  if (n < 1) return 1;
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** Počet řádků na stránku: jen z nabídky, neznámá hodnota je výchozí. */
export function velikostStranky(hodnota, vychozi = VELIKOSTI[0]) {
  const n = Number(parametr(hodnota));
  return VELIKOSTI.includes(n) ? n : vychozi;
}

/**
 * Čísla stran k zobrazení, null je vynechané místo. Do 7 stran všechny, jinak
 * první, poslední a okolí aktuální. Vynechá se jen víc než jedna strana:
 * „1 … 3“ by zabralo stejné místo jako „1 2 3“ a nic neřeklo.
 */
export function oknoStran(strana, pocetStran) {
  if (pocetStran <= 7) return Array.from({ length: pocetStran }, (_, i) => i + 1);
  const vybrane = [1, strana - 1, strana, strana + 1, pocetStran].filter(c => c >= 1 && c <= pocetStran);
  const okno = [];
  for (const c of [...new Set(vybrane)].sort((a, b) => a - b)) {
    const predchozi = okno.at(-1);
    if (predchozi !== undefined) {
      if (c - predchozi === 2) okno.push(predchozi + 1);
      else if (c - predchozi > 2) okno.push(null);
    }
    okno.push(c);
  }
  return okno;
}

/**
 * Stránka seznamu z dotazu a počtu řádků.
 *   cesta     adresa seznamu bez query
 *   query     request.query
 *   celkem    počet řádků po použití filtrů
 *   naStranku výchozí velikost stránky (přepsat ji může ?velikost= z VELIKOSTI)
 *   zachovat  filtry a řazení, které mají přežít přechod na jinou stránku. Výčet,
 *             ne kopie celého dotazu: jednorázové saved, error nebo sent by se
 *             jinak znovu ukazovaly při každém listování.
 *   pevne     parametry dané routou, např. { tab: 'faktury' } na záložce detailu
 */
export function strankovani({ cesta, query = {}, celkem, naStranku = VELIKOSTI[0], zachovat = [], pevne = {} }) {
  const velikost = velikostStranky(query.velikost, naStranku);
  const pocetStran = Math.max(1, Math.ceil(celkem / velikost));
  const strana = Math.min(cisloStranky(query.page), pocetStran);

  const zaklad = Object.entries(pevne).map(([k, v]) => [k, String(v)]);
  for (const k of zachovat) {
    const v = parametr(query[k]);
    if (v) zaklad.push([k, v]);
  }
  const adresa = (cislo, vel) => {
    const p = new URLSearchParams(zaklad);
    if (vel !== naStranku) p.set('velikost', String(vel));
    if (cislo > 1) p.set('page', String(cislo));
    const s = p.toString();
    return s ? `${cesta}?${s}` : cesta;
  };

  const offset = (strana - 1) * velikost;
  return {
    strana,
    pocetStran,
    naStranku: velikost,
    celkem,
    offset,
    od: celkem ? offset + 1 : 0,
    do: Math.min(offset + velikost, celkem),
    okno: oknoStran(strana, pocetStran),
    velikosti: VELIKOSTI,
    // Formulář filtru ji nese skrytým polem, jinak by se po odeslání vrátila na výchozí.
    vlastniVelikost: velikost !== naStranku,
    odkaz: (cislo) => adresa(cislo, velikost),
    odkazVelikost: (vel) => adresa(1, vel),
    // Adresa téhle stránky bez jednorázových parametrů: návrat po akci v řádku a „← Zpět“ z detailu.
    aktualni: adresa(strana, velikost),
  };
}
