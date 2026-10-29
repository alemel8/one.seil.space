// Jednotkový test HTTP vrstvy marketingových adaptérů — běží bez databáze
// a serveru (fetch je falešný, prodleva vstříknutá); jediný test si zvedne
// lokální HTTP server na 127.0.0.1, aby ověřil skutečný fetch:
//
//   node --test test/marketing-http.test.js
//
// Hlídá, že se opakuje jen přechodná chyba (429, 5xx, síť, timeout), nikdy
// 4xx s chybným tokenem, že prodleva roste a Retry-After ji umí jen
// prodloužit (strop 60 s), že timeout opravdu přeruší zaseklý hovor — i
// takový, který se zasekne až uprostřed těla odpovědi 200, ten nesmí
// vypadat jako prázdný report — a že chybová hláška neprozradí query
// string s tokenem.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  HttpError, MAX_PRODLEVA_MS, adresaProLog, fetchJson, retryAfterMs, sOpakovanim,
} from '../src/marketing/http.js';

/** Falešný fetch, který vrátí připravenou odpověď a zapíše, s čím byl zavolán. */
function falesnyFetch(status, telo, headers = {}) {
  const volani = [];
  const fetchImpl = async (url, init) => {
    volani.push({ url, init });
    return new Response(telo, { status, headers });
  };
  return { fetchImpl, volani };
}

describe('pomocníci', () => {
  test('adresa pro log je bez query stringu (Meta nese token v access_token=)', () => {
    assert.equal(adresaProLog('https://graph.facebook.com/v26.0/act_1/insights?access_token=TAJNE&fields=spend'),
      'https://graph.facebook.com/v26.0/act_1/insights');
    assert.equal(adresaProLog('neni url?x=1'), 'neni url');
  });

  test('Retry-After v sekundách i jako HTTP datum', () => {
    assert.equal(retryAfterMs('7'), 7000);
    assert.equal(retryAfterMs(' 0 '), 0);
    const now = Date.parse('2026-10-29T10:00:00Z');
    assert.equal(retryAfterMs('Thu, 29 Oct 2026 10:00:30 GMT', now), 30_000);
    assert.equal(retryAfterMs('Thu, 29 Oct 2026 09:00:00 GMT', now), 0);   // datum v minulosti → hned
    assert.equal(retryAfterMs(undefined), null);
    assert.equal(retryAfterMs(''), null);
    assert.equal(retryAfterMs('za chvíli'), null);
  });
});

describe('fetchJson', () => {
  test('JSON odpověď: json, text, stav i hlavičky malými písmeny', async () => {
    const { fetchImpl, volani } = falesnyFetch(200, '{"rows":[1,2]}', { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '5' });
    const r = await fetchJson('https://api.example.test/v1/report?x=1', { fetchImpl });
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.deepEqual(r.json, { rows: [1, 2] });
    assert.equal(r.text, '{"rows":[1,2]}');
    assert.equal(r.headers['content-type'], 'application/json');
    assert.equal(r.headers['x-ratelimit-remaining'], '5');
    assert.equal(volani.length, 1);
    assert.equal(volani[0].url, 'https://api.example.test/v1/report?x=1');
    assert.equal(volani[0].init.method, 'GET');
    assert.equal(volani[0].init.headers.get('accept'), 'application/json');
    assert.ok(volani[0].init.signal instanceof AbortSignal);
  });

  test('odpověď, která není JSON, dá json null a text', async () => {
    const { fetchImpl } = falesnyFetch(200, '<html>ok</html>', { 'content-type': 'text/html' });
    const r = await fetchJson('https://api.example.test/x', { fetchImpl });
    assert.equal(r.json, null);
    assert.equal(r.text, '<html>ok</html>');
  });

  test('prázdné tělo (204) dá json null bez chyby', async () => {
    const { fetchImpl } = falesnyFetch(204, null);
    const r = await fetchJson('https://api.example.test/x', { fetchImpl });
    assert.equal(r.status, 204);
    assert.equal(r.json, null);
    assert.equal(r.text, '');
  });

  test('objektové tělo odejde jako JSON s content-type, řetězec beze změny', async () => {
    const a = falesnyFetch(200, '{}');
    await fetchJson('https://api.example.test/x', { method: 'POST', body: { a: 1 }, fetchImpl: a.fetchImpl });
    assert.equal(a.volani[0].init.method, 'POST');
    assert.equal(a.volani[0].init.body, '{"a":1}');
    assert.equal(a.volani[0].init.headers.get('content-type'), 'application/json');

    const b = falesnyFetch(200, '{}');
    await fetchJson('https://api.example.test/x', {
      method: 'POST', body: 'grant_type=client_credentials', fetchImpl: b.fetchImpl,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer k' },
    });
    assert.equal(b.volani[0].init.body, 'grant_type=client_credentials');
    assert.equal(b.volani[0].init.headers.get('content-type'), 'application/x-www-form-urlencoded');
    assert.equal(b.volani[0].init.headers.get('authorization'), 'Bearer k');
  });

  test('4xx je HttpError bez opakování, s tělem a bez query stringu v hlášce', async () => {
    const { fetchImpl } = falesnyFetch(403, '{"error":{"message":"Invalid OAuth access token"}}', { 'content-type': 'application/json' });
    const err = await fetchJson('https://graph.facebook.com/v26.0/act_1/insights?access_token=TAJNE', { fetchImpl }).then(
      () => assert.fail('mělo vyhodit'), e => e);
    assert.ok(err instanceof HttpError);
    assert.equal(err.name, 'HttpError');
    assert.equal(err.status, 403);
    assert.equal(err.retryable, false);
    assert.equal(err.retryAfterMs, null);
    assert.deepEqual(err.body, { error: { message: 'Invalid OAuth access token' } });
    assert.match(err.message, /^GET https:\/\/graph\.facebook\.com\/v26\.0\/act_1\/insights: HTTP 403 — /);
    assert.equal(err.message.includes('TAJNE'), false);
    assert.equal(err.url, 'https://graph.facebook.com/v26.0/act_1/insights');
  });

  test('5xx je přechodná chyba; tělo bez JSON zůstane text, úryvek do hlášky je zkrácený', async () => {
    const { fetchImpl } = falesnyFetch(502, `<html>${'x'.repeat(500)}</html>`);
    const err = await fetchJson('https://api.example.test/x', { fetchImpl }).catch(e => e);
    assert.equal(err.status, 502);
    assert.equal(err.retryable, true);
    assert.equal(typeof err.body, 'string');
    assert.ok(err.message.length < 300, err.message.length);
  });

  test('429 nese Retry-After v ms, i jako HTTP datum', async () => {
    const a = falesnyFetch(429, '', { 'Retry-After': '7' });
    const e1 = await fetchJson('https://api.example.test/x', { fetchImpl: a.fetchImpl }).catch(e => e);
    assert.equal(e1.status, 429);
    assert.equal(e1.retryable, true);
    assert.equal(e1.retryAfterMs, 7000);

    const now = Date.parse('2026-10-29T10:00:00Z');
    const b = falesnyFetch(429, '', { 'retry-after': 'Thu, 29 Oct 2026 10:00:45 GMT' });
    const e2 = await fetchJson('https://api.example.test/x', { fetchImpl: b.fetchImpl, now: () => now }).catch(e => e);
    assert.equal(e2.retryAfterMs, 45_000);
  });

  test('síťová chyba je HttpError{ status: 0, retryable: true } s příčinou', async () => {
    const pad = new TypeError('fetch failed');
    const err = await fetchJson('https://api.example.test/x', { fetchImpl: async () => { throw pad; } }).catch(e => e);
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 0);
    assert.equal(err.retryable, true);
    assert.equal(err.cause, pad);
    assert.match(err.message, /síťová chyba: fetch failed/);
  });

  test('timeout přeruší zaseklý hovor a je přechodná chyba', async () => {
    const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    });
    // Časovač AbortSignal.timeout() je unref'd a falešný fetch nedrží žádný
    // socket — bez vlastního časovače by smyčka událostí skončila dřív, než
    // timeout stihne vystřelit (skutečný fetch drží spojení, tam to nenastane).
    const drzak = setTimeout(() => {}, 5000);
    const zacatek = Date.now();
    const err = await fetchJson('https://api.example.test/x', { fetchImpl, timeoutMs: 20 }).catch(e => e).finally(() => clearTimeout(drzak));
    assert.ok(Date.now() - zacatek < 5000);
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 0);
    assert.equal(err.retryable, true);
    assert.match(err.message, /odpověď nepřišla do 0\.02 s/);
  });

  test('timeout nebo pád spojení při čtení těla odpovědi 200 je přechodná chyba, ne prázdný report', async () => {
    const zasekle = async () => ({ status: 200, ok: true, headers: {}, text: () => Promise.reject(new DOMException('x', 'TimeoutError')) });
    const err = await fetchJson('https://api.example.test/x', { fetchImpl: zasekle, timeoutMs: 300 }).catch(e => e);
    assert.ok(err instanceof HttpError, `mělo vyhodit HttpError, vrátilo ${JSON.stringify(err)}`);
    assert.equal(err.status, 0);
    assert.equal(err.retryable, true);
    assert.match(err.message, /^GET https:\/\/api\.example\.test\/x: odpověď nepřišla do 0\.3 s$/);

    const reset = new TypeError('terminated');
    const spadle = async () => ({ status: 200, text: () => Promise.reject(reset) });
    const err2 = await fetchJson('https://api.example.test/x', { fetchImpl: spadle }).catch(e => e);
    assert.ok(err2 instanceof HttpError);
    assert.equal(err2.status, 0);
    assert.equal(err2.retryable, true);
    assert.equal(err2.cause, reset);
    assert.match(err2.message, /síťová chyba: terminated/);
  });

  test('u chybového stavu se nečitelné tělo spolkne — stav rozhoduje a chyba 503 se neztratí', async () => {
    const fetchImpl = async () => ({ status: 503, headers: { 'retry-after': '3' }, text: () => Promise.reject(new DOMException('x', 'TimeoutError')) });
    const err = await fetchJson('https://api.example.test/x', { fetchImpl }).catch(e => e);
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 503);
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfterMs, 3000);
    assert.equal(err.body, '');
    assert.match(err.message, /: HTTP 503$/);
  });

  test('skutečný fetch: tělo 200, které se zasekne uprostřed JSONu, skončí timeoutem', async () => {
    const sockety = new Set();
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"rows":[1,2,3');   // a dál nic — spojení visí
    });
    server.on('connection', (s) => sockety.add(s));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const zacatek = Date.now();
      const err = await fetchJson(`http://127.0.0.1:${port}/report`, { timeoutMs: 200 }).catch(e => e);
      assert.ok(err instanceof HttpError, `mělo vyhodit HttpError, vrátilo ${JSON.stringify(err)}`);
      assert.equal(err.status, 0);
      assert.equal(err.retryable, true);
      assert.match(err.message, /odpověď nepřišla do 0\.2 s/);
      assert.ok(Date.now() - zacatek < 5000);
    } finally {
      for (const s of sockety) s.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
});

describe('sOpakovanim', () => {
  function pripravy() {
    const spanky = [];
    const zaznamy = [];
    return {
      spanky, zaznamy,
      sleep: async (ms) => { spanky.push(ms); },
      log: { warn: (obj, msg) => zaznamy.push({ obj, msg }) },
    };
  }
  const prechodna = (zprava = 'HTTP 503', extra = {}) => new HttpError(zprava, { status: 503, retryable: true, ...extra });

  test('úspěch napoprvé: jedno volání, žádná prodleva ani log', async () => {
    const p = pripravy();
    let volani = 0;
    const r = await sOpakovanim(async (pokus) => { volani++; return `ok ${pokus}`; }, { ...p });
    assert.equal(r, 'ok 1');
    assert.equal(volani, 1);
    assert.deepEqual(p.spanky, []);
    assert.deepEqual(p.zaznamy, []);
  });

  test('přechodná chyba se opakuje s rostoucí prodlevou 2 s, 4 s a každé opakování se zaloguje', async () => {
    const p = pripravy();
    const pokusy = [];
    const r = await sOpakovanim(async (pokus) => {
      pokusy.push(pokus);
      if (pokus < 3) throw prechodna(`HTTP 503 (${pokus})`);
      return 'hotovo';
    }, { ...p, nazev: 'sklik' });
    assert.equal(r, 'hotovo');
    assert.deepEqual(pokusy, [1, 2, 3]);
    assert.deepEqual(p.spanky, [2000, 4000]);
    assert.equal(p.zaznamy.length, 2);
    assert.equal(p.zaznamy[0].obj.nazev, 'sklik');
    assert.equal(p.zaznamy[0].obj.pokus, 1);
    assert.equal(p.zaznamy[0].obj.prodlevaMs, 2000);
    assert.ok(p.zaznamy[0].obj.err instanceof HttpError);
    assert.match(p.zaznamy[0].msg, /^sklik: pokus 1 z 3 selhal \(HTTP 503 \(1\)\), další za 2 s$/);
    assert.match(p.zaznamy[1].msg, /pokus 2 z 3 .* další za 4 s$/);
  });

  test('trvalá chyba (401, chybný token) se neopakuje a vyhodí se hned', async () => {
    const p = pripravy();
    let volani = 0;
    const trvala = new HttpError('HTTP 401', { status: 401, retryable: false });
    await assert.rejects(sOpakovanim(async () => { volani++; throw trvala; }, { ...p }), (e) => e === trvala);
    assert.equal(volani, 1);
    assert.deepEqual(p.spanky, []);
    assert.deepEqual(p.zaznamy, []);
  });

  test('obyčejná chyba bez retryable se také neopakuje', async () => {
    const p = pripravy();
    let volani = 0;
    await assert.rejects(sOpakovanim(async () => { volani++; throw new Error('bug'); }, { ...p }), /bug/);
    assert.equal(volani, 1);
  });

  test('po vyčerpání pokusů letí poslední chyba; prodlev je o jednu míň než pokusů', async () => {
    const p = pripravy();
    let volani = 0;
    await assert.rejects(
      sOpakovanim(async () => { volani++; throw prechodna(`pokus ${volani}`); }, { ...p, pokusy: 4, prodlevaMs: 1000 }),
      /pokus 4/,
    );
    assert.equal(volani, 4);
    assert.deepEqual(p.spanky, [1000, 2000, 4000]);
    assert.equal(p.zaznamy.length, 3);
  });

  test('jediný pokus: ani přechodná chyba se neopakuje', async () => {
    const p = pripravy();
    let volani = 0;
    await assert.rejects(sOpakovanim(async () => { volani++; throw prechodna(); }, { ...p, pokusy: 1 }));
    assert.equal(volani, 1);
    assert.deepEqual(p.spanky, []);
  });

  test('Retry-After prodlevu prodlouží, nikdy nezkrátí, a platí strop 60 s', async () => {
    const p = pripravy();
    let volani = 0;
    await sOpakovanim(async () => {
      volani++;
      if (volani === 1) throw prechodna('429', { status: 429, retryAfterMs: 10_000 });
      if (volani === 2) throw prechodna('429', { status: 429, retryAfterMs: 500 });
      if (volani === 3) throw prechodna('429', { status: 429, retryAfterMs: 5 * 60_000 });
      return 'ok';
    }, { ...p, pokusy: 4 });
    assert.equal(MAX_PRODLEVA_MS, 60_000);
    assert.deepEqual(p.spanky, [10_000, 4000, 60_000]);
  });

  test('bez logu to nespadne', async () => {
    let volani = 0;
    const r = await sOpakovanim(async () => { volani++; if (volani === 1) throw prechodna(); return 1; }, { sleep: async () => {} });
    assert.equal(r, 1);
  });
});
