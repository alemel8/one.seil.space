// Společné kontroly stránkovaného seznamu proti běžícímu serveru. Fixturu (řádky se
// shodným klíčem řazení) si zakládá každý test sám, sem patří jen procházení.
//
//   await overSeznam({ req, adresa: '/crm/firmy?q=' + token, tokeny: ids.map(id => `/crm/firmy/${id}`), naStranku: 25 });
//
// tokeny  řetězec, podle kterého se pozná řádek v HTML (typicky adresa detailu),
//         jeden na každý řádek odpovídající adrese.

import assert from 'node:assert/strict';

/** Odkaz patičky podle rel (next, prev), dekódovaný z HTML. */
export function odkazStrany(html, rel) {
  const m = new RegExp(`rel="${rel}" href="([^"]*)"`).exec(html);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

async function nacti(req, adresa) {
  const res = await req.get(adresa);
  assert.equal(res.status, 200, `${adresa} vrací ${res.status}`);
  return res.text();
}

/** Projde seznam přes odkaz Další a vrátí HTML všech stránek. */
export async function projdiStranky(req, adresa, { max = 60 } = {}) {
  const stranky = [];
  let dalsi = adresa;
  while (dalsi) {
    assert.ok(stranky.length < max, 'odkaz Další se zacyklil');
    const html = await nacti(req, dalsi);
    stranky.push(html);
    dalsi = odkazStrany(html, 'next');
  }
  return stranky;
}

const pritomne = (html, tokeny) => tokeny.filter(t => html.includes(t));
const sPage = (adresa, page) => `${adresa}${adresa.includes('?') ? '&' : '?'}page=${page}`;

/**
 * Standardní sada: stránka 2 ukáže jiné řádky, průchod přes Další ukáže každý
 * řádek právě jednou i při shodném klíči řazení, neplatné page nespadne, page
 * za koncem ukáže poslední stránku, opakované načtení drží pořadí.
 *   filtr  { klic: hodnota } parametry, které musí přežít v odkazech stran
 */
export async function overSeznam({ req, adresa, tokeny, naStranku = 25, filtr = {} }) {
  assert.ok(tokeny.length > naStranku * 2, 'fixtura musí mít víc než dvě stránky');
  const pocetStran = Math.ceil(tokeny.length / naStranku);

  const prvni = await nacti(req, adresa);
  const naPrvni = pritomne(prvni, tokeny);
  assert.equal(naPrvni.length, naStranku, 'první stránka má plný počet řádků');
  assert.match(prvni, /class="strankovani-kroky"/, 'navigace mezi stranami je vidět');
  assert.equal(prvni.match(/aria-current="page"/g)?.filter(Boolean).length >= 1, true);
  assert.match(prvni, new RegExp(`<strong>1–${naStranku}</strong> z <strong>${tokeny.length}</strong>`), 'rozsah a celkový počet');

  const druha = await nacti(req, sPage(adresa, 2));
  const naDruhe = pritomne(druha, tokeny);
  assert.equal(naDruhe.length, naStranku);
  assert.ok(naDruhe.every(t => !naPrvni.includes(t)), 'druhá stránka má jiné řádky');

  // Průchod přes skutečné odkazy: drží filtr a každý řádek je právě jednou.
  const stranky = await projdiStranky(req, adresa);
  assert.equal(stranky.length, pocetStran);
  for (const t of tokeny) {
    assert.equal(stranky.filter(h => h.includes(t)).length, 1, `řádek ${t} je právě na jedné stránce`);
  }
  for (const h of stranky) {
    for (const rel of ['next', 'prev']) {
      const odkaz = odkazStrany(h, rel);
      if (!odkaz) continue;
      const params = new URL(odkaz, 'http://x').searchParams;
      for (const [k, v] of Object.entries(filtr)) assert.equal(params.get(k), String(v), `odkaz ${odkaz} drží ${k}`);
    }
  }

  // Stejný dotaz, stejné pořadí.
  const znovu = await nacti(req, adresa);
  const poradi = (html) => tokeny.map(t => [html.indexOf(t), t]).filter(([i]) => i >= 0).sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  assert.deepEqual(poradi(znovu), poradi(prvni), 'opakované načtení drží pořadí');

  // Neplatné číslo stránky je první stránka, nikdy 500.
  for (const page of ['abc', '0', '-5', '1.5', '', '%00', '1&page=2']) {
    const html = await nacti(req, sPage(adresa, page));
    assert.deepEqual(pritomne(html, tokeny).sort(), [...naPrvni].sort(), `page=${page}`);
  }

  // Za koncem poslední stránka a aktuální je poslední.
  for (const page of ['9999', '99999999999999999999']) {
    const html = await nacti(req, sPage(adresa, page));
    const naPosledni = tokeny.length - (pocetStran - 1) * naStranku;
    assert.equal(pritomne(html, tokeny).length, naPosledni, `page=${page}`);
    assert.ok(html.includes(`<span class="strankovani-cislo" aria-current="page">${pocetStran}</span>`), `page=${page} ukáže poslední stránku`);
  }
}
