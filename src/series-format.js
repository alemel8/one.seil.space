// Vykreslení čísla z číselné řady — buď podle volného formátu (tokeny), nebo
// podle starého schématu prefix/year/padding (zpětná kompatibilita).
//
// Tokeny ve formátu:
//   YYYY / YY  — rok (4 / 2 číslice)
//   MM         — měsíc (01–12)
//   DD         — den (01–31)
//   X...       — náhodné číslice, počet X určuje počet znaků
//   N...       — pořadové číslo řady, zero-padded na počet N
//
// Rok, měsíc a den jsou pražské, ne podle pásma procesu: kontejner může běžet
// v UTC a faktura vystavená na Nový rok ve 0:30 by nesla v čísle loňský rok,
// kdežto datum vystavení (pražské) už letošní.

import { prazskyCas } from './prazsky-cas.js';

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

  const [rok, mesic, den] = prazskyCas(date).datum.split('-');

  return series.format.replace(TOKEN_RE, (token) => {
    if (token === 'YYYY') return rok;
    if (token === 'YY')   return rok.slice(-2);
    if (token === 'MM')   return mesic;
    if (token === 'DD')   return den;
    if (token[0] === 'X') return randomDigits(token.length);
    if (token[0] === 'N') return String(series.current_number).padStart(token.length, '0');
    return token;
  });
}

/**
 * Variabilní symbol z čísla faktury.
 *
 * Banky přijímají nejvýše 10 číslic, takže z čísla vezmeme číslice a necháme
 * posledních 10 — konec čísla nese pořadí, začátek jen prefix a rok. Zůstává
 * tak podřetězcem čísla faktury, na kterém stojí auto-párování plateb
 * v src/routes/accounting.js.
 */
export function invoiceVs(number) {
  const digits = String(number ?? '').replace(/\D/g, '');
  return digits.slice(-10);
}

/**
 * Variabilní symbol k úhradě dokladu.
 *
 * Zálohová faktura k objednávce e-shopu se platí pod číslem objednávky — to
 * je jediné číslo, které zákazník zná ještě než mu doklad dorazí, a vidí ho
 * na děkovné stránce i v potvrzení. Běžná faktura se platí pod svým číslem.
 *
 * Pozor: auto-párování v accounting.js hledalo VS jako podřetězec čísla
 * faktury. Číslo objednávky v čísle zálohovky není, takže tam kvůli téhle
 * výjimce přibyla druhá větev — přes order_id. Kdo mění tohle, musí projít
 * i ji, jinak platby přestanou párovat.
 */
export function paymentVs(invoice, orderNumber) {
  if (invoice?.type === 'proforma' && orderNumber) return invoiceVs(orderNumber);
  return invoiceVs(invoice?.number);
}
