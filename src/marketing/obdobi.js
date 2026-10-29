/**
 * Období marketingového přehledu: tento měsíc, minulý měsíc, posledních
 * 30 dní, vlastní rozsah.
 *
 * Čisté funkce nad řetězci „YYYY-MM-DD“ — bez databáze a bez `Date` v lokálním
 * pásmu. Přehled dostane z URL `?obdobi=…&od=…&do=…`, tady se z toho udělá
 * uzavřený interval [od, do] a český popisek do nadpisu.
 *
 * ## Konec měsíce se počítá řetězcově
 *
 * `new Date(y, m, 0).toISOString()` vrací poslední den měsíce jen v UTC: pod
 * TZ=Europe/Prague vytvoří půlnoc pražskou, která je v UTC ještě předchozí
 * den, a `toISOString()` tak vrátí o den míň (chyba v dashboard.js:65
 * a accounting.js:399). Proto se tu měsíc skládá jen z `pridejDny()`
 * a `jenDatum()` (src/prazsky-cas.js), které počítají v UTC bez ohledu na
 * pásmo procesu: první den měsíce je prefix „YYYY-MM“ + „-01“, poslední den
 * je „den před prvním dnem následujícího měsíce“.
 *
 * ## Vlastní období má strop
 *
 * Vlastní rozsah smí mít nejvýš 400 dní rozdílu (stejný strop jako první
 * běh syncu), aby jeden odkaz nevytáhl z databáze roky objednávek.
 * Neplatný vstup se nehlásí chybou — přehled se ukáže za tento měsíc
 * a v popisku stojí proč, ať se uživatel nedívá na prázdnou stránku.
 *
 * ## Výčet dní nevěří vstupu
 *
 * `vyctiDny()` nejdřív obě meze ověří přes `jenDatum()` a na neplatné vrátí
 * prázdné pole: řetězcové porovnání by „9999-99-99“ pustilo do smyčky,
 * která by se točila miliony dní, než Date přeteče — a graf i rozpočítání
 * nákladů dostávají meze i odjinud než z `vyhodnotObdobi()`.
 */

import { ceskeDatum, jenDatum, prazskyCas, pridejDny } from '../prazsky-cas.js';

export const PRESETY = ['tento-mesic', 'minuly-mesic', '30-dni', 'vlastni'];

/** Nejvyšší povolený rozdíl `do − od` ve dnech u vlastního období. */
export const MAX_ROZDIL_DNI = 400;

const MESICE = [
  'leden', 'únor', 'březen', 'duben', 'květen', 'červen',
  'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec',
];

const DEN_MS = 86_400_000;

/** „2026-10-29“ → „2026-10-01“. */
export function prvniDenMesice(datum) {
  return `${datum.slice(0, 7)}-01`;
}

/**
 * „2026-02-10“ → „2026-02-28“ (v přestupném roce „-29“). Z prvního dne
 * měsíce skočí 31 dní dopředu — to je vždycky v následujícím měsíci —,
 * vezme jeho první den a vrátí se o den zpět.
 */
export function posledniDenMesice(datum) {
  const prvniDalsiho = prvniDenMesice(pridejDny(prvniDenMesice(datum), 31));
  return pridejDny(prvniDalsiho, -1);
}

/** Rozdíl `do − od` ve dnech (záporný, když je `do` dřív). Počítá v UTC, změna času nic neukousne. */
export function rozdilDni(od, do_) {
  return Math.round((Date.parse(`${do_}T00:00:00Z`) - Date.parse(`${od}T00:00:00Z`)) / DEN_MS);
}

/**
 * Všechny dny od `od` do `do` včetně, vzestupně. Prázdné pole, když je `od`
 * po `do` nebo některá mez není platné datum (viz hlavička).
 */
export function vyctiDny(od, do_) {
  const zacatek = jenDatum(od);
  const konec = jenDatum(do_);
  if (!zacatek || !konec) return [];
  const dny = [];
  for (let den = zacatek; den <= konec; den = pridejDny(den, 1)) dny.push(den);
  return dny;
}

/** „2026-10-29“ → „říjen 2026“. */
export function popisMesice(datum) {
  const [rok, mesic] = datum.split('-');
  return `${MESICE[Number(mesic) - 1] ?? '?'} ${rok}`;
}

/**
 * „30. 9. – 29. 10. 2026“; rok se u začátku opakuje jen při přechodu roku
 * („12. 12. 2025 – 10. 1. 2026“). Jediný den se vypíše jednou.
 */
export function rozsahCesky(od, do_) {
  if (od === do_) return ceskeDatum(od);
  const zacatek = od.slice(0, 4) === do_.slice(0, 4)
    ? ceskeDatum(od).replace(/ \d{4}$/, '')
    : ceskeDatum(od);
  return `${zacatek} – ${ceskeDatum(do_)}`;
}

/** Proč se vlastní období nepoužilo, nebo null, když je v pořádku. */
function chybaVlastnihoObdobi(od, do_) {
  if (!od || !do_) return 'chybí nebo není platné datum od / do';
  if (od > do_) return 'začátek je po konci';
  if (rozdilDni(od, do_) > MAX_ROZDIL_DNI) return `rozsah je delší než ${MAX_ROZDIL_DNI} dní`;
  return null;
}

/**
 * Z parametrů URL udělá uzavřený interval. `dnes` je pražské datum
 * (`prazskyCas().datum`) — předává se, aby šel přehled testovat s pevným dnem.
 *
 * Vrací `{ od, do, preset, popis }`; `preset` je to, co se skutečně použilo
 * (po neplatném vlastním období tedy 'tento-mesic').
 */
export function vyhodnotObdobi({ obdobi, od, do: doQ } = {}, dnes = prazskyCas().datum) {
  const den = jenDatum(dnes);
  if (!den) throw new Error(`vyhodnotObdobi: „dnes“ musí být YYYY-MM-DD, dostalo ${dnes}`);

  const preset = PRESETY.includes(obdobi) ? obdobi : 'tento-mesic';

  if (preset === 'minuly-mesic') {
    // Den před prvním dnem tohoto měsíce leží v minulém; jeho první a poslední den dá kalendář.
    const vMinulem = pridejDny(prvniDenMesice(den), -1);
    return { od: prvniDenMesice(vMinulem), do: posledniDenMesice(vMinulem), preset, popis: popisMesice(vMinulem) };
  }

  if (preset === '30-dni') {
    const zacatek = pridejDny(den, -29);
    return { od: zacatek, do: den, preset, popis: `posledních 30 dní (${rozsahCesky(zacatek, den)})` };
  }

  if (preset === 'vlastni') {
    const vOd = jenDatum(od);
    const vDo = jenDatum(doQ);
    const chyba = chybaVlastnihoObdobi(vOd, vDo);
    if (!chyba) return { od: vOd, do: vDo, preset, popis: rozsahCesky(vOd, vDo) };
    return {
      od: prvniDenMesice(den), do: den, preset: 'tento-mesic',
      popis: `${popisMesice(den)} — vlastní období se nepoužilo: ${chyba}`,
    };
  }

  return { od: prvniDenMesice(den), do: den, preset: 'tento-mesic', popis: popisMesice(den) };
}
