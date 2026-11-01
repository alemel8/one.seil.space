// Filtr seznamů dokladů (přijaté a vydané faktury, účtenky): hledání, dodavatel,
// období a stav v POHODĚ. Formulář je views/includes/filtr-dokladu.ejs.

import { jenDatum, prazskeDatum, pridejDny } from './prazsky-cas.js';
import { parametr } from './strankovani.js';
import { escapujLike } from './hledani.js';

const RYCHLA_OBDOBI = [
  ['tento-mesic', 'Tento měsíc'], ['minuly-mesic', 'Minulý měsíc'],
  ['30-dni', 'Posledních 30 dní'], ['90-dni', 'Posledních 90 dní'],
  ['tento-rok', 'Tento rok'], ['minuly-rok', 'Minulý rok'],
];
const MESICE = ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen', 'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];
const MESICU_V_NABIDCE = 24;

const dvemaCislicemi = (n) => String(n).padStart(2, '0');

function rozsahMesice(rok, mesic) {
  const posledni = new Date(Date.UTC(rok, mesic, 0)).getUTCDate();
  const m = `${rok}-${dvemaCislicemi(mesic)}`;
  return { od: `${m}-01`, do: `${m}-${dvemaCislicemi(posledni)}` };
}

/** Rozsah dat období k pražskému dni dnes, null u neznámé hodnoty. */
export function rozsahObdobi(obdobi, dnes) {
  const rok = Number(dnes.slice(0, 4));
  const mesic = Number(dnes.slice(5, 7));
  switch (obdobi) {
    case 'tento-mesic': return rozsahMesice(rok, mesic);
    case 'minuly-mesic': return mesic === 1 ? rozsahMesice(rok - 1, 12) : rozsahMesice(rok, mesic - 1);
    case '30-dni': return { od: pridejDny(dnes, -29), do: dnes };
    case '90-dni': return { od: pridejDny(dnes, -89), do: dnes };
    case 'tento-rok': return { od: `${rok}-01-01`, do: `${rok}-12-31` };
    case 'minuly-rok': return { od: `${rok - 1}-01-01`, do: `${rok - 1}-12-31` };
  }
  const m = /^((?:19|20)\d{2})-(0[1-9]|1[0-2])$/.exec(obdobi);
  return m ? rozsahMesice(Number(m[1]), Number(m[2])) : null;
}

function popisMesice(hodnota) {
  return `${MESICE[Number(hodnota.slice(5, 7)) - 1]} ${hodnota.slice(0, 4)}`;
}

/** Měsíce do nabídky od aktuálního zpět; starší vybraný z adresy v ní zůstane. */
function mesiceDoNabidky(dnes, vybrany) {
  const hodnoty = [];
  let rok = Number(dnes.slice(0, 4));
  let mesic = Number(dnes.slice(5, 7));
  for (let i = 0; i < MESICU_V_NABIDCE; i++) {
    hodnoty.push(`${rok}-${dvemaCislicemi(mesic)}`);
    if (--mesic === 0) { mesic = 12; rok--; }
  }
  if (/^(19|20)\d{2}-(0[1-9]|1[0-2])$/.test(vybrany) && !hodnoty.includes(vybrany)) hodnoty.push(vybrany);
  return hodnoty.map(hodnota => ({ hodnota, popis: popisMesice(hodnota) }));
}

/** Datum z adresy; rok mimo 1900 až 2099 je překlep a rok 0000 by Postgres odmítl chybou. */
function datumZAdresy(hodnota) {
  const datum = jenDatum(parametr(hodnota));
  return datum && /^(19|20)\d{2}-/.test(datum) ? datum : null;
}

/** Hodnoty filtru z adresy. Přednost má vybrané období, ruční rozsah platí jen bez něj. */
export function filtrDokladu(query, now = new Date()) {
  const dnes = prazskeDatum(now);
  const q = parametr(query.q).slice(0, 100);
  const dodavatel = parametr(query.dodavatel).slice(0, 200);
  const pohoda = ['odeslano', 'neodeslano'].includes(parametr(query.pohoda)) ? parametr(query.pohoda) : '';

  const zadane = parametr(query.obdobi);
  let rozsah = zadane === 'vlastni' ? null : rozsahObdobi(zadane, dnes);
  let obdobi = rozsah ? zadane : '';
  if (!rozsah) {
    let od = datumZAdresy(query.od);
    let doDne = datumZAdresy(query.do);
    if (od && doDne && od > doDne) [od, doDne] = [doDne, od];
    rozsah = { od, do: doDne };
    if (od || doDne || zadane === 'vlastni') obdobi = 'vlastni';
  }

  return {
    q, dodavatel, pohoda, obdobi,
    od: rozsah.od ?? '',
    do: rozsah.do ?? '',
    aktivni: Boolean(q || dodavatel || pohoda || rozsah.od || rozsah.do),
    zachovat: ['q', 'dodavatel', 'pohoda', 'obdobi', 'od', 'do'],
    rychlaObdobi: RYCHLA_OBDOBI,
    mesice: mesiceDoNabidky(dnes, zadane),
  };
}

/**
 * Podmínky pro WHERE podle filtru. Sloupce se předávají jménem:
 *   datum       sloupec s datem dokladu
 *   dodavatel   sloupec s protistranou
 *   hledat      sloupce pro hledání; částka se hledá navíc, když dotaz vypadá jako číslo
 *   vEvidenci   tabulka má pohoda_v_evidenci (účtenky ne)
 */
export function podminkyFiltru(sql, filtr, { datum, dodavatel, hledat, vEvidenci = true }) {
  const podminky = [];
  if (filtr.q) {
    const vzor = `%${escapujLike(filtr.q)}%`;
    const casti = hledat.map(sloupec => sql`${sql(sloupec)} ILIKE ${vzor}`);
    const castka = filtr.q.replace(/\s/g, '').replace(',', '.');
    if (/^\d+(\.\d+)?$/.test(castka)) casti.push(sql`total_amount::text LIKE ${`${castka}%`}`);
    podminky.push(sql`(${casti.reduce((a, b) => sql`${a} OR ${b}`)})`);
  }
  if (filtr.dodavatel) podminky.push(sql`${sql(dodavatel)} ILIKE ${`%${escapujLike(filtr.dodavatel)}%`}`);
  if (filtr.od) podminky.push(sql`${sql(datum)} >= ${filtr.od}::date`);
  if (filtr.do) podminky.push(sql`${sql(datum)} <= ${filtr.do}::date`);
  if (filtr.pohoda) {
    const uzTam = vEvidenci ? sql`(pohoda_exported_at IS NOT NULL OR pohoda_v_evidenci)` : sql`pohoda_exported_at IS NOT NULL`;
    podminky.push(filtr.pohoda === 'odeslano' ? uzTam : sql`NOT ${uzTam}`);
  }
  return podminky;
}
