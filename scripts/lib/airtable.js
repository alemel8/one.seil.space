// Minimální klient k Airtable REST API.
//
// Bez knihovny, jen fetch — stejně jako scripts/migrate-airtable-orders.js.
// Pole se čtou přes ID (returnFieldsByFieldId=true), takže přejmenování
// sloupce v Airtable import nerozbije.
//
// Dvě věci, kvůli kterým to není jen wrapper nad fetch:
//   1. URL příloh expirují po ~2 hodinách. Když stahování dojde na propadlý
//      odkaz, klient si vyžádá čerstvý záznam a zkusí to ještě jednou.
//   2. Airtable dovolí 5 požadavků za sekundu na základnu. Překročení vrací
//      429 a třicetisekundový ban, takže se dotazy brzdí.

const API = 'https://api.airtable.com/v0';
const MIN_ROZESTUP_MS = 220;         // ~4,5 req/s, pod limitem s rezervou

let poslednich = 0;
async function brzda() {
  const ted = Date.now();
  const cekat = poslednich + MIN_ROZESTUP_MS - ted;
  if (cekat > 0) await new Promise(r => setTimeout(r, cekat));
  poslednich = Date.now();
}

export function jeNastaveno() {
  return Boolean(process.env.AIRTABLE_API_KEY);
}

function klic() {
  const k = process.env.AIRTABLE_API_KEY;
  if (!k) {
    throw new Error(
      'Chybí AIRTABLE_API_KEY. Vytvoř si v Airtable Personal Access Token ' +
      '(https://airtable.com/create/tokens) s právy data.records:read a ' +
      'přístupem k oběma základnám, a vlož ho do .env.'
    );
  }
  return k;
}

async function zavolej(url, { pokus = 0 } = {}) {
  await brzda();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${klic()}` },
    signal: AbortSignal.timeout(60_000),
  });

  if (res.status === 429 && pokus < 4) {
    const cekat = Number(res.headers.get('retry-after') || 30) * 1000;
    console.log(`  … Airtable brzdí, čekám ${Math.round(cekat / 1000)} s`);
    await new Promise(r => setTimeout(r, cekat));
    return zavolej(url, { pokus: pokus + 1 });
  }
  if (!res.ok) {
    const telo = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Airtable odmítl token (401) — zkontroluj AIRTABLE_API_KEY.');
    if (res.status === 403) throw new Error(`Token nemá přístup k ${url.pathname} (403) — přidej základnu do jeho scope.`);
    if (res.status === 404) throw new Error(`Airtable nenašel ${url.pathname} (404) — sedí ID základny a tabulky?`);
    throw new Error(`Airtable ${res.status}: ${telo.slice(0, 300)}`);
  }
  return res.json();
}

/** Všechny záznamy tabulky, stránka po stránce. */
export async function* zaznamy(baseId, tableId, { fieldIds } = {}) {
  let offset;
  do {
    const url = new URL(`${API}/${baseId}/${tableId}`);
    url.searchParams.set('returnFieldsByFieldId', 'true');
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    for (const f of fieldIds ?? []) url.searchParams.append('fields[]', f);

    const data = await zavolej(url);
    // Stránka se hned vydá ven, ať se její přílohy stáhnou dřív, než jejich
    // odkazy propadnou. Posbírat všechno dopředu by bylo pomalejší i křehčí.
    yield* data.records;
    offset = data.offset;
  } while (offset);
}

/** Jeden záznam — používá se k obnovení propadlých odkazů na přílohy. */
export async function zaznam(baseId, tableId, recordId) {
  const url = new URL(`${API}/${baseId}/${tableId}/${recordId}`);
  url.searchParams.set('returnFieldsByFieldId', 'true');
  return zavolej(url);
}

/**
 * Stáhne přílohu. Když odkaz propadl, vytáhne si čerstvý ze zdrojového
 * záznamu a zkusí to ještě jednou — jinak by delší běh skončil sérií
 * chyb jen proto, že mezitím uplynuly dvě hodiny.
 */
export async function stahniPrilohu(priloha, { baseId, tableId, recordId, fieldId }) {
  const zkus = async url => {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return { ok: false, status: res.status };
    const typ = res.headers.get('content-type') || '';
    // Airtable na propadlý odkaz vrací HTML stránku, ne 403
    if (typ.includes('text/html') && !priloha.mime.includes('html')) return { ok: false, status: 'html' };
    return { ok: true, buf: Buffer.from(await res.arrayBuffer()) };
  };

  let r = await zkus(priloha.url);
  if (r.ok) return r.buf;

  const cerstvy = await zaznam(baseId, tableId, recordId);
  const pole = cerstvy.fields?.[fieldId] ?? [];
  const novy = pole.find(a => a.id === priloha.airtableId);
  if (!novy?.url) {
    throw new Error(`Příloha ${priloha.filename} (${priloha.airtableId}) už v záznamu ${recordId} není`);
  }
  r = await zkus(novy.url);
  if (!r.ok) throw new Error(`Přílohu ${priloha.filename} se nepodařilo stáhnout (${r.status})`);
  return r.buf;
}
