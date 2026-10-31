/**
 * Rozhodování importu z POHODY: je řádek přijaté faktury tímtéž dokladem, nebo
 * dokladem jiného dodavatele? Omyl přepíše cizí fakturu nebo založí druhý řádek
 * téhož dokladu, proto je to bez databáze a testuje se zvlášť.
 *
 *   radek   řádek z DB: supplier, supplier_ico, issue_date, total_amount, id
 *           (id chybí u řádků založených v tomtéž běhu)
 *   doklad  řádek z POHODY: name, ico, issueDate, total
 */
const str = (v) => String(v ?? '').trim();

/** IČO jako klíč dodavatele, stejně jako ico_klic v databázi (migrace 045). */
export const icoKlic = (v) => str(v).replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/^CZ/, '').replace(/^0+/, '');

const stejnyNazev = (radek, doklad) => str(radek.supplier).toLowerCase() === str(doklad.name).toLowerCase();

/**
 * Stejná pravidla jako index z migrace 045.
 *   'stejny'   obě IČO shodná, nebo jedno chybí a názvy se shodují
 *   'jiny'     obě IČO různá, nebo žádné IČO a různé názvy
 *   'nejisty'  jedna strana IČO nemá a názvy se liší
 */
export function porovnejDodavatele(radek, doklad) {
  const a = icoKlic(radek.supplier_ico);
  const b = icoKlic(doklad.ico);
  if (a && b) return a === b ? 'stejny' : 'jiny';
  if (stejnyNazev(radek, doklad)) return 'stejny';
  return a || b ? 'nejisty' : 'jiny';
}

const sediDatum = (radek, doklad) => radek.issue_date === doklad.issueDate;
const sediCastka = (radek, doklad) => Number(radek.total_amount).toFixed(2) === Number(doklad.total).toFixed(2);
const bezIco = (radek, doklad) => !icoKlic(radek.supplier_ico) && !icoKlic(doklad.ico);

/**
 * Krok 1: řádky se stejným číslem jako doklad. Číslo je interní číslo POHODY, takže
 * stejné číslo u jiného dodavatele je mnohem spíš tentýž doklad s opraveným IČO nebo
 * názvem než náhoda. Novou fakturu dostane jen, když se liší IČO, název i údaje.
 *   { akce: 'existuje', radek }  právě jeden od stejného dodavatele
 *   { akce: 'nejiste', radky }   nejde rozlišit
 *   { akce: 'nova', radky }      vše zjevně jiní dodavatelé (nebo nic), založit novou
 */
export function posudCislo(radky, doklad) {
  const vztah = (r) => porovnejDodavatele(r, doklad);
  const stejne = radky.filter(r => vztah(r) === 'stejny');
  if (stejne.length === 1) return { akce: 'existuje', radek: stejne[0] };
  const pochybne = radky.filter(r => vztah(r) === 'nejisty' || (vztah(r) === 'jiny' && (
    (sediDatum(r, doklad) && sediCastka(r, doklad)) || stejnyNazev(r, doklad) || bezIco(r, doklad)
  )));
  if (stejne.length || pochybne.length) return { akce: 'nejiste', radky: [...stejne, ...pochybne] };
  return { akce: 'nova', radky };
}

/**
 * Krok 2: řádky s číslem rovným variabilnímu symbolu dokladu, tedy nejspíš tentýž
 * doklad vedený pod číslem dodavatele. Sloučení přepíše řádek, proto chce shodu data
 * nebo částky. Jiného dodavatele nechá být, jen když údaje nesedí: se stejnými je to
 * tentýž doklad s jinak zapsaným IČO, bez IČO a s jiným názvem stačí datum nebo částka
 * (Ltd. a Limited, cizí měna). Čísla z téhož exportu sem skript vůbec nepošle, jsou to
 * samostatné doklady POHODY; řádek bez id je založený v tomto běhu.
 *   { akce: 'sloucit', radek }   právě jeden od stejného dodavatele s podobnými údaji
 *   { akce: 'nejiste', radky }   nejde rozlišit
 *   { akce: 'zadna' }            nic takového
 */
export function posudVs(radky, doklad) {
  const zDb = radky.filter(r => r.id);
  const vztah = (r) => porovnejDodavatele(r, doklad);
  const podobny = (r) => sediDatum(r, doklad) || sediCastka(r, doklad);
  const stejne = zDb.filter(r => vztah(r) === 'stejny' && podobny(r));
  if (stejne.length === 1) return { akce: 'sloucit', radek: stejne[0] };
  const pochybne = zDb.filter(r => {
    if (vztah(r) === 'nejisty') return true;
    if (vztah(r) === 'stejny') return !podobny(r);
    return bezIco(r, doklad) ? podobny(r) : sediDatum(r, doklad) && sediCastka(r, doklad);
  });
  if (stejne.length || pochybne.length) return { akce: 'nejiste', radky: [...stejne, ...pochybne] };
  return { akce: 'zadna' };
}
