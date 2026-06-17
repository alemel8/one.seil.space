// Vykreslení čísla z číselné řady — buď podle volného formátu (tokeny), nebo
// podle starého schématu prefix/year/padding (zpětná kompatibilita).
//
// Tokeny ve formátu:
//   YYYY / YY  — rok (4 / 2 číslice)
//   MM         — měsíc (01–12)
//   DD         — den (01–31)
//   X...       — náhodné číslice, počet X určuje počet znaků
//   N...       — pořadové číslo řady, zero-padded na počet N

const TOKEN_RE = /Y{4}|Y{2}|M{2}|D{2}|X+|N+/g;

function randomDigits(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 10);
  return out;
}

export function renderSeriesNumber(series, date = new Date()) {
  if (!series.format) {
    const num = String(series.current_number).padStart(series.padding, '0');
    const yearPart = series.year ? `-${series.year}` : '';
    return `${series.prefix}${yearPart}-${num}`;
  }

  return series.format.replace(TOKEN_RE, (token) => {
    if (token === 'YYYY') return String(date.getFullYear());
    if (token === 'YY')   return String(date.getFullYear()).slice(-2);
    if (token === 'MM')   return String(date.getMonth() + 1).padStart(2, '0');
    if (token === 'DD')   return String(date.getDate()).padStart(2, '0');
    if (token[0] === 'X') return randomDigits(token.length);
    if (token[0] === 'N') return String(series.current_number).padStart(token.length, '0');
    return token;
  });
}
