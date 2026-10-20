/**
 * Pražský čas a kalendářní data nezávislá na časovém pásmu procesu.
 *
 * Samostatný modul bez závislostí, ať si ho můžou natáhnout PDF, číselné řady
 * i hlídání lhůt — dřív bydlel v src/expedice.js a kdo chtěl pražské datum,
 * natáhl si s ním e-mail, Zásilkovnu, push i databázi.
 *
 * ## Okamžik se převádí do Prahy
 *
 * Dockerfile nenastavuje TZ ani neinstaluje tzdata a v Coolify to nikdo
 * negarantuje, takže `new Date().getHours()` i `toISOString()` můžou být
 * v UTC — ve 0:30 pražského času je to ještě včerejšek. Pražský den se proto
 * počítá přes `Intl`, nečte se z procesu.
 *
 * ## Datum se čte v UTC
 *
 * Sloupce DATE vrací postgres.js jako půlnoc UTC, takže kalendářní den je
 * jejich UTC část. `toLocaleDateString()` je čte v pásmu procesu a západně od
 * UTC by je posunul o den zpátky.
 */

const PRAZSKE_CASTI = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Prague', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const DNY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Pražské datum, den v týdnu (1 = pondělí) a hodina. Nezávislé na TZ kontejneru. */
export function prazskyCas(date = new Date()) {
  const casti = {};
  for (const { type, value } of PRAZSKE_CASTI.formatToParts(date)) casti[type] = value;
  return {
    datum: `${casti.year}-${casti.month}-${casti.day}`,
    den: DNY[casti.weekday] ?? 0,
    hodina: Number(casti.hour),
    minuta: Number(casti.minute),
  };
}

function platnyOkamzik(hodnota) {
  const d = hodnota instanceof Date ? hodnota : new Date(hodnota);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Pražské datum okamžiku jako „YYYY-MM-DD“. Null, když okamžik chybí nebo je neplatný. */
export function prazskeDatum(okamzik) {
  if (okamzik == null || okamzik === '') return null;
  const d = platnyOkamzik(okamzik);
  return d ? prazskyCas(d).datum : null;
}

/**
 * Hodnota sloupce DATE (nebo řetězec „YYYY-MM-DD…“) jako „YYYY-MM-DD“. Null,
 * když chybí nebo je neplatná.
 *
 * Řetězec musí být skutečný kalendářní den: chodí sem i datum z formuláře
 * a „2026-02-30“ by jinak prošlo až do Postgresu a skončilo chybou 500
 * (`Date` ho tiše přetočí na 2. 3., proto ta kontrola zpětným převodem).
 */
export function jenDatum(hodnota) {
  if (hodnota == null || hodnota === '') return null;
  if (typeof hodnota === 'string') {
    const datum = hodnota.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return null;
    const d = platnyOkamzik(`${datum}T00:00:00Z`);
    return d && d.toISOString().slice(0, 10) === datum ? datum : null;
  }
  const d = platnyOkamzik(hodnota);
  return d ? d.toISOString().slice(0, 10) : null;
}

/** „2026-10-20“ + 14 → „2026-11-03“. Počítá v UTC, takže změna času den neukousne. */
export function pridejDny(datum, dny) {
  const d = new Date(`${datum}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dny);
  return d.toISOString().slice(0, 10);
}

/**
 * „2026-10-01“ → „1. 10. 2026“. Tentýž tvar jako toLocaleDateString('cs-CZ'),
 * jen nezávislý na časovém pásmu procesu.
 */
export function ceskeDatum(hodnota) {
  const datum = jenDatum(hodnota);
  if (!datum) return '';
  const [rok, mesic, den] = datum.split('-');
  return `${Number(den)}. ${Number(mesic)}. ${rok}`;
}
