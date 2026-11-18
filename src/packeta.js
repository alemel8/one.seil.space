// Packeta (Zásilkovna) SOAP API klient – stažení PDF štítku přímo ze serveru,
// bez spoléhání na externě vygenerovaný (a časem expirující) odkaz, a stav
// zásilky pro sledování po odeslání do skladu (src/sledovani-zasilek.js).
// WSDL: https://www.zasilkovna.cz/api/soap-php-bugfix.wsdl, endpoint https://www.zasilkovna.cz/api/soap
//
// Endpoint je schválně HTTPS, i když ho WSDL uvádí bez šifrování: v obálce
// jde apiPassword, a to nemá po síti cestovat čitelně. Ověřeno, že server
// na HTTPS odpovídá stejně.

const SOAP_ENDPOINT = 'https://www.zasilkovna.cz/api/soap';

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** Číslo zásilky jako packetId: jen číslice („Z 123 456 7890“ → „1234567890“). */
function packetIdZ(cislo) {
  const cleanId = String(cislo ?? '').replace(/\D/g, '');
  if (!cleanId) throw new Error('Neplatné číslo zásilky');
  return cleanId;
}

function hesloApi() {
  const apiPassword = process.env.PACKETA_API_PASSWORD;
  if (!apiPassword) throw new Error('PACKETA_API_PASSWORD není nastaveno v prostředí');
  return apiPassword;
}

async function soapVolani(metoda, telo, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://www.zasilkovna.cz/api/soap.wsdl2">
  <soapenv:Body>
    <tns:${metoda}>
      <apiPassword>${escapeXml(hesloApi())}</apiPassword>
${telo}
    </tns:${metoda}>
  </soapenv:Body>
</soapenv:Envelope>`;

  const res = await fetchImpl(SOAP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': `http://www.zasilkovna.cz/api/soap/${metoda}`,
    },
    body: envelope,
    // Bez timeoutu čeká fetch minuty. Ranní expedice stahuje štítky
    // sekvenčně, takže jeden zaseklý hovor zdrží celý běh.
    signal: AbortSignal.timeout(timeoutMs),
  });
  const xml = await res.text();

  const fault = xml.match(/<faultstring>([\s\S]*?)<\/faultstring>/);
  if (fault) throw new Error(`Packeta API: ${unescapeXml(fault[1])}`);
  return xml;
}

export async function fetchPacketLabelPdf(packetId, format = 'A6 on A6') {
  const xml = await soapVolani('packetLabelPdf', `
      <packetId>${escapeXml(packetIdZ(packetId))}</packetId>
      <format>${escapeXml(format)}</format>
      <offset>0</offset>`);

  const result = xml.match(/<packetLabelPdfResult>([\s\S]*?)<\/packetLabelPdfResult>/);
  if (!result) throw new Error('Packeta API: štítek se nepodařilo načíst (neočekávaná odpověď)');

  return Buffer.from(result[1], 'base64');
}

// ── Stav zásilky ──────────────────────────────────────────────

/**
 * Stavy (`codeText`), ve kterých má Zásilkovna balík fyzicky u sebe nebo ho
 * už doručila. Od prvního z nich je objednávka „předaná dopravci“.
 *
 * Názvy podle oficiálního pluginu Zásilkovny pro WooCommerce
 * (Packetery\Core\Entity\PacketStatus). Rozhoduje se podle `codeText`, ne
 * podle čísla: textové kódy plugin Zásilkovny sám používá jako identifikátor
 * a `statusText` je lokalizovaný popis pro lidi.
 *
 * Schválně tu nejsou:
 * - `received data` – Zásilkovna má jen data od e-shopu, balík ještě nikdo
 *   nepřinesl (tak vypadá každá zásilka hned po podání),
 * - `cancelled`, `unknown` – balík nikdo nepřevzal,
 * - stavy zpáteční cesty (`posted back`, `returned`, `rejected by recipient`,
 *   `reverse packet arrived`) – balík sice převzala, ale vrací se. To je
 *   storno nebo dobropis pro člověka, ne vyřízení s fakturou.
 */
export const STAVY_PREVZATO = Object.freeze([
  'arrived',                // přijata na podacím místě / v depu
  'collected',              // vyzvednutá svozem u odesílatele
  'prepared for departure',
  'departed',
  'customs',
  'handed to carrier',      // předaná externímu dopravci (doručení na adresu, zahraničí)
  'ready for pickup',
  'delivery attempt',
  'delivered',
]);

/** Stavy, po kterých se už nic nezmění a sledování nemá smysl. */
export const STAVY_KONECNE = Object.freeze(['cancelled', 'returned']);

/** Stav Zásilkovny řečí obsluhy. `statusText` z API je jen záloha pro neznámé kódy. */
const POPISY_STAVU = {
  'received data':          'Zásilkovna má jen data, balík zatím nepřevzala',
  'arrived':                'Převzata na podacím místě',
  'collected':              'Převzata svozem',
  'prepared for departure': 'Připravena k odeslání',
  'departed':               'Na cestě',
  'customs':                'Celní řízení',
  'handed to carrier':      'Předána dopravci k doručení',
  'ready for pickup':       'Připravena k vyzvednutí',
  'delivery attempt':       'Neúspěšný pokus o doručení',
  'delivered':              'Doručena',
  'posted back':            'Vrací se odesílateli',
  'returned':               'Vrácena odesílateli',
  'rejected by recipient':  'Příjemce ji odmítl',
  'reverse packet arrived': 'Zpětná zásilka přijata',
  'cancelled':              'Zrušena',
  'unknown':                'Neznámý stav',
};

export function popisStavuZasilky(codeText, statusText = '') {
  const kod = String(codeText ?? '').trim().toLowerCase();
  return POPISY_STAVU[kod] || String(statusText ?? '').trim() || kod;
}

/**
 * Převzala Zásilkovna balík? `isReturning` má přednost: vracející se zásilka
 * se nevyřizuje, i kdyby kód sám vypadal jako cesta k zákazníkovi.
 */
export function jePrevzataDopravcem(stav) {
  if (!stav || stav.isReturning) return false;
  return STAVY_PREVZATO.includes(String(stav.codeText ?? '').trim().toLowerCase());
}

const PRAZSKY_POSUN = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Prague', timeZoneName: 'longOffset' });

/**
 * `dateTime` ze Zásilkovny. Bez časového pásma je to pražský čas – proto se
 * nepředává rovnou do `new Date()`, který by ho četl v pásmu kontejneru.
 */
export function okamzikZasilkovny(text) {
  const hodnota = String(text ?? '').trim();
  if (!hodnota) return null;
  if (/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(hodnota)) {
    const d = new Date(hodnota);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = hodnota.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?/);
  if (!m) return null;
  const jakoUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  const posun = PRAZSKY_POSUN.formatToParts(new Date(jakoUtc))
    .find(p => p.type === 'timeZoneName')?.value.match(/GMT([+-])(\d\d):(\d\d)/);
  const minuty = posun ? (posun[1] === '-' ? -1 : 1) * (Number(posun[2]) * 60 + Number(posun[3])) : 0;
  return new Date(jakoUtc - minuty * 60_000);
}

/** Odpověď packetStatus → prostý objekt. Vyhozená chyba = odpověď nedává smysl. */
export function prectiStavZasilky(xml) {
  const blok = String(xml ?? '').match(/<(?:[\w-]+:)?packetStatusResult\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?packetStatusResult>/)?.[1];
  if (blok == null) throw new Error('Packeta API: stav zásilky se nepodařilo načíst (neočekávaná odpověď)');

  const pole = (nazev) => {
    const m = blok.match(new RegExp(`<(?:[\\w-]+:)?${nazev}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${nazev}>)`));
    return m?.[1] == null ? '' : unescapeXml(m[1]).trim();
  };

  const codeText = pole('codeText').toLowerCase();
  if (!codeText) throw new Error('Packeta API: odpověď neobsahuje stav zásilky');

  return {
    statusCode: Number(pole('statusCode')) || 0,
    codeText,
    statusText: pole('statusText'),
    dateTime: okamzikZasilkovny(pole('dateTime')),
    isReturning: pole('isReturning').toLowerCase() === 'true',
  };
}

/** Aktuální stav zásilky (packetStatus). */
export async function fetchPacketStatus(packetId, { fetchImpl } = {}) {
  const xml = await soapVolani('packetStatus', `
      <packetId>${escapeXml(packetIdZ(packetId))}</packetId>`, { fetchImpl });
  return prectiStavZasilky(xml);
}
