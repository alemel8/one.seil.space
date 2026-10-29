// Jednotkový test adaptérů marketingových platforem — běží bez databáze,
// serveru i sítě (fetch i googleJson jsou falešné, prodlevy vstříknuté):
//
//   env -u DATABASE_URL node --test test/marketing-adaptery.test.js
//
// Hlídá: parsuj() všech osmi adaptérů nad fixturami ve tvaru skutečných
// odpovědí (test/fixtures/marketing/<platforma>-*.json) — převody jednotek
// (mikro-koruny Google Ads, haléře Skliku), povinný denní součet pro každý
// den s daty, kam jde Zboží.cz, ořez rozpadu na 50 řádků na den, dopočet
// chybějícího součtu; fetchDaily() posílá správné adresy, hlavičky a těla,
// stránkuje, drží token Skliku v paměti a vrací řádky po normalizaci; chyby
// 400/401/403/404 jsou trvalé bez opakování a 429/5xx/síť přechodné po třech
// pokusech; overit() nikdy nevyhodí; index.js zná přesně osm adaptérů
// a seznam pro nastavení včetně vysvětlujícího řádku Zboží.cz.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GoogleApiError } from '../src/google-auth.js';
import { HttpError } from '../src/marketing/http.js';
import { METRIKY, PLATFORMY, normalizujRadek } from '../src/marketing/normalizace.js';
import { TajemstviError } from '../src/marketing/tajemstvi.js';
import { ADAPTERS, AdapterError, PLATFORMY_SEZNAM, adapterPro } from '../src/marketing/adapters/index.js';
import { adapterChyba, jeTrvalyStav, sPrevodemChyb, zpravaOvereni } from '../src/marketing/adapters/chyby.js';
import {
  TOP_SEGMENTU, cislo, datumZOdpovedi, jenCislice, normalizujRadky, souctyPoDnech, topNaDen,
} from '../src/marketing/adapters/spolecne.js';
import * as ga4 from '../src/marketing/adapters/ga4.js';
import * as googleAds from '../src/marketing/adapters/google_ads.js';
import * as searchConsole from '../src/marketing/adapters/search_console.js';
import * as merchant from '../src/marketing/adapters/merchant.js';
import * as sklik from '../src/marketing/adapters/sklik.js';
import * as heureka from '../src/marketing/adapters/heureka.js';
import * as meta from '../src/marketing/adapters/meta.js';
import * as eshop from '../src/marketing/adapters/eshop.js';

const fixture = (nazev) => JSON.parse(readFileSync(new URL(`./fixtures/marketing/${nazev}.json`, import.meta.url), 'utf8'));
const OKNO = { from: '2026-10-05', to: '2026-10-06' };
const bezSpanku = async () => {};
const TVAR_RADKU = ['platform', 'date', 'segment_kind', 'segment', ...METRIKY];
const SA_EMAIL = 'one-seil@test-project.iam.gserviceaccount.com';

const soucty = (radky) => radky.filter(r => r.segment_kind === '');
const rozpad = (radky, druh) => radky.filter(r => r.segment_kind === druh);
const najdi = (radky, date, segment = '', platform) => radky.find(r => r.date === date && r.segment === segment && (!platform || r.platform === platform));

/** Hlavičky z Headers i z plain objektu, malými písmeny. */
function hlavicky(h) {
  const out = {};
  if (!h) return out;
  const polozky = typeof h.entries === 'function' ? h.entries() : Object.entries(h);
  for (const [k, v] of polozky) out[String(k).toLowerCase()] = String(v);
  return out;
}

/**
 * Falešný fetch: `odpovedi` je buď funkce (url, poradi, init) → { status,
 * json | text, headers }, nebo pole takových odpovědí pro volání po sobě
 * (poslední se opakuje). Zapisuje, s čím byl zavolán.
 */
function falesnyFetch(odpovedi) {
  const volani = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    volani.push({ url: u, method: init.method ?? 'GET', headers: hlavicky(init.headers), body: init.body == null ? null : String(init.body) });
    const seznam = Array.isArray(odpovedi) ? odpovedi : [odpovedi];
    const o = typeof odpovedi === 'function' ? odpovedi(u, volani.length, init) : seznam[Math.min(volani.length - 1, seznam.length - 1)];
    if (!o) throw new Error(`falešný fetch nemá odpověď pro ${u}`);
    const telo = o.text ?? (o.json === undefined ? '' : JSON.stringify(o.json));
    return new Response(telo, { status: o.status ?? 200, headers: { 'content-type': o.text != null ? 'text/html' : 'application/json', ...(o.headers ?? {}) } });
  };
  return { fetchImpl, volani };
}

/** Falešný googleJson: zaznamená volání (url, scopes, method, body, headers, params), odpoví podle `odpovedi`. */
function falesnyGoogle(odpovedi) {
  const volani = [];
  const googleJsonImpl = async (url, opts = {}) => {
    volani.push({ url: String(url), ...opts });
    return odpovedi(String(url), opts, volani.length);
  };
  return { googleJsonImpl, volani };
}

const googleChyba = (status) => new GoogleApiError(`Google API vrátilo ${status}`, { status, retryable: status === 429 || status >= 500 });
const httpChyba = (status, body = null) => new HttpError(`HTTP ${status}`, { status, retryable: status === 429 || status >= 500, body });

/** Trvalé i přechodné stavy pro adaptér nad googleJson; `source` je platné napojení. */
async function overChybyGoogle(adapter, source) {
  for (const status of [400, 401, 403, 404]) {
    const g = falesnyGoogle(() => { throw googleChyba(status); });
    const err = await adapter.fetchDaily({ source, ...OKNO, googleJsonImpl: g.googleJsonImpl, sleep: bezSpanku }).catch(e => e);
    assert.ok(err instanceof AdapterError, `${adapter.platform} ${status}: ${err?.message}`);
    assert.equal(err.permanent, true, `${adapter.platform} ${status} má být trvalá`);
    assert.equal(err.retryable, false);
    assert.equal(err.status, status);
    assert.equal(err.platform, adapter.platform);
    assert.equal(g.volani.length, 1, `${adapter.platform} ${status}: trvalá chyba se neopakuje`);
  }
  for (const status of [429, 500, 503]) {
    const g = falesnyGoogle(() => { throw googleChyba(status); });
    const err = await adapter.fetchDaily({ source, ...OKNO, googleJsonImpl: g.googleJsonImpl, sleep: bezSpanku }).catch(e => e);
    assert.ok(err instanceof AdapterError, `${adapter.platform} ${status}: ${err?.message}`);
    assert.equal(err.permanent, false, `${adapter.platform} ${status} je přechodná`);
    assert.equal(err.retryable, true);
    assert.equal(err.status, status);
    assert.equal(g.volani.length, 3, `${adapter.platform} ${status}: tři pokusy`);
  }
  const sit = falesnyGoogle(() => { throw new GoogleApiError('Google API neodpovědělo: vypršel čas', { status: 0, retryable: true }); });
  const err = await adapter.fetchDaily({ source, ...OKNO, googleJsonImpl: sit.googleJsonImpl, sleep: bezSpanku }).catch(e => e);
  assert.ok(err instanceof AdapterError);
  assert.equal(err.permanent, false);
  assert.equal(err.status, undefined);
  assert.equal(sit.volani.length, 3);
}

/** Trvalé i přechodné stavy pro adaptér nad fetchJson. `pripravy(status)` vrátí odpovědi falešného fetche. */
async function overChybyFetch(adapter, vstup, pripravy, { trvale = [400, 401, 403, 404], prechodne = [429, 500, 503], pokusuPrechodne = 3, volaniTrvale = 1, pred = () => {} } = {}) {
  for (const status of trvale) {
    pred();
    const f = falesnyFetch(pripravy(status));
    const err = await adapter.fetchDaily({ ...vstup, fetchImpl: f.fetchImpl, sleep: bezSpanku }).catch(e => e);
    assert.ok(err instanceof AdapterError, `${adapter.platform} ${status}: ${err?.message}`);
    assert.equal(err.permanent, true, `${adapter.platform} ${status} má být trvalá: ${err.message}`);
    assert.equal(err.status, status);
    assert.equal(f.volani.length, volaniTrvale, `${adapter.platform} ${status}: trvalá chyba se neopakuje`);
  }
  for (const status of prechodne) {
    pred();
    const f = falesnyFetch(pripravy(status));
    const err = await adapter.fetchDaily({ ...vstup, fetchImpl: f.fetchImpl, sleep: bezSpanku }).catch(e => e);
    assert.ok(err instanceof AdapterError, `${adapter.platform} ${status}: ${err?.message}`);
    assert.equal(err.permanent, false, `${adapter.platform} ${status} je přechodná: ${err.message}`);
    assert.equal(err.status, status);
    assert.ok(f.volani.length >= pokusuPrechodne, `${adapter.platform} ${status}: opakuje se (${f.volani.length})`);
  }
  const sit = falesnyFetch(() => { throw new TypeError('fetch failed'); });
  const err = await adapter.fetchDaily({ ...vstup, fetchImpl: sit.fetchImpl, sleep: bezSpanku }).catch(e => e);
  assert.ok(err instanceof AdapterError, `síť: ${err?.message}`);
  assert.equal(err.permanent, false);
  assert.equal(err.status, undefined);
  assert.match(err.message, /síťová chyba/);
}

const puvodniSa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
before(() => {
  // isConfigured() jen kontroluje, že proměnná je; token se v testu nikdy nebere (googleJson je falešný).
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: SA_EMAIL, private_key: 'test' });
});
after(() => {
  if (puvodniSa === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = puvodniSa;
});

// ── rejstřík ───────────────────────────────────────────────────

describe('index.js', () => {
  test('zná přesně osm adaptérů se společným rozhraním', () => {
    assert.deepEqual(Object.keys(ADAPTERS).sort(), ['eshop', 'ga4', 'google_ads', 'heureka', 'merchant', 'meta', 'search_console', 'sklik']);
    for (const [klic, a] of Object.entries(ADAPTERS)) {
      assert.equal(a.platform, klic);
      assert.ok(typeof a.popis === 'string' && a.popis.length > 2, klic);
      assert.ok(Array.isArray(a.zapisujePlatformy) && a.zapisujePlatformy.length >= 1, klic);
      for (const p of a.zapisujePlatformy) assert.ok(PLATFORMY.includes(p), `${klic} zapisuje neznámou platformu ${p}`);
      assert.ok(a.zapisujePlatformy.includes(klic) || klic === 'sklik', klic);
      assert.equal(typeof a.potrebujeTajemstvi, 'boolean', klic);
      assert.equal(typeof a.popisExternalId, 'string', klic);
      assert.equal(typeof a.popisParentId, 'string', klic);
      assert.ok(Number.isInteger(a.maxDniNaDotaz) && a.maxDniNaDotaz >= 1 && a.maxDniNaDotaz <= 90, klic);
      assert.ok(Number.isInteger(a.prepisDni) && a.prepisDni >= 14, klic);
      assert.equal(typeof a.fetchDaily, 'function', klic);
      assert.equal(typeof a.parsuj, 'function', klic);
      assert.equal(typeof a.overit, 'function', klic);
    }
    assert.deepEqual(ADAPTERS.sklik.zapisujePlatformy, ['sklik', 'zbozi']);
    const vsechny = new Set(Object.values(ADAPTERS).flatMap(a => a.zapisujePlatformy));
    assert.deepEqual([...vsechny].sort(), [...PLATFORMY].sort(), 'každou platformu tabulky někdo zapisuje');
    assert.deepEqual(Object.entries(ADAPTERS).filter(([, a]) => a.potrebujeTajemstvi).map(([k]) => k).sort(), ['heureka', 'meta', 'sklik']);
    assert.deepEqual(Object.entries(ADAPTERS).filter(([, a]) => a.prepisDni === 30).map(([k]) => k).sort(), ['google_ads', 'heureka', 'meta', 'sklik']);
    assert.equal(ADAPTERS.google_ads.popisParentId.length > 0, true, 'MCC má popisek');
    for (const k of ['ga4', 'search_console', 'merchant', 'sklik', 'heureka', 'meta', 'eshop']) assert.equal(ADAPTERS[k].popisParentId, '', `${k} nadřazené ID neukazuje`);
  });

  test('seznam pro nastavení má devět řádků v pořadí PLATFORMY a Zboží.cz jen jako vysvětlení', () => {
    assert.deepEqual(PLATFORMY_SEZNAM.map(p => p.platform), PLATFORMY);
    const zbozi = PLATFORMY_SEZNAM.find(p => p.platform === 'zbozi');
    assert.equal(zbozi.maAdapter, false);
    assert.equal(zbozi.potrebujeTajemstvi, false);
    assert.match(zbozi.poznamka, /Sklik/);
    for (const p of PLATFORMY_SEZNAM.filter(p => p.platform !== 'zbozi')) {
      const a = ADAPTERS[p.platform];
      assert.equal(p.maAdapter, true);
      assert.equal(p.popis, a.popis);
      assert.equal(p.potrebujeTajemstvi, a.potrebujeTajemstvi);
      assert.equal(p.popisExternalId, a.popisExternalId);
      assert.equal(p.popisParentId, a.popisParentId);
      assert.deepEqual(p.zapisujePlatformy, a.zapisujePlatformy);
    }
  });

  test('adapterPro vrací adaptér nebo null (zbozi, neznámá, prototyp)', () => {
    assert.equal(adapterPro('ga4'), ADAPTERS.ga4);
    assert.equal(adapterPro('zbozi'), null);
    assert.equal(adapterPro('constructor'), null);
    assert.equal(adapterPro(undefined), null);
  });
});

// ── chyby ──────────────────────────────────────────────────────

describe('chyby.js', () => {
  test('AdapterError nese permanent, status a obrácený retryable', () => {
    const e = new AdapterError('x', { permanent: true, status: 401, platform: 'sklik' });
    assert.equal(e.name, 'AdapterError');
    assert.equal(e.permanent, true);
    assert.equal(e.retryable, false);
    assert.equal(e.status, 401);
    assert.equal(e.platform, 'sklik');
    const p = new AdapterError('y');
    assert.equal(p.permanent, false);
    assert.equal(p.retryable, true);
    assert.equal(p.status, undefined);
    assert.equal(new AdapterError('z', { status: 0 }).status, undefined);
  });

  test('trvalé jsou 4xx kromě 429 a 408', () => {
    for (const s of [400, 401, 403, 404, 410]) assert.equal(jeTrvalyStav(s), true, s);
    for (const s of [408, 429, 500, 502, 503, 0, undefined]) assert.equal(jeTrvalyStav(s), false, String(s));
  });

  test('adapterChyba třídí HttpError, GoogleApiError, TajemstviError i obyčejnou chybu', () => {
    const h401 = adapterChyba(httpChyba(401), { platform: 'meta', kontext: 'Meta insights' });
    assert.ok(h401 instanceof AdapterError);
    assert.equal(h401.permanent, true);
    assert.equal(h401.status, 401);
    assert.equal(h401.platform, 'meta');
    assert.match(h401.message, /^Meta insights: HTTP 401$/);
    assert.equal(h401.cause.status, 401);

    assert.equal(adapterChyba(httpChyba(429)).permanent, false);
    assert.equal(adapterChyba(httpChyba(503)).permanent, false);
    assert.equal(adapterChyba(new HttpError('síť', { status: 0, retryable: true })).permanent, false);
    assert.equal(adapterChyba(new HttpError('síť', { status: 0, retryable: true })).status, undefined);
    // 400 označené adaptérem jako přechodné (Meta limit volání) trvalé není
    assert.equal(adapterChyba(new HttpError('limit', { status: 400, retryable: true })).permanent, false);

    assert.equal(adapterChyba(googleChyba(403)).permanent, true);
    assert.equal(adapterChyba(googleChyba(404)).permanent, true);
    assert.equal(adapterChyba(googleChyba(500)).permanent, false);

    const t = adapterChyba(new TajemstviError('token nelze dešifrovat'));
    assert.equal(t.permanent, true);
    assert.equal(t.status, undefined);

    const o = adapterChyba(new Error('bug'));
    assert.equal(o.permanent, false);
    assert.equal(o.status, undefined);
    assert.equal(o.message, 'bug');
  });

  test('AdapterError projde beze změny (táž instance), nápověda se přidá jednou', () => {
    const puvodni = new AdapterError('chybí klíč', { permanent: true });
    const e = adapterChyba(puvodni, { platform: 'heureka', napoveda: () => 'zkontrolujte klíč' });
    assert.equal(e, puvodni);
    assert.equal(e.platform, 'heureka');
    assert.equal(e.message, 'chybí klíč — zkontrolujte klíč');
    adapterChyba(e, { napoveda: () => 'zkontrolujte klíč' });
    assert.equal(e.message, 'chybí klíč — zkontrolujte klíč');
    assert.equal(adapterChyba(httpChyba(500), { napoveda: () => '' }).message, 'HTTP 500');
  });

  test('sPrevodemChyb opakuje přechodnou chybu a trvalou vyhodí hned', async () => {
    let volani = 0;
    const spanky = [];
    const v = await sPrevodemChyb(async () => { volani++; if (volani < 3) throw httpChyba(503); return 'ok'; }, { sleep: async (ms) => { spanky.push(ms); } });
    assert.equal(v, 'ok');
    assert.deepEqual(spanky, [2000, 4000]);

    volani = 0;
    const err = await sPrevodemChyb(async () => { volani++; throw httpChyba(403); }, { platform: 'ga4', nazev: 'GA4', sleep: bezSpanku }).catch(e => e);
    assert.ok(err instanceof AdapterError);
    assert.equal(err.permanent, true);
    assert.equal(volani, 1);
    assert.match(err.message, /^GA4: HTTP 403$/);

    volani = 0;
    const err2 = await sPrevodemChyb(async () => { volani++; throw httpChyba(429); }, { sleep: bezSpanku }).catch(e => e);
    assert.equal(err2.permanent, false);
    assert.equal(volani, 3);
  });

  test('zpravaOvereni přidá u přechodné chyby dovětek', () => {
    assert.equal(zpravaOvereni(httpChyba(401)), 'HTTP 401');
    assert.match(zpravaOvereni(httpChyba(503)), /HTTP 503 \(přechodná chyba — zkuste to za chvíli znovu\)$/);
  });
});

// ── společné ───────────────────────────────────────────────────

describe('spolecne.js', () => {
  test('cislo: chybějící je nula, řetězec číslo, nesmysl NaN (ať ho normalizace ohlásí)', () => {
    assert.equal(cislo(null), 0);
    assert.equal(cislo(undefined), 0);
    assert.equal(cislo(''), 0);
    assert.equal(cislo('12.5'), 12.5);
    assert.equal(cislo(' 7 '), 7);
    assert.equal(cislo(3), 3);
    assert.ok(Number.isNaN(cislo('n/a')));
    assert.ok(Number.isNaN(cislo('1 234,50')));
    assert.ok(Number.isNaN(cislo({})));
    assert.ok(Number.isNaN(cislo(true)));
  });

  test('jenCislice bere ID s pomlčkami i předponami, odmítne G-… a text', () => {
    assert.equal(jenCislice('882-718-1396'), '8827181396');
    assert.equal(jenCislice(' act_123456789 '), '123456789');
    assert.equal(jenCislice('properties/318467224'), '318467224');
    assert.equal(jenCislice('customers/8827181396'), '8827181396');
    assert.equal(jenCislice('G-20T930ZK0E'), '');
    assert.equal(jenCislice(''), '');
    assert.equal(jenCislice(null), '');
  });

  test('datumZOdpovedi: YYYYMMDD, objekt Merchantu, ISO s pásmem → pražský den', () => {
    assert.equal(datumZOdpovedi('20261005'), '2026-10-05');
    assert.equal(datumZOdpovedi('2026-10-05'), '2026-10-05');
    assert.equal(datumZOdpovedi({ year: 2026, month: 10, day: 5 }), '2026-10-05');
    assert.equal(datumZOdpovedi('2026-10-04T22:00:00Z'), '2026-10-05');
    assert.equal(datumZOdpovedi('2026-10-05T00:00:00+02:00'), '2026-10-05');
    assert.equal(datumZOdpovedi('2026-10-05T23:30:00+02:00'), '2026-10-05');
    assert.equal(datumZOdpovedi('2026-10-05T10:00:00'), '2026-10-05');
    assert.equal(datumZOdpovedi('včera'), null);
    assert.equal(datumZOdpovedi(null), null);
    assert.equal(datumZOdpovedi({ year: 0, month: 1, day: 1 }), null);
  });

  test('souctyPoDnech sčítá na (platforma, den), záporné nepustí a ohlásí', () => {
    const ctx = { varovani: [] };
    const s = souctyPoDnech([
      { platform: 'sklik', date: '2026-10-05', segment_kind: 'campaign', segment: 'A', cost: 10.004, conversions: 2 },
      { platform: 'sklik', date: '2026-10-05', segment_kind: 'campaign', segment: 'B', cost: 5, conversions: -1 },
      { platform: 'zbozi', date: '2026-10-05', segment_kind: 'campaign', segment: 'C', cost: 1 },
    ], ctx);
    assert.deepEqual(s.map(r => [r.platform, r.date, r.segment_kind, r.segment, r.cost, r.conversions]),
      [['sklik', '2026-10-05', '', '', 15, 2], ['zbozi', '2026-10-05', '', '', 1, 0]]);
    assert.deepEqual(ctx.varovani, ['1 záporných hodnot rozpadu do denního součtu nevstoupilo']);
    assert.deepEqual(Object.keys(s[0]), TVAR_RADKU);
  });

  test('topNaDen nechá 50 na den podle metrik, dny zvlášť', () => {
    const radky = [];
    for (let i = 0; i < 60; i++) radky.push({ platform: 'search_console', date: '2026-10-05', segment_kind: 'query', segment: `q${i}`, clicks: i % 7, impressions: 1000 - i });
    radky.push({ platform: 'search_console', date: '2026-10-06', segment_kind: 'query', segment: 'jediný', clicks: 0, impressions: 1 });
    const top = topNaDen(radky, ['clicks', 'impressions'], TOP_SEGMENTU);
    assert.equal(TOP_SEGMENTU, 50);
    assert.equal(top.filter(r => r.date === '2026-10-05').length, 50);
    assert.equal(top.filter(r => r.date === '2026-10-06').length, 1);
    const prvni = top[0];
    assert.equal(prvni.clicks, 6);
    assert.equal(prvni.segment, 'q6');       // nejvíc kliků, při shodě nejvíc zobrazení (nižší i)
    assert.ok(top.filter(r => r.date === '2026-10-05').every((r, i, pole) => i === 0 || pole[i - 1].clicks >= r.clicks));
  });

  test('normalizujRadky zahodí řádky mimo okno a varování zapíše souhrnně do logu', () => {
    const zaznamy = [];
    const log = { warn: (obj, msg) => zaznamy.push({ obj, msg }) };
    const radky = normalizujRadky([
      { date: '2026-10-05', cost: -1 },
      { date: '2026-10-06', cost: '1 234,50' },
      { date: '2026-10-09', cost: 1 },
    ], { ...OKNO, platform: 'heureka', log, nazev: 'Heureka test', varovani: ['ze součtu'] });
    assert.equal(radky.length, 2);
    assert.deepEqual(Object.keys(radky[0]), TVAR_RADKU);
    assert.equal(radky[0].platform, 'heureka');
    assert.equal(zaznamy.length, 2);
    assert.equal(zaznamy[0].obj.pocet, 3);
    assert.match(zaznamy[0].msg, /^Heureka test: 3 varování při normalizaci řádků, první: ze součtu$/);
    assert.equal(zaznamy[1].obj.pocet, 1);
    assert.match(zaznamy[1].msg, /1 řádků zahozeno, první důvod: datum 2026-10-09 je mimo okno/);
    assert.deepEqual(normalizujRadky([], OKNO), []);
  });
});

// ── GA4 ────────────────────────────────────────────────────────

describe('ga4', () => {
  const source = { external_id: '318467224', parent_external_id: '' };
  const odpoved = () => ({ soucty: fixture('ga4-soucty'), kanaly: fixture('ga4-kanaly') });

  test('parsuj: součty z reportu A, kanály z B, chybějící součet dopočítaný z kanálů', () => {
    const ctx = { from: '2026-10-05', to: '2026-10-07', varovani: [] };
    const radky = ga4.parsuj(odpoved(), ctx);
    const s = soucty(radky);
    assert.deepEqual(s.map(r => r.date), ['2026-10-05', '2026-10-06', '2026-10-07']);
    const d5 = najdi(radky, '2026-10-05');
    assert.equal(d5.platform, 'ga4');
    assert.equal(d5.sessions, 142);
    assert.equal(d5.total_users, 128);
    assert.equal(d5.view_item, 311);
    assert.equal(d5.add_to_cart, 19);
    assert.equal(d5.begin_checkout, 7);
    assert.equal(d5.purchase, 3);
    assert.equal(d5.purchase_revenue, 2635.54);
    assert.equal(d5.cost, undefined, 'GA4 náklady nezná, metrika se nedosazuje');
    const d6 = najdi(radky, '2026-10-06');
    assert.equal(d6.purchase, 0);
    assert.equal(d6.purchase_revenue, 0);
    // 7. 10. je jen v kanálech → součet dopočítaný bez trychtýře
    const d7 = najdi(radky, '2026-10-07');
    assert.equal(d7.sessions, 5);
    assert.equal(d7.total_users, 5);
    assert.equal(d7.view_item, 0);
    assert.deepEqual(ctx.varovani, ['GA4: součet dne 2026-10-07 v reportu A chybí, dopočítán z kanálů (bez trychtýře)']);

    const kanaly = rozpad(radky, 'channel');
    assert.equal(kanaly.length, 7);
    const cpc = najdi(radky, '2026-10-05', 'google / cpc');
    assert.equal(cpc.sessions, 38);
    assert.equal(cpc.purchase, 2);
    assert.equal(cpc.purchase_revenue, 1345.54);
    assert.ok(najdi(radky, '2026-10-05', '(direct) / (none)'));
    for (const r of radky) assert.equal(normalizujRadek(r, ctx).radek?.date, r.date, 'každý řádek projde normalizací');
  });

  test('parsuj snese prázdné reporty a pole stránek', () => {
    assert.deepEqual(ga4.parsuj({ soucty: { rowCount: 0 }, kanaly: null }), []);
    assert.deepEqual(ga4.parsuj({}), []);
    const radky = ga4.parsuj({ soucty: [fixture('ga4-soucty'), { rows: [] }], kanaly: [fixture('ga4-kanaly')] }, { varovani: [] });
    assert.equal(soucty(radky).length, 3);
  });

  test('těla reportů: dva reporty podle plánu, limit 250 000 s offsetem, kvóta v odpovědi', () => {
    const a = ga4.dotazSoucty('2026-10-05', '2026-10-06');
    assert.deepEqual(a.dateRanges, [{ startDate: '2026-10-05', endDate: '2026-10-06' }]);
    assert.deepEqual(a.dimensions, [{ name: 'date' }]);
    assert.deepEqual(a.metrics.map(m => m.name), ['sessions', 'totalUsers', 'newUsers', 'engagementRate', 'itemsViewed', 'addToCarts', 'checkouts', 'ecommercePurchases', 'purchaseRevenue']);
    assert.equal(a.limit, 250_000);
    assert.equal(a.offset, 0);
    assert.equal(a.returnPropertyQuota, true);
    const b = ga4.dotazKanaly('2026-10-05', '2026-10-06', 250_000);
    assert.deepEqual(b.dimensions, [{ name: 'date' }, { name: 'sessionSourceMedium' }]);
    assert.deepEqual(b.metrics.map(m => m.name), ['sessions', 'totalUsers', 'ecommercePurchases', 'purchaseRevenue']);
    assert.equal(b.offset, 250_000);
    assert.ok(a.metrics.length <= 10 && b.dimensions.length <= 9);
  });

  test('fetchDaily volá runReport dvakrát za sebou se scope analytics.readonly a vrací normalizované řádky v okně', async () => {
    const o = odpoved();
    const g = falesnyGoogle((url, opts) => (opts.body.dimensions.length === 1 ? o.soucty : o.kanaly));
    const radky = await ga4.fetchDaily({ shop: { slug: 'toneracek' }, source: { external_id: 'properties/318467224' }, ...OKNO, googleJsonImpl: g.googleJsonImpl });
    assert.equal(g.volani.length, 2);
    for (const v of g.volani) {
      assert.equal(v.url, 'https://analyticsdata.googleapis.com/v1beta/properties/318467224:runReport');
      assert.equal(v.method, 'POST');
      assert.deepEqual(v.scopes, ['https://www.googleapis.com/auth/analytics.readonly']);
      assert.equal(v.body.dateRanges[0].startDate, '2026-10-05');
    }
    assert.deepEqual(g.volani[0].body.dimensions, [{ name: 'date' }]);
    assert.deepEqual(g.volani[1].body.dimensions, [{ name: 'date' }, { name: 'sessionSourceMedium' }]);
    // 7. 10. je mimo okno → zahozen; 2 součty + 6 kanálů
    assert.equal(soucty(radky).length, 2);
    assert.equal(rozpad(radky, 'channel').length, 6);
    for (const r of radky) assert.deepEqual(Object.keys(r), TVAR_RADKU);
    assert.equal(najdi(radky, '2026-10-05').purchase_revenue, 2635.54);
    const ocekavane = ga4.parsuj(o, { ...OKNO, varovani: [] }).map(r => normalizujRadek(r, { ...OKNO, platform: 'ga4' }).radek).filter(Boolean);
    assert.deepEqual(radky, ocekavane, 'fetchDaily = parsuj + normalizace');
  });

  test('špatné ID property je trvalá chyba bez volání Googlu', async () => {
    const g = falesnyGoogle(() => ({}));
    const err = await ga4.fetchDaily({ source: { external_id: 'G-20T930ZK0E' }, ...OKNO, googleJsonImpl: g.googleJsonImpl }).catch(e => e);
    assert.ok(err instanceof AdapterError);
    assert.equal(err.permanent, true);
    assert.match(err.message, /G-… je ID datového streamu/);
    assert.equal(g.volani.length, 0);
  });

  test('bez GOOGLE_SERVICE_ACCOUNT_JSON je to trvalá chyba s návodem, bez volání', async () => {
    const ulozeny = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    try {
      const g = falesnyGoogle(() => ({}));
      const err = await ga4.fetchDaily({ source, ...OKNO, googleJsonImpl: g.googleJsonImpl }).catch(e => e);
      assert.ok(err instanceof AdapterError);
      assert.equal(err.permanent, true);
      assert.match(err.message, /GOOGLE_SERVICE_ACCOUNT_JSON není nastavena/);
      assert.equal(g.volani.length, 0);
      const o = await ga4.overit({ source, googleJsonImpl: g.googleJsonImpl });
      assert.equal(o.ok, false);
      assert.match(o.zprava, /GOOGLE_SERVICE_ACCOUNT_JSON/);
    } finally {
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON = ulozeny;
    }
  });

  test('chyby: 400/401/403/404 trvalé bez opakování, 429/5xx/síť přechodné po třech pokusech', async () => {
    await overChybyGoogle(ga4, source);
  });

  test('overit: property přes Admin API; 403 i výjimka dají ok: false bez vyhození', async () => {
    const g = falesnyGoogle(() => fixture('ga4-property'));
    const v = await ga4.overit({ source, googleJsonImpl: g.googleJsonImpl });
    assert.deepEqual(v, { ok: true, zprava: 'Property 318467224 (Toneráček), pásmo Europe/Prague' });
    assert.equal(g.volani[0].url, 'https://analyticsadmin.googleapis.com/v1beta/properties/318467224');
    assert.equal(g.volani[0].method, 'GET');
    assert.deepEqual(g.volani[0].scopes, ['https://www.googleapis.com/auth/analytics.readonly']);

    const eur = falesnyGoogle(() => ({ ...fixture('ga4-property'), currencyCode: 'EUR' }));
    assert.match((await ga4.overit({ source, googleJsonImpl: eur.googleJsonImpl })).zprava, /měna property je EUR/);

    const odmitnuto = falesnyGoogle(() => { throw new GoogleApiError(`Google API odmítlo přístup (403). Přidejte e-mail ${SA_EMAIL} jako čtenáře`, { status: 403 }); });
    const n = await ga4.overit({ source, googleJsonImpl: odmitnuto.googleJsonImpl });
    assert.equal(n.ok, false);
    assert.match(n.zprava, /403/);
    assert.match(n.zprava, /Přidejte e-mail/);

    const pad = falesnyGoogle(() => { throw new Error('něco se rozbilo'); });
    const p = await ga4.overit({ source, googleJsonImpl: pad.googleJsonImpl });
    assert.equal(p.ok, false);
    assert.match(p.zprava, /něco se rozbilo/);

    assert.equal((await ga4.overit({ source: { external_id: '' }, googleJsonImpl: g.googleJsonImpl })).ok, false);
  });
});

// ── Google Ads ─────────────────────────────────────────────────

describe('google_ads', () => {
  const source = { external_id: '882-718-1396', parent_external_id: '' };

  test('parsuj: mikro-koruny → Kč, kampaně po dnech a denní součet; den bez útraty nemá řádek', () => {
    const ctx = { ...OKNO, varovani: [] };
    const radky = googleAds.parsuj(fixture('google_ads-search-stream'), ctx);
    assert.deepEqual(soucty(radky).map(r => r.date), ['2026-10-05', '2026-10-06']);
    const d5 = najdi(radky, '2026-10-05');
    assert.equal(d5.cost, 1099.47);          // 412,35 + 687,12
    assert.equal(d5.impressions, 11353);
    assert.equal(d5.clicks, 221);
    assert.equal(d5.conversions, 3.5);
    assert.equal(d5.conversion_value, 4479);
    const d6 = najdi(radky, '2026-10-06');
    assert.equal(d6.cost, 298);               // 298 004 500 µKč → 298,0045 → 298,00
    assert.equal(d6.impressions, 1222);
    const kampane = rozpad(radky, 'campaign');
    assert.equal(kampane.length, 4);
    const search = najdi(radky, '2026-10-05', 'Tonery – vyhledávání');
    assert.equal(search.cost, 412.35);
    assert.equal(search.conversions, 2.5);
    assert.equal(search.conversion_value, 3189);
    const pauza = najdi(radky, '2026-10-06', 'Brand – pozastavená');
    assert.equal(pauza.impressions, 12);
    assert.equal(pauza.cost, 0);
    assert.ok(!radky.some(r => r.date === '2026-10-07'));
    assert.deepEqual(ctx.varovani, []);
    assert.deepEqual(googleAds.parsuj([]), []);
    assert.deepEqual(googleAds.parsuj({ results: [] }), []);
    assert.equal(googleAds.parsuj(fixture('google_ads-search-stream')[0]).length, 3 + 2, 'jedna dávka bez pole funguje');
  });

  test('GAQL, zákaznické číslo a hlavička MCC', () => {
    assert.equal(googleAds.gaql('2026-10-05', '2026-10-06'),
      'SELECT segments.date, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.all_conversions FROM campaign WHERE segments.date BETWEEN \'2026-10-05\' AND \'2026-10-06\'');
    assert.equal(googleAds.GAQL_UCET, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer');
    assert.equal(googleAds.customerId(source), '8827181396');
    assert.equal(googleAds.formatujCid('8827181396'), '882-718-1396');
    assert.throws(() => googleAds.customerId({ external_id: '12345' }), (e) => e instanceof AdapterError && e.permanent === true);
    assert.deepEqual(googleAds.hlavicky(source), {});
    assert.deepEqual(googleAds.hlavicky({ parent_external_id: '123-456-7890' }), { 'login-customer-id': '1234567890' });
  });

  test('fetchDaily: searchStream s GAQL, scope adwords, bez developer-token; MCC jen s nadřazeným ID', async () => {
    const g = falesnyGoogle(() => fixture('google_ads-search-stream'));
    const radky = await googleAds.fetchDaily({ source, ...OKNO, googleJsonImpl: g.googleJsonImpl });
    assert.equal(g.volani.length, 1);
    const v = g.volani[0];
    assert.equal(v.url, 'https://googleads.googleapis.com/v26/customers/8827181396/googleAds:searchStream');
    assert.equal(v.method, 'POST');
    assert.deepEqual(v.body, { query: googleAds.gaql('2026-10-05', '2026-10-06') });
    assert.deepEqual(v.scopes, ['https://www.googleapis.com/auth/adwords']);
    assert.deepEqual(v.headers, {});
    assert.equal(radky.length, 6);
    for (const r of radky) assert.deepEqual(Object.keys(r), TVAR_RADKU);
    assert.equal(najdi(radky, '2026-10-05').cost, 1099.47);

    const mcc = falesnyGoogle(() => []);
    const nic = await googleAds.fetchDaily({ source: { ...source, parent_external_id: '1112223334' }, ...OKNO, googleJsonImpl: mcc.googleJsonImpl });
    assert.deepEqual(mcc.volani[0].headers, { 'login-customer-id': '1112223334' });
    assert.deepEqual(nic, [], 'bez útraty prázdno, ne chyba');
  });

  test('chyby: trvalé vs. přechodné', async () => {
    await overChybyGoogle(googleAds, source);
  });

  test('overit: GAQL na customer, měna a pásmo; prázdná odpověď je ok: false', async () => {
    const g = falesnyGoogle(() => fixture('google_ads-customer'));
    const v = await googleAds.overit({ source, googleJsonImpl: g.googleJsonImpl });
    assert.deepEqual(v, { ok: true, zprava: 'Účet 882-718-1396 (Toneráček), měna CZK, pásmo Europe/Prague' });
    assert.deepEqual(g.volani[0].body, { query: googleAds.GAQL_UCET });
    const prazdna = falesnyGoogle(() => [{ results: [] }]);
    assert.equal((await googleAds.overit({ source, googleJsonImpl: prazdna.googleJsonImpl })).ok, false);
    const chyba = falesnyGoogle(() => { throw googleChyba(401); });
    const n = await googleAds.overit({ source, googleJsonImpl: chyba.googleJsonImpl });
    assert.equal(n.ok, false);
    assert.match(n.zprava, /401/);
  });
});

// ── Search Console ─────────────────────────────────────────────

describe('search_console', () => {
  const source = { external_id: 'sc-domain:toneracek.cz' };
  const odpoved = () => ({ dny: fixture('search_console-dny'), dotazy: fixture('search_console-dotazy') });

  test('parsuj: součty s position_sum = pozice × zobrazení, dotazy, dopočet chybějícího dne', () => {
    const ctx = { from: '2026-10-05', to: '2026-10-07', varovani: [] };
    const radky = searchConsole.parsuj(odpoved(), ctx);
    const d5 = najdi(radky, '2026-10-05');
    assert.equal(d5.clicks, 23);
    assert.equal(d5.impressions, 1870);
    assert.equal(d5.position_sum, 27489);     // 14,7 × 1870
    assert.equal(najdi(radky, '2026-10-06').position_sum, 25668.8);
    const d7 = najdi(radky, '2026-10-07');
    assert.equal(d7.clicks, 1);
    assert.equal(d7.impressions, 20);
    assert.equal(d7.position_sum, 100);
    assert.deepEqual(ctx.varovani, ['Search Console: součet dne 2026-10-07 chybí, dopočítán z dotazů (anonymizované dotazy v něm nejsou)']);
    const dotazy = rozpad(radky, 'query');
    assert.equal(dotazy.length, 7);
    const hp = najdi(radky, '2026-10-05', 'toner hp 305xl');
    assert.equal(hp.clicks, 6);
    assert.equal(hp.position_sum, 574);
    assert.equal(dotazy.filter(r => r.date === '2026-10-05')[0].segment, 'toner hp 305xl', 'nejvíc kliků první');
    assert.deepEqual(searchConsole.parsuj({ dny: {}, dotazy: {} }), []);
  });

  test('parsuj nechá jen 50 dotazů na den podle kliků', () => {
    const rows = [];
    for (let i = 0; i < 70; i++) rows.push({ keys: ['2026-10-05', `dotaz ${i}`], clicks: i, impressions: 100, ctr: 0.1, position: 3 });
    for (let i = 0; i < 5; i++) rows.push({ keys: ['2026-10-06', `jiný ${i}`], clicks: 1, impressions: 10, ctr: 0.1, position: 3 });
    const radky = searchConsole.parsuj({ dny: fixture('search_console-dny'), dotazy: { rows } }, { varovani: [] });
    const d5 = rozpad(radky, 'query').filter(r => r.date === '2026-10-05');
    assert.equal(d5.length, 50);
    assert.equal(d5[0].segment, 'dotaz 69');
    assert.equal(d5.at(-1).segment, 'dotaz 20');
    assert.equal(rozpad(radky, 'query').filter(r => r.date === '2026-10-06').length, 5);
  });

  test('těla dotazů a kontrola property', () => {
    assert.deepEqual(searchConsole.dotazDny('2026-10-05', '2026-10-06'), { startDate: '2026-10-05', endDate: '2026-10-06', dimensions: ['date'], rowLimit: 1000 });
    assert.deepEqual(searchConsole.dotazDotazy('2026-10-05', '2026-10-06', 25_000), { startDate: '2026-10-05', endDate: '2026-10-06', dimensions: ['date', 'query'], rowLimit: 25_000, startRow: 25_000 });
    assert.equal(searchConsole.siteUrl(source), 'sc-domain:toneracek.cz');
    assert.equal(searchConsole.siteUrl({ external_id: ' https://toneracek.cz/ ' }), 'https://toneracek.cz/');
    assert.throws(() => searchConsole.siteUrl({ external_id: 'toneracek.cz' }), (e) => e instanceof AdapterError && e.permanent);
  });

  test('fetchDaily: property v cestě zakódovaná, scope webmasters.readonly, dotazy stránkované po 25 000', async () => {
    const o = odpoved();
    const g = falesnyGoogle((url, opts) => (opts.body.dimensions.length === 1 ? o.dny : o.dotazy));
    const radky = await searchConsole.fetchDaily({ source, ...OKNO, googleJsonImpl: g.googleJsonImpl });
    assert.equal(g.volani.length, 2);
    for (const v of g.volani) {
      assert.equal(v.url, 'https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Atoneracek.cz/searchAnalytics/query');
      assert.equal(v.method, 'POST');
      assert.deepEqual(v.scopes, ['https://www.googleapis.com/auth/webmasters.readonly']);
    }
    assert.equal(soucty(radky).length, 2);
    assert.equal(rozpad(radky, 'query').length, 6);
    for (const r of radky) assert.deepEqual(Object.keys(r), TVAR_RADKU);

    // plná stránka dotazů → druhá stránka se startRow
    const plna = { rows: Array.from({ length: 25_000 }, (_, i) => ({ keys: ['2026-10-05', `q${i}`], clicks: i % 97, impressions: 100, ctr: 0, position: 2 })) };
    const s = falesnyGoogle((url, opts) => (opts.body.dimensions.length === 1 ? o.dny : opts.body.startRow === 0 ? plna : { rows: [{ keys: ['2026-10-06', 'zbytek'], clicks: 1, impressions: 1, ctr: 1, position: 1 }] }));
    const r2 = await searchConsole.fetchDaily({ source, ...OKNO, googleJsonImpl: s.googleJsonImpl });
    assert.equal(s.volani.length, 3);
    assert.equal(s.volani[2].body.startRow, 25_000);
    assert.equal(rozpad(r2, 'query').filter(r => r.date === '2026-10-05').length, 50);
    assert.ok(najdi(r2, '2026-10-06', 'zbytek'));
  });

  test('chyby: trvalé vs. přechodné', async () => {
    await overChybyGoogle(searchConsole, source);
  });

  test('overit: web v seznamu s oprávněním, jinak návod koho přidat', async () => {
    const g = falesnyGoogle(() => fixture('search_console-sites'));
    const v = await searchConsole.overit({ source, googleJsonImpl: g.googleJsonImpl });
    assert.deepEqual(v, { ok: true, zprava: 'Property sc-domain:toneracek.cz, oprávnění siteRestrictedUser' });
    assert.equal(g.volani[0].url, 'https://searchconsole.googleapis.com/webmasters/v3/sites');
    const bezLomitka = await searchConsole.overit({ source: { external_id: 'https://dilnavlnenka.cz' }, googleJsonImpl: g.googleJsonImpl });
    assert.equal(bezLomitka.ok, true, 'lomítko na konci nerozhoduje');
    const cizi = await searchConsole.overit({ source: { external_id: 'sc-domain:jiny.cz' }, googleJsonImpl: g.googleJsonImpl });
    assert.equal(cizi.ok, false);
    assert.match(cizi.zprava, /není mezi weby service accountu/);
    assert.match(cizi.zprava, /sc-domain:toneracek\.cz, https:\/\/dilnavlnenka\.cz\//);
    assert.match(cizi.zprava, new RegExp(SA_EMAIL.replace(/[.@]/g, '\\$&')));
    const neoverena = falesnyGoogle(() => ({ siteEntry: [{ siteUrl: 'sc-domain:toneracek.cz', permissionLevel: 'siteUnverifiedUser' }] }));
    assert.match((await searchConsole.overit({ source, googleJsonImpl: neoverena.googleJsonImpl })).zprava, /neověřená/);
    const chyba = falesnyGoogle(() => { throw googleChyba(403); });
    assert.equal((await searchConsole.overit({ source, googleJsonImpl: chyba.googleJsonImpl })).ok, false);
  });
});

// ── Merchant Center ────────────────────────────────────────────

describe('merchant', () => {
  const source = { external_id: '123456789' };
  const odpoved = () => ({ vykony: [fixture('merchant-vykony-1'), fixture('merchant-vykony-2')], stavy: fixture('merchant-stavy') });

  test('parsuj: kanály ORGANIC/ADS, součty, stav položek SHOPPING_ADS na poslední den okna; datum objekt i řetězec', () => {
    const ctx = { ...OKNO, varovani: [] };
    const radky = merchant.parsuj(odpoved(), ctx);
    assert.deepEqual(soucty(radky).map(r => r.date), ['2026-10-05', '2026-10-06']);
    const d5 = najdi(radky, '2026-10-05');
    assert.equal(d5.clicks, 175);
    assert.equal(d5.impressions, 12930);
    assert.equal(d5.approved_items, 0);
    const d6 = najdi(radky, '2026-10-06');
    assert.equal(d6.clicks, 98);
    assert.equal(d6.impressions, 7390);
    assert.equal(d6.approved_items, 1500);     // SHOPPING_ADS CZ 1498 + SK 2, FREE_LISTINGS se nepočítá
    assert.equal(d6.disapproved_items, 58);
    assert.equal(d6.cost, 0);
    const kanaly = rozpad(radky, 'channel');
    assert.equal(kanaly.length, 4);
    assert.equal(najdi(radky, '2026-10-05', 'ADS').clicks, 134);
    assert.equal(najdi(radky, '2026-10-06', 'ADS').clicks, 61, 'datum jako řetězec funguje');
    assert.deepEqual(ctx.varovani, []);
  });

  test('stav položek: bez SHOPPING_ADS se berou všechny záznamy; bez výkonů vznikne řádek jen se stavem', () => {
    assert.equal(merchant.stavPolozek({ aggregateProductStatuses: [] }), null);
    assert.equal(merchant.stavPolozek(null), null);
    const jenFree = merchant.stavPolozek({ aggregateProductStatuses: [{ reportingContext: 'FREE_LISTINGS', stats: { activeCount: '10', disapprovedCount: '2' } }] });
    assert.deepEqual(jenFree, { approved: 10, disapproved: 2, kontext: 'vše' });
    const radky = merchant.parsuj({ vykony: { results: [] }, stavy: fixture('merchant-stavy') }, OKNO);
    assert.equal(radky.length, 1);
    assert.equal(radky[0].date, '2026-10-06');
    assert.equal(radky[0].segment_kind, '');
    assert.equal(radky[0].approved_items, 1500);
    assert.deepEqual(Object.keys(radky[0]), TVAR_RADKU);
    assert.deepEqual(merchant.parsuj({}), []);
  });

  test('fetchDaily: reports:search s MCQL a pageToken, pak aggregateProductStatuses; scope content', async () => {
    const o = odpoved();
    const g = falesnyGoogle((url, opts) => {
      if (url.endsWith('reports:search')) return opts.body.pageToken ? o.vykony[1] : o.vykony[0];
      if (url.includes('aggregateProductStatuses')) return o.stavy;
      throw new Error(`nečekaná adresa ${url}`);
    });
    const dnes = () => new Date('2026-10-07T10:00:00Z');   // včerejšek 6. 10. = konec okna → stav položek se stahuje
    const radky = await merchant.fetchDaily({ source, ...OKNO, googleJsonImpl: g.googleJsonImpl, now: dnes });
    assert.equal(g.volani.length, 3);
    assert.equal(g.volani[0].url, 'https://merchantapi.googleapis.com/reports/v1/accounts/123456789/reports:search');
    assert.equal(g.volani[0].method, 'POST');
    assert.deepEqual(g.volani[0].body, { query: merchant.dotazVykonu('2026-10-05', '2026-10-06'), pageSize: 1000 });
    assert.equal(g.volani[1].body.pageToken, 'CAoQARiA0ZOA2pSxAw==');
    assert.equal(g.volani[2].url, 'https://merchantapi.googleapis.com/issueresolution/v1/accounts/123456789/aggregateProductStatuses');
    assert.equal(g.volani[2].method, 'GET');
    assert.equal(g.volani[2].params.pageSize, 100);
    for (const v of g.volani) assert.deepEqual(v.scopes, ['https://www.googleapis.com/auth/content']);
    assert.equal(merchant.dotazVykonu('2026-10-05', '2026-10-06'),
      "SELECT date, marketing_method, clicks, impressions, click_through_rate FROM product_performance_view WHERE date BETWEEN '2026-10-05' AND '2026-10-06'");
    assert.equal(radky.length, 6);
    assert.equal(najdi(radky, '2026-10-06').disapproved_items, 58);
    for (const r of radky) assert.deepEqual(Object.keys(r), TVAR_RADKU);
    assert.throws(() => merchant.accountId({ external_id: 'abc' }), (e) => e instanceof AdapterError && e.permanent);
  });

  test('chyby: trvalé vs. přechodné', async () => {
    await overChybyGoogle(merchant, source);
  });

  test('fetchDaily: historický kus okna (nekončí včerejškem) stav položek nestahuje ani nepřipisuje', async () => {
    const o = odpoved();
    const g = falesnyGoogle((url, opts) => (url.endsWith('reports:search') ? (opts.body.pageToken ? o.vykony[1] : o.vykony[0]) : o.stavy));
    const zaznamy = [];
    const radky = await merchant.fetchDaily({ source, ...OKNO, googleJsonImpl: g.googleJsonImpl, now: () => new Date('2026-10-29T10:00:00Z'), log: { info: (x, m) => zaznamy.push(m) } });
    assert.equal(g.volani.length, 2, 'jen dvě stránky reportu, žádné aggregateProductStatuses');
    assert.ok(g.volani.every(v => v.url.endsWith('reports:search')));
    assert.equal(najdi(radky, '2026-10-06').approved_items, 0);
    assert.equal(najdi(radky, '2026-10-06').disapproved_items, 0);
    assert.equal(najdi(radky, '2026-10-06').clicks, 98);
    assert.match(zaznamy[0], /nekončí včerejškem/);
  });

  test('overit: účet přes Accounts API', async () => {
    const g = falesnyGoogle(() => fixture('merchant-ucet'));
    assert.deepEqual(await merchant.overit({ source, googleJsonImpl: g.googleJsonImpl }), { ok: true, zprava: 'Účet 123456789 (Toneráček), pásmo Europe/Prague' });
    assert.equal(g.volani[0].url, 'https://merchantapi.googleapis.com/accounts/v1/accounts/123456789');
    const chyba = falesnyGoogle(() => { throw googleChyba(404); });
    const n = await merchant.overit({ source, googleJsonImpl: chyba.googleJsonImpl });
    assert.equal(n.ok, false);
    assert.match(n.zprava, /404/);
  });
});

// ── Sklik ──────────────────────────────────────────────────────

describe('sklik', () => {
  const KLIC = 'fenix-api-klic-TAJNY';
  const source = { external_id: '', parent_external_id: '' };
  const stranky = () => [fixture('sklik-kampane-1'), fixture('sklik-kampane-2')];

  /** Odpovědi API Fénix podle adresy: token, kampaně po stránkách (offset), účet, kredit. */
  function fenix({ kampane = (offset) => (offset === '0' ? fixture('sklik-kampane-1') : fixture('sklik-kampane-2')), token = () => ({ json: fixture('sklik-token') }) } = {}) {
    return (url) => {
      const u = new URL(url);
      if (u.pathname === '/v1/user/token') return token();
      if (u.pathname === '/v1/sklik/campaigns/') return { json: kampane(u.searchParams.get('offset'), u) };
      if (u.pathname === '/v1/user/me') return { json: fixture('sklik-user-me') };
      if (u.pathname === '/v1/user/me/credit') return { json: fixture('sklik-credit') };
      return { status: 404, json: { error: 'not found' } };
    };
  }

  beforeEach(() => sklik.vymazTokenySklik());

  test('parsuj: haléře → Kč, kampaně typu zbozi pod platformou zbozi, součet pro každou platformu a den', () => {
    const ctx = { ...OKNO, varovani: [] };
    const radky = sklik.parsuj(stranky(), ctx);
    assert.deepEqual(soucty(radky).map(r => `${r.platform}|${r.date}`).sort(), ['sklik|2026-10-05', 'sklik|2026-10-06', 'zbozi|2026-10-05', 'zbozi|2026-10-06']);
    const s5 = najdi(radky, '2026-10-05', '', 'sklik');
    assert.equal(s5.cost, 1234.5);                 // 123 450 haléřů
    assert.equal(s5.conversion_value, 3189);        // 318 900 haléřů
    assert.equal(s5.impressions, 2310);
    assert.equal(s5.clicks, 96);
    assert.equal(s5.conversions, 2);
    const z5 = najdi(radky, '2026-10-05', '', 'zbozi');
    assert.equal(z5.cost, 616);
    assert.equal(z5.conversions, 1);
    assert.equal(z5.conversion_value, 1290);
    const z6 = najdi(radky, '2026-10-06', '', 'zbozi');
    assert.equal(z6.cost, 525.5, 'bucket s firstDate a bez konverzí');
    assert.equal(z6.conversions, 0);
    const s6 = najdi(radky, '2026-10-06', '', 'sklik');
    assert.equal(s6.cost, 1053.55);                 // 980,05 + 73,50
    assert.equal(s6.impressions, 14380);
    assert.equal(s6.clicks, 86);
    assert.equal(s6.conversions, 0, 'záporná oprava do součtu nejde');
    const kampane = rozpad(radky, 'campaign');
    assert.equal(kampane.length, 5);
    const retarg = najdi(radky, '2026-10-06', 'Obsahová – retargeting', 'sklik');
    assert.equal(retarg.date, '2026-10-06', 'den řádku je jeho firstDate');
    assert.equal(retarg.clicks, 15);
    assert.equal(retarg.cost, 73.5);
    assert.equal(retarg.conversions, -1, 'řádek rozpadu nese opravu dál, normalizace ji ohlásí');
    assert.deepEqual(normalizujRadek(retarg, { ...OKNO, platform: 'sklik' }).varovani, ['conversions 2026-10-06 (Obsahová – retargeting): záporná hodnota -1 nahrazena nulou']);
    for (const k of kampane) assert.ok(soucty(radky).some(s => s.platform === k.platform && s.date === k.date), `${k.platform} ${k.date}: rozpad má svůj denní součet`);
    assert.deepEqual(ctx.varovani, ['1 záporných hodnot rozpadu do denního součtu nevstoupilo']);
    assert.equal(sklik.platformaKampane({ type: 'zbozi' }), 'zbozi');
    assert.equal(sklik.platformaKampane({ type: 'combined' }), 'sklik');
    assert.equal(sklik.platformaKampane({}), 'sklik');
  });

  test('parsuj: plochá odpověď (kampaň × den v items) — jedna stránka, holé pole řádků, řádek bez firstDate se přeskočí s varováním', () => {
    const jedna = sklik.parsuj(fixture('sklik-kampane-1'));
    assert.equal(soucty(jedna).length, 3);                                   // sklik 5. a 6. 10., zbozi 5. 10.
    const hole = sklik.parsuj(fixture('sklik-kampane-1').items);
    assert.deepEqual(hole, jedna, 'holé pole řádků = jedna stránka');
    const ctx = { varovani: [] };
    const jine = sklik.parsuj({ items: [{ id: 1, type: 'fulltext', firstDate: '2026-10-05', totalMoney: 100 }, { id: 2, name: 'Bez statistik', type: 'fulltext', firstDate: null, impressions: 0 }] }, ctx);
    assert.equal(jine.length, 2);
    assert.equal(jine[1].segment, 'Kampaň 1', 'bez názvu se použije ID');
    assert.equal(jine[1].cost, 1);
    assert.deepEqual(ctx.varovani, ['Sklik: 1 řádků statistik bez data (firstDate) přeskočeno']);
    assert.deepEqual(sklik.parsuj({ items: [] }), []);
    assert.deepEqual(sklik.parsuj(null), []);
    assert.equal(sklik.pocetRadku(fixture('sklik-kampane-1')), 3);
    assert.equal(sklik.pocetRadku(fixture('sklik-kampane-2')), 2);
    assert.equal(sklik.pocetRadku({ campaigns: [{}] }), 0, 'jiný klíč než items není stránka');
  });

  test('adresa statistik kampaní: denní granularita, atributy a= (identifikace + statistiky), limit 1000', () => {
    const u = new URL(sklik.urlKampani('2026-10-05', '2026-10-06', { limit: 3, offset: 6 }));
    assert.equal(u.origin + u.pathname, 'https://api.sklik.cz/v1/sklik/campaigns/');
    assert.deepEqual(Object.fromEntries(u.searchParams), { statisticsDateFrom: '2026-10-05', statisticsDateTo: '2026-10-06', statisticsGranularity: 'daily', a: 'conversionValue', limit: '3', offset: '6' });
    assert.deepEqual(u.searchParams.getAll('a'), ['id', 'name', 'type', 'clicks', 'impressions', 'totalMoney', 'conversions', 'conversionValue'], 'bez atributů a= by odpověď statistiky nenesla');
    assert.equal(new URL(sklik.urlKampani('a', 'b')).searchParams.get('limit'), '1000');
    assert.equal(sklik.maxDniNaDotaz, 30, 'denní granularita snese nejvýš měsíc (60 bucketů)');
  });

  test('fetchDaily: token z klíče, stránkování po řádcích kampaň × den, prodleva 250 ms, token v paměti pro další běh', async () => {
    const f = falesnyFetch(fenix());
    const spanky = [];
    const radky = await sklik.fetchDaily({ source, ...OKNO, tajemstvi: KLIC, fetchImpl: f.fetchImpl, sleep: async (ms) => { spanky.push(ms); }, limit: 3 });
    assert.deepEqual(f.volani.map(v => `${v.method} ${new URL(v.url).pathname}`), ['POST /v1/user/token', 'GET /v1/sklik/campaigns/', 'GET /v1/sklik/campaigns/']);
    const token = f.volani[0];
    assert.equal(token.headers.authorization, `Bearer ${KLIC}`);
    assert.equal(token.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(token.body, 'grant_type=client_credentials');
    assert.equal(f.volani[1].headers.authorization, 'Bearer fenix-access-token-TAJNE');
    assert.equal(new URL(f.volani[1].url).searchParams.get('offset'), '0');
    assert.equal(new URL(f.volani[2].url).searchParams.get('offset'), '3');
    assert.deepEqual(spanky, [250]);
    assert.equal(soucty(radky).length, 4);
    assert.equal(rozpad(radky, 'campaign').length, 5);
    for (const r of radky) assert.deepEqual(Object.keys(r), TVAR_RADKU);
    assert.equal(najdi(radky, '2026-10-06', 'Obsahová – retargeting', 'sklik').conversions, 0, 'po normalizaci');
    assert.equal(najdi(radky, '2026-10-05', '', 'zbozi').cost, 616);

    const znovu = falesnyFetch(fenix());
    await sklik.fetchDaily({ source, ...OKNO, tajemstvi: KLIC, fetchImpl: znovu.fetchImpl, sleep: bezSpanku, limit: 3 });
    assert.equal(znovu.volani.filter(v => v.url.endsWith('/user/token')).length, 0, 'token z paměti');

    const jinyKlic = falesnyFetch(fenix());
    await sklik.fetchDaily({ source, ...OKNO, tajemstvi: 'jiny-klic', fetchImpl: jinyKlic.fetchImpl, sleep: bezSpanku, limit: 3 });
    assert.equal(jinyKlic.volani.filter(v => v.url.endsWith('/user/token')).length, 1, 'jiný klíč = jiný token');
  });

  test('fetchDaily: user_id jde do žádosti o token jen s propojeným účtem; opakovaná stránka se nesečte dvakrát a stránkování skončí', async () => {
    const f = falesnyFetch(fenix({ kampane: () => fixture('sklik-kampane-1') }));
    const zaznamy = [];
    const radky = await sklik.fetchDaily({ source: { external_id: '456789' }, ...OKNO, tajemstvi: KLIC, fetchImpl: f.fetchImpl, sleep: bezSpanku, limit: 3, log: { warn: (o, m) => zaznamy.push(m) } });
    assert.equal(f.volani[0].body, 'grant_type=client_credentials&user_id=456789');
    // první stránka má 3 = limit řádků → druhá stránka; ta je stejná → konec bez jejího započtení
    assert.equal(f.volani.filter(v => v.url.includes('/sklik/campaigns/')).length, 2);
    assert.equal(najdi(radky, '2026-10-05', '', 'sklik').cost, 1234.5, 'opakovaná stránka náklady nezdvojí');
    assert.equal(najdi(radky, '2026-10-05', 'Tonery – vyhledávání', 'sklik').cost, 1234.5);
    assert.equal(rozpad(radky, 'campaign').length, 3);
    assert.match(zaznamy[0], /stránka s offsetem 3 je stejná/);
  });

  test('fetchDaily: 401 u dat obnoví token jednou, podruhé je to trvalá chyba s návodem na klíč Fénix', async () => {
    const g = falesnyFetch((url, poradi) => {
      const u = new URL(url);
      if (u.pathname === '/v1/user/token') return { json: { access_token: `token-${poradi}`, expires_in: 3600 } };
      if (poradi === 2) return { status: 401, json: { error: 'invalid_token' } };
      return { json: fixture('sklik-kampane-2') };
    });
    const radky = await sklik.fetchDaily({ source, ...OKNO, tajemstvi: KLIC, fetchImpl: g.fetchImpl, sleep: bezSpanku });
    assert.deepEqual(g.volani.map(v => new URL(v.url).pathname), ['/v1/user/token', '/v1/sklik/campaigns/', '/v1/user/token', '/v1/sklik/campaigns/']);
    assert.equal(g.volani[3].headers.authorization, 'Bearer token-3');
    assert.ok(radky.length > 0);

    sklik.vymazTokenySklik();
    const stale401 = falesnyFetch((url) => (new URL(url).pathname === '/v1/user/token' ? { json: fixture('sklik-token') } : { status: 401, json: { error: 'invalid_token' } }));
    const err = await sklik.fetchDaily({ source, ...OKNO, tajemstvi: KLIC, fetchImpl: stale401.fetchImpl, sleep: bezSpanku }).catch(e => e);
    assert.ok(err instanceof AdapterError);
    assert.equal(err.permanent, true);
    assert.equal(err.status, 401);
    assert.match(err.message, /API Fénix/);
    assert.equal(stale401.volani.length, 4, 'token, data 401, nový token, data 401 — pak konec');
  });

  test('chyby: neplatný klíč u tokenu je trvalá, 429/5xx/síť přechodné; bez klíče se nevolá nic', async () => {
    const vstup = { source, ...OKNO, tajemstvi: KLIC };
    await overChybyFetch(sklik, vstup, (status) => (url) => (new URL(url).pathname === '/v1/user/token' ? { status, json: { error: 'x' } } : { json: fixture('sklik-kampane-2') }), { trvale: [400, 401, 403] });
    sklik.vymazTokenySklik();
    const invalidGrant = falesnyFetch({ status: 400, json: { error: 'invalid_grant' } });
    const e400 = await sklik.fetchDaily({ ...vstup, fetchImpl: invalidGrant.fetchImpl, sleep: bezSpanku }).catch(e => e);
    assert.equal(e400.permanent, true);
    assert.match(e400.message, /Správa klíčů API Fénix/, 'u tokenu je i 400 (invalid_grant) špatný klíč s návodem');
    sklik.vymazTokenySklik();
    await overChybyFetch(sklik, vstup, (status) => (url) => (new URL(url).pathname === '/v1/user/token' ? { json: fixture('sklik-token') } : { status, json: { error: 'x' } }), { trvale: [400, 403, 404], prechodne: [429, 500], volaniTrvale: 2, pred: () => sklik.vymazTokenySklik() });
    const f = falesnyFetch(fenix());
    const err = await sklik.fetchDaily({ source, ...OKNO, tajemstvi: '', fetchImpl: f.fetchImpl }).catch(e => e);
    assert.equal(err.permanent, true);
    assert.match(err.message, /chybí klíč API Fénix/);
    assert.equal(f.volani.length, 0);
    assert.equal(f.volani.every(v => !v.body?.includes(KLIC)), true);
  });

  test('overit: účet (userName) a kredit Peněženky v Kč; klient agentury bez kreditu; klíč bez scope campaign; špatný klíč ok: false', async () => {
    const f = falesnyFetch(fenix());
    const v = await sklik.overit({ source, tajemstvi: KLIC, fetchImpl: f.fetchImpl, sleep: bezSpanku });
    assert.equal(v.ok, true);
    assert.match(v.zprava, /^Účet Sklik obchod@toneracek\.cz, kredit Peněženky 12.500 Kč bez DPH, pásmo Europe\/Prague$/);
    assert.deepEqual(f.volani.map(x => new URL(x.url).pathname), ['/v1/user/token', '/v1/user/me', '/v1/user/me/credit']);

    sklik.vymazTokenySklik();
    const agentura = falesnyFetch((url) => (new URL(url).pathname === '/v1/user/me/credit' ? { json: { verifiedInWallet: false, agencyStatus: 'client-agency', agencyLimit: null } } : fenix()(url)));
    assert.match((await sklik.overit({ source: { external_id: '456789' }, tajemstvi: KLIC, fetchImpl: agentura.fetchImpl, sleep: bezSpanku })).zprava, /\(propojený účet 456789\), bez vlastní Peněženky \(client-agency\)/);

    sklik.vymazTokenySklik();
    const bezScope = falesnyFetch((url) => (new URL(url).pathname === '/v1/user/me' ? { json: { ...fixture('sklik-user-me'), scope: ['ad_list'] } } : fenix()(url)));
    const s = await sklik.overit({ source, tajemstvi: KLIC, fetchImpl: bezScope.fetchImpl, sleep: bezSpanku });
    assert.equal(s.ok, false);
    assert.match(s.zprava, /nemá právo „campaign“/);

    sklik.vymazTokenySklik();
    const spatny = falesnyFetch({ status: 401, json: { error: 'invalid_client' } });
    const n = await sklik.overit({ source, tajemstvi: 'spatny', fetchImpl: spatny.fetchImpl, sleep: bezSpanku });
    assert.equal(n.ok, false);
    assert.match(n.zprava, /HTTP 401/);
    assert.match(n.zprava, /Správa klíčů API Fénix/);
    assert.equal(n.zprava.includes('spatny'), false, 'klíč v hlášce není');
    assert.equal((await sklik.overit({ source, tajemstvi: '' })).ok, false);
  });
});

// ── Heureka ────────────────────────────────────────────────────

describe('heureka', () => {
  const KLIC = 'heureka-klic-TAJNY';
  const vstup = { source: {}, ...OKNO, tajemstvi: KLIC, sleep: bezSpanku };

  test('parsuj: součet dne z návštěv, objednávek, tržeb a nákladů bez/s DPH; produkty sečtené přes zdroje kliku a seřazené podle nákladů', () => {
    const ctx = { ...OKNO, den: '2026-10-05', varovani: [] };
    const radky = heureka.parsuj(fixture('heureka-konverze-2026-10-05'), ctx);
    const s = soucty(radky);
    assert.equal(s.length, 1);
    assert.equal(s[0].date, '2026-10-05');
    assert.equal(s[0].clicks, 45);
    assert.equal(s[0].cost, 204);
    assert.equal(s[0].cost_with_vat, 246.84);
    assert.equal(s[0].conversions, 3);
    assert.equal(s[0].conversion_value, 2868);
    assert.equal(s[0].impressions, 0, 'Heureka imprese neposílá');
    const produkty = rozpad(radky, 'product');
    assert.deepEqual(produkty.map(r => r.segment), ['T01020 HP 305XL černá', 'T03031 Canon CRG-716Y žlutý', 'T09999 Epson 603 sada']);
    assert.equal(produkty[1].clicks, 20);
    assert.equal(produkty[1].cost, 94);
    assert.equal(produkty[1].cost_with_vat, 113.74);
    assert.equal(produkty[2].cost, 0, 'null náklady jsou nula');
    assert.deepEqual(ctx.varovani, []);

    const d6 = heureka.parsuj(fixture('heureka-konverze-2026-10-06'), { den: '2026-10-06' });
    assert.equal(najdi(d6, '2026-10-06').cost, 55, 'řetězcové částky');
    assert.equal(najdi(d6, '2026-10-06').cost_with_vat, 66.55);
    assert.deepEqual(heureka.parsuj(fixture('heureka-konverze-prazdny'), { den: '2026-10-07' }), [], 'den bez dat nemá řádek');
    assert.deepEqual(heureka.parsuj(null), []);
    const bezData = heureka.parsuj({ conversions: [{ shop_item: { id: 'X' }, visits: { total: 1 } }] }, { den: '2026-10-05' });
    assert.equal(bezData[0].date, '2026-10-05', 'datum z ctx.den, když záznam žádné nenese');
    assert.equal(heureka.parsuj({ conversions: [{ product_card_id: 7, visits: { total: 1 } }] }, { den: '2026-10-05' })[1].segment, 'karta 7');
  });

  test('parsuj nechá 50 produktů na den podle nákladů', () => {
    const conversions = Array.from({ length: 70 }, (_, i) => ({ date: '2026-10-05', shop_item: { id: `P${i}`, name: `Produkt ${i}` }, visits: { total: 1 }, costs_without_vat: { total: i }, costs_with_vat: { total: i * 1.21 } }));
    const radky = heureka.parsuj({ conversions }, { den: '2026-10-05' });
    const produkty = rozpad(radky, 'product');
    assert.equal(produkty.length, 50);
    assert.equal(produkty[0].segment, 'P69 Produkt 69');
    assert.equal(najdi(radky, '2026-10-05').cost, 69 * 70 / 2, 'součet je ze všech, ne jen z top 50');
    assert.equal(najdi(radky, '2026-10-05').clicks, 70);
  });

  test('pauza z hlaviček RateLimit', () => {
    assert.equal(heureka.pauzaZHlavicek({ 'ratelimit-remaining': '0', 'ratelimit-reset': '12' }), 12_000);
    assert.equal(heureka.pauzaZHlavicek({ 'ratelimit-remaining': '5', 'ratelimit-reset': '12' }), 0);
    assert.equal(heureka.pauzaZHlavicek({ ratelimit: 'limit=100, remaining=0, reset=7' }), 7000);
    assert.equal(heureka.pauzaZHlavicek({ 'ratelimit-remaining': '0', 'ratelimit-reset': '600' }), 60_000);
    assert.equal(heureka.pauzaZHlavicek({ 'ratelimit-remaining': '0' }), 0);
    assert.equal(heureka.pauzaZHlavicek({}), 0);
    assert.equal(heureka.pauzaZHlavicek(), 0);
  });

  test('fetchDaily: jedno volání na den s klíčem v hlavičce, prodleva mezi dny, čekání podle RateLimit', async () => {
    const spanky = [];
    const f = falesnyFetch((url) => {
      const den = new URL(url).searchParams.get('date');
      if (den === '2026-10-05') return { json: fixture('heureka-konverze-2026-10-05') };
      return { json: fixture('heureka-konverze-2026-10-06'), headers: { 'RateLimit-Remaining': '0', 'RateLimit-Reset': '3' } };
    });
    const radky = await heureka.fetchDaily({ ...vstup, fetchImpl: f.fetchImpl, sleep: async (ms) => { spanky.push(ms); } });
    assert.deepEqual(f.volani.map(v => v.url), ['https://api.heureka.group/v1/reports/conversions?date=2026-10-05', 'https://api.heureka.group/v1/reports/conversions?date=2026-10-06']);
    for (const v of f.volani) {
      assert.equal(v.method, 'GET');
      assert.equal(v.headers['x-heureka-api-key'], KLIC);
      assert.equal(v.headers['x-hg-portal'], 'heureka.cz');
    }
    assert.deepEqual(spanky, [200, 3000]);
    assert.equal(soucty(radky).length, 2);
    assert.equal(rozpad(radky, 'product').length, 4);
    for (const r of radky) assert.deepEqual(Object.keys(r), TVAR_RADKU);
    assert.equal(najdi(radky, '2026-10-05').cost_with_vat, 246.84);
    assert.equal(heureka.urlReportu('2026-10-05'), 'https://api.heureka.group/v1/reports/conversions?date=2026-10-05');
  });

  test('chyby: 401/403 trvalé s návodem na klíč, 429 opakuje podle Retry-After, bez klíče nic nevolá', async () => {
    await overChybyFetch(heureka, vstup, (status) => ({ status, json: { message: 'error' }, headers: status === 429 ? { 'Retry-After': '1' } : {} }));
    const f = falesnyFetch({ status: 401, json: {} });
    const err = await heureka.fetchDaily({ ...vstup, fetchImpl: f.fetchImpl, sleep: bezSpanku }).catch(e => e);
    assert.match(err.message, /API měření konverzí/);
    assert.equal(err.message.includes(KLIC), false);
    const bez = falesnyFetch({ json: {} });
    const e2 = await heureka.fetchDaily({ ...vstup, tajemstvi: null, fetchImpl: bez.fetchImpl }).catch(e => e);
    assert.equal(e2.permanent, true);
    assert.equal(bez.volani.length, 0);
    // 429 s Retry-After 10 s: prodleva před opakováním je 10 s (Retry-After prodlouží základní 2 s)
    const spanky = [];
    const limit = falesnyFetch([{ status: 429, json: { message: 'Too Many Requests' }, headers: { 'Retry-After': '10' } }, { json: fixture('heureka-konverze-prazdny') }]);
    await heureka.fetchDaily({ ...vstup, to: '2026-10-05', fetchImpl: limit.fetchImpl, sleep: async (ms) => { spanky.push(ms); } });
    assert.deepEqual(spanky, [10_000]);
    assert.equal(limit.volani.length, 2);
  });

  test('overit: stáhne včerejšek podle pražského dne a ohlásí počet řádků', async () => {
    const f = falesnyFetch((url) => ({ json: new URL(url).searchParams.get('date') === '2026-10-06' ? fixture('heureka-konverze-2026-10-06') : fixture('heureka-konverze-prazdny') }));
    const v = await heureka.overit({ tajemstvi: KLIC, fetchImpl: f.fetchImpl, sleep: bezSpanku, now: () => new Date('2026-10-06T23:30:00Z') });  // 7. 10. 1:30 v Praze
    assert.equal(v.ok, true);
    assert.equal(v.radku, 1);
    assert.match(v.zprava, /^Klíč platí; za 6\. 10\. 2026 1 řádků konverzí: 11 návštěv, 0 objednávek, náklady 55 Kč bez DPH$/);
    assert.equal(f.volani[0].url, 'https://api.heureka.group/v1/reports/conversions?date=2026-10-06');
    const prazdny = await heureka.overit({ tajemstvi: KLIC, fetchImpl: falesnyFetch({ json: fixture('heureka-konverze-prazdny') }).fetchImpl, sleep: bezSpanku, now: () => new Date('2026-10-10T10:00:00Z') });
    assert.equal(prazdny.radku, 0);
    assert.match(prazdny.zprava, /za 9\. 10\. 2026 0 řádků konverzí \(buď bez provozu/);
    const n = await heureka.overit({ tajemstvi: KLIC, fetchImpl: falesnyFetch({ status: 403, json: {} }).fetchImpl, sleep: bezSpanku });
    assert.equal(n.ok, false);
    assert.match(n.zprava, /HTTP 403/);
    assert.equal((await heureka.overit({ tajemstvi: '' })).ok, false);
  });
});

// ── Meta ───────────────────────────────────────────────────────

describe('meta', () => {
  const TOKEN = 'EAAB-system-user-token-TAJNY';
  const source = { external_id: 'act_123456789' };
  const vstup = { source, ...OKNO, tajemstvi: TOKEN, sleep: bezSpanku };

  test('parsuj: útrata, kliky na odkaz, nákupy omni_purchase s náhradou pixelu, součty po dnech', () => {
    const ctx = { ...OKNO, varovani: [] };
    const radky = meta.parsuj([fixture('meta-insights-1'), fixture('meta-insights-2')], ctx);
    assert.deepEqual(soucty(radky).map(r => r.date), ['2026-10-05', '2026-10-06']);
    const d5 = najdi(radky, '2026-10-05');
    assert.equal(d5.cost, 564.27);
    assert.equal(d5.impressions, 23590);
    assert.equal(d5.clicks, 231, 'inline_link_clicks, ne všechny kliky');
    assert.equal(d5.conversions, 2);
    assert.equal(d5.conversion_value, 1879);
    const d6 = najdi(radky, '2026-10-06');
    assert.equal(d6.conversions, 1, 'náhradní offsite_conversion.fb_pixel_purchase');
    assert.equal(d6.conversion_value, 649);
    const kampane = rozpad(radky, 'campaign');
    assert.equal(kampane.length, 3);
    const dpa = najdi(radky, '2026-10-05', 'Katalog – DPA');
    assert.equal(dpa.conversions, 0, 'kampaň bez actions');
    assert.equal(dpa.clicks, 160);
    assert.deepEqual(ctx.varovani, []);
    assert.deepEqual(meta.parsuj({ data: [] }), []);
    assert.deepEqual(meta.parsuj(null), []);
    const bezLink = meta.parsuj({ data: [{ campaign_name: 'X', clicks: '9', spend: '1', date_start: '2026-10-05' }] });
    assert.equal(najdi(bezLink, '2026-10-05', 'X').clicks, 9, 'bez inline_link_clicks se vezmou clicks');
  });

  test('hodnotaAkce a přechodné kódy Mety', () => {
    assert.equal(meta.hodnotaAkce([{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' }, { action_type: 'omni_purchase', value: '2' }]), 2);
    assert.equal(meta.hodnotaAkce([{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' }]), 3);
    assert.equal(meta.hodnotaAkce([{ action_type: 'link_click', value: '3' }]), 0);
    assert.equal(meta.hodnotaAkce(undefined), 0);
    assert.equal(meta.oznacPrechodnou(httpChyba(400, { error: { code: 17, message: 'User request limit reached' } })).retryable, true);
    assert.equal(meta.oznacPrechodnou(httpChyba(400, { error: { code: 1, is_transient: true } })).retryable, true);
    assert.equal(meta.oznacPrechodnou(httpChyba(400, { error: { code: 80000, error_subcode: 2446079, message: 'There have been too many calls to this ad-account' } })).retryable, true, 'limit Business Use Case pro Ads Insights');
    assert.equal(meta.oznacPrechodnou(httpChyba(400, { error: { code: 80004, error_subcode: 2446079 } })).retryable, true);
    assert.equal(meta.oznacPrechodnou(httpChyba(400, { error: { code: 190, message: 'Invalid OAuth access token' } })).retryable, false);
    assert.equal(meta.oznacPrechodnou(httpChyba(400)).retryable, false);
    assert.equal(meta.oznacPrechodnou(httpChyba(401, { error: { code: 1 } })).retryable, false, 'přechodné kódy platí jen pod HTTP 400');
  });

  test('adresa insights nese pole, time_range, limit 500 a token v query', () => {
    const u = new URL(meta.urlInsights('123456789', '2026-10-05', '2026-10-06', TOKEN));
    assert.equal(u.origin + u.pathname, 'https://graph.facebook.com/v26.0/act_123456789/insights');
    assert.equal(u.searchParams.get('level'), 'campaign');
    assert.equal(u.searchParams.get('fields'), 'campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,actions,action_values,purchase_roas');
    assert.equal(u.searchParams.get('time_increment'), '1');
    assert.deepEqual(JSON.parse(u.searchParams.get('time_range')), { since: '2026-10-05', until: '2026-10-06' });
    assert.equal(u.searchParams.get('limit'), '500');
    assert.equal(u.searchParams.get('access_token'), TOKEN);
    assert.equal(meta.accountId(source), '123456789');
    assert.throws(() => meta.accountId({ external_id: 'tonerácek' }), (e) => e instanceof AdapterError && e.permanent);
  });

  test('fetchDaily: sleduje paging.next přesně, vrací normalizované řádky', async () => {
    const strana1 = fixture('meta-insights-1');
    const f = falesnyFetch((url, poradi) => ({ json: poradi === 1 ? strana1 : fixture('meta-insights-2') }));
    const radky = await meta.fetchDaily({ ...vstup, fetchImpl: f.fetchImpl });
    assert.equal(f.volani.length, 2);
    assert.equal(f.volani[0].url, meta.urlInsights('123456789', '2026-10-05', '2026-10-06', TOKEN));
    assert.equal(f.volani[1].url, strana1.paging.next);
    assert.equal(soucty(radky).length, 2);
    assert.equal(rozpad(radky, 'campaign').length, 3);
    for (const r of radky) assert.deepEqual(Object.keys(r), TVAR_RADKU);
    assert.equal(najdi(radky, '2026-10-05').cost, 564.27);

    // druhá stránka (adresa s tokenem z paging.next) spadne → token nesmí být v hlášce ani v logu opakování
    const zaznamy = [];
    const pad = falesnyFetch((url, poradi) => (poradi === 1 ? { json: strana1 } : { status: 500, text: '<html>Service Unavailable</html>' }));
    const err = await meta.fetchDaily({ ...vstup, fetchImpl: pad.fetchImpl, log: { warn: (o, m) => zaznamy.push(JSON.stringify([o.err?.message, o.err?.url, m])) } }).catch(e => e);
    assert.ok(err instanceof AdapterError);
    assert.equal(err.permanent, false);
    assert.match(err.message, /strana 2/);
    assert.equal(err.message.includes('TAJNE-TOKEN'), false, 'token z paging.next není v hlášce');
    assert.ok(zaznamy.length >= 2);
    assert.equal(zaznamy.join('\n').includes('TAJNE-TOKEN'), false, 'ani v logu opakování');
  });

  test('chyby: 400 code 190 trvalá s návodem na token, 400 code 4 přechodná, 401 trvalá, 5xx přechodné; token v hlášce není', async () => {
    await overChybyFetch(meta, vstup, (status) => ({ status, json: { error: { message: 'x', code: status === 400 ? 100 : 1 } } }), { trvale: [400, 401, 403, 404] });
    const vyprsel = falesnyFetch({ status: 400, json: { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } } });
    const err = await meta.fetchDaily({ ...vstup, fetchImpl: vyprsel.fetchImpl, sleep: bezSpanku }).catch(e => e);
    assert.equal(err.permanent, true);
    assert.equal(err.status, 400);
    assert.match(err.message, /System User/);
    assert.equal(err.message.includes(TOKEN), false);
    assert.equal(vyprsel.volani.length, 1);
    const limit = falesnyFetch({ status: 400, json: { error: { message: 'Application request limit reached', code: 4 } } });
    const e2 = await meta.fetchDaily({ ...vstup, fetchImpl: limit.fetchImpl, sleep: bezSpanku }).catch(e => e);
    assert.equal(e2.permanent, false);
    assert.equal(limit.volani.length, 3);
    const bezTokenu = falesnyFetch({ json: {} });
    const e3 = await meta.fetchDaily({ ...vstup, tajemstvi: '', fetchImpl: bezTokenu.fetchImpl }).catch(e => e);
    assert.equal(e3.permanent, true);
    assert.equal(bezTokenu.volani.length, 0);
  });

  test('overit: název, měna a pásmo účtu', async () => {
    const f = falesnyFetch({ json: fixture('meta-ucet') });
    const v = await meta.overit({ ...vstup, fetchImpl: f.fetchImpl });
    assert.equal(f.volani.length, 1);
    assert.deepEqual(v, { ok: true, zprava: 'Účet act_123456789 (Toneráček), měna CZK, pásmo Europe/Prague' });
    const u = new URL(f.volani[0].url);
    assert.equal(u.pathname, '/v26.0/act_123456789');
    assert.equal(u.searchParams.get('fields'), 'name,currency,timezone_name');
    assert.equal(u.searchParams.get('access_token'), TOKEN);
    const eur = falesnyFetch({ json: { ...fixture('meta-ucet'), currency: 'EUR' } });
    assert.match((await meta.overit({ ...vstup, fetchImpl: eur.fetchImpl })).zprava, /účet je v EUR/);
    const n = await meta.overit({ ...vstup, fetchImpl: falesnyFetch({ status: 400, json: { error: { code: 190 } } }).fetchImpl, sleep: bezSpanku });
    assert.equal(n.ok, false);
    assert.match(n.zprava, /System User/);
  });
});

// ── e-shop ─────────────────────────────────────────────────────

describe('eshop', () => {
  const shop = { id: 1, slug: 'toneracek', url: 'https://toneracek.cz', webhook_secret: '' };
  const DNES = () => new Date('2026-10-07T10:00:00Z');
  const vstup = { shop, source: {}, ...OKNO, tajemstvi: 'webhook-TAJNE', now: DNES, sleep: bezSpanku };

  test('parsuj: denní součty jen v okně, dotazy bez výsledku na poslední den okna (sečtené přes shodný text)', () => {
    const ctx = { ...OKNO, varovani: [] };
    const radky = eshop.parsuj(fixture('eshop-statistika'), ctx);
    assert.deepEqual(soucty(radky).map(r => r.date), ['2026-10-05', '2026-10-06'], 'dnešek 7. 10. je mimo okno');
    const d5 = najdi(radky, '2026-10-05');
    assert.equal(d5.searches, 15);
    assert.equal(d5.searches_no_result, 2);
    assert.equal(d5.carts_abandoned, 1);
    assert.equal(d5.carts_value, 756);
    const d6 = najdi(radky, '2026-10-06');
    assert.equal(d6.carts_value, 2534);
    const dotazy = rozpad(radky, 'query');
    assert.deepEqual(dotazy.map(r => [r.date, r.segment, r.searches_no_result]), [['2026-10-06', 'canon 545 xl', 4], ['2026-10-06', 'brother tn 2421', 2]]);
    assert.deepEqual(ctx.varovani, []);
    assert.deepEqual(eshop.parsuj({}), []);
    const bezOkna = eshop.parsuj(fixture('eshop-statistika'));
    assert.equal(soucty(bezOkna).length, 3);
    assert.equal(rozpad(bezOkna, 'query')[0].date, '2026-10-07', 'bez okna poslední den s daty');
    // poslední den okna bez denního součtu (e-shop ho nevrátil) → dotazy jdou na poslední den, který součet má
    const bezPoslednihoDne = { ...fixture('eshop-statistika'), poDnech: fixture('eshop-statistika').poDnech.filter(d => d.datum !== '2026-10-06') };
    const r2 = eshop.parsuj(bezPoslednihoDne, ctx);
    assert.deepEqual(soucty(r2).map(r => r.date), ['2026-10-05']);
    assert.equal(rozpad(r2, 'query').length, 2);
    assert.ok(rozpad(r2, 'query').every(r => r.date === '2026-10-05'), 'rozpad nikdy bez denního součtu téhož dne');
    assert.deepEqual(rozpad(eshop.parsuj({ hledani: fixture('eshop-statistika').hledani }, ctx), 'query'), [], 'bez poDnech žádné dotazy');
  });

  test('pomocníci: tajemství podle e-shopu, adresa a počet dní', () => {
    const ulozeny = process.env.SHOP_WEBHOOK_SECRET;
    process.env.SHOP_WEBHOOK_SECRET = 'z-env';
    try {
      assert.equal(eshop.tajemstviEshopu(shop, ' predane '), 'predane');
      assert.equal(eshop.tajemstviEshopu(shop, ''), 'z-env');
      assert.equal(eshop.tajemstviEshopu({ slug: 'dilnavlnenka', webhook_secret: 'vlastni' }), 'vlastni');
      assert.equal(eshop.tajemstviEshopu({ slug: 'dilnavlnenka', webhook_secret: '' }), '', 'cizí e-shop globální tajemství nedostane');
    } finally {
      if (ulozeny === undefined) delete process.env.SHOP_WEBHOOK_SECRET;
      else process.env.SHOP_WEBHOOK_SECRET = ulozeny;
    }
    assert.equal(eshop.adresaStatistiky(shop, 3), 'https://toneracek.cz/api/marketing/statistika?dni=3');
    assert.equal(eshop.adresaStatistiky({ url: 'https://dilnavlnenka.cz/' }, 1), 'https://dilnavlnenka.cz/api/marketing/statistika?dni=1');
    assert.throws(() => eshop.adresaStatistiky({ slug: 'x', url: 'toneracek.cz' }, 1), (e) => e instanceof AdapterError && e.permanent);
    assert.equal(eshop.pocetDni('2026-10-05', '2026-10-07'), 3);
    assert.equal(eshop.pocetDni('2025-09-01', '2026-10-07'), 90);
    assert.equal(eshop.pocetDni('2026-10-09', '2026-10-07'), 1);
  });

  test('fetchDaily: dni ode dneška po from, tajemství v hlavičce, normalizované řádky; okno starší než 90 dní bez volání', async () => {
    const f = falesnyFetch({ json: fixture('eshop-statistika') });
    const radky = await eshop.fetchDaily({ ...vstup, fetchImpl: f.fetchImpl });
    assert.equal(f.volani.length, 1);
    assert.equal(f.volani[0].url, 'https://toneracek.cz/api/marketing/statistika?dni=3');
    assert.equal(f.volani[0].method, 'GET');
    assert.equal(f.volani[0].headers['x-webhook-secret'], 'webhook-TAJNE');
    assert.equal(radky.length, 4);
    for (const r of radky) assert.deepEqual(Object.keys(r), TVAR_RADKU);
    assert.equal(najdi(radky, '2026-10-06', 'canon 545 xl').searches_no_result, 4);

    const stare = falesnyFetch({ json: fixture('eshop-statistika') });
    const zaznamy = [];
    const nic = await eshop.fetchDaily({ ...vstup, from: '2025-10-01', to: '2025-10-31', fetchImpl: stare.fetchImpl, log: { info: (o, m) => zaznamy.push(m) } });
    assert.deepEqual(nic, []);
    assert.equal(stare.volani.length, 0);
    assert.match(zaznamy[0], /starší než 90 dní/);

    const dlouhe = falesnyFetch({ json: fixture('eshop-statistika') });
    await eshop.fetchDaily({ ...vstup, from: '2026-05-01', to: '2026-10-06', fetchImpl: dlouhe.fetchImpl });
    assert.equal(new URL(dlouhe.volani[0].url).searchParams.get('dni'), '90', 'strop e-shopu');
  });

  test('bez tajemství je to trvalá chyba s návodem podle e-shopu, bez volání', async () => {
    const ulozeny = process.env.SHOP_WEBHOOK_SECRET;
    delete process.env.SHOP_WEBHOOK_SECRET;
    try {
      const f = falesnyFetch({ json: {} });
      const err = await eshop.fetchDaily({ ...vstup, tajemstvi: '', fetchImpl: f.fetchImpl }).catch(e => e);
      assert.equal(err.permanent, true);
      assert.match(err.message, /SHOP_WEBHOOK_SECRET v prostředí One SEIL/);
      const dilna = await eshop.fetchDaily({ ...vstup, shop: { slug: 'dilnavlnenka', url: 'https://dilnavlnenka.cz', webhook_secret: '' }, tajemstvi: '', fetchImpl: f.fetchImpl }).catch(e => e);
      assert.match(dilna.message, /Nastavení → Eshopy → Napojení e-shopu/);
      assert.equal(f.volani.length, 0);
      assert.equal((await eshop.overit({ shop, tajemstvi: '', fetchImpl: f.fetchImpl })).ok, false);
    } finally {
      if (ulozeny !== undefined) process.env.SHOP_WEBHOOK_SECRET = ulozeny;
    }
  });

  test('chyby: 401 špatné tajemství a 503 bez WEBHOOK_SECRET jsou trvalé a neopakují se; 503 od proxy a 5xx přechodné', async () => {
    const spatne = falesnyFetch({ status: 401, json: { error: 'Unauthorized' } });
    const e401 = await eshop.fetchDaily({ ...vstup, fetchImpl: spatne.fetchImpl, sleep: bezSpanku }).catch(e => e);
    assert.equal(e401.permanent, true);
    assert.equal(e401.status, 401);
    assert.match(e401.message, /x-webhook-secret se neshoduje/);
    assert.equal(spatne.volani.length, 1);

    const bezSecretu = falesnyFetch({ status: 503, json: { error: 'Nedostupné' } });
    const e503 = await eshop.fetchDaily({ ...vstup, fetchImpl: bezSecretu.fetchImpl, sleep: bezSpanku }).catch(e => e);
    assert.equal(e503.permanent, true);
    assert.equal(e503.status, 503);
    assert.match(e503.message, /nemá nastavené WEBHOOK_SECRET/);
    assert.equal(bezSecretu.volani.length, 1);

    const proxy = falesnyFetch({ status: 503, text: '<html>Service Unavailable</html>' });
    const eProxy = await eshop.fetchDaily({ ...vstup, fetchImpl: proxy.fetchImpl, sleep: bezSpanku }).catch(e => e);
    assert.equal(eProxy.permanent, false);
    assert.equal(proxy.volani.length, 3);

    const chybi = falesnyFetch({ status: 404, text: 'Not found' });
    const e404 = await eshop.fetchDaily({ ...vstup, fetchImpl: chybi.fetchImpl, sleep: bezSpanku }).catch(e => e);
    assert.equal(e404.permanent, true);
    assert.match(e404.message, /nasaďte verzi e-shopu/);

    await overChybyFetch(eshop, vstup, (status) => ({ status, json: { error: 'x' } }), { trvale: [400, 403], prechodne: [429, 500, 502] });
  });

  test('overit: dni=1 a počty za dnešek, nikdy nevyhodí', async () => {
    const f = falesnyFetch({ json: fixture('eshop-statistika') });
    const v = await eshop.overit({ shop, tajemstvi: 'webhook-TAJNE', fetchImpl: f.fetchImpl, sleep: bezSpanku });
    assert.equal(v.ok, true);
    assert.equal(v.radku, 3);
    assert.match(v.zprava, /^E-shop odpovídá \(https:\/\/toneracek\.cz\/api\/marketing\/statistika\): dnes 41 hledání, 3 dotazů bez výsledku, 3 opuštěných košíků za 3.290 Kč$/);
    assert.equal(f.volani[0].url, 'https://toneracek.cz/api/marketing/statistika?dni=1');
    const n = await eshop.overit({ shop, tajemstvi: 'spatne', fetchImpl: falesnyFetch({ status: 401, json: { error: 'Unauthorized' } }).fetchImpl, sleep: bezSpanku });
    assert.equal(n.ok, false);
    assert.match(n.zprava, /neshoduje/);
    const pad = await eshop.overit({ shop: { slug: 'x', url: 'bez-url' }, tajemstvi: 't' });
    assert.equal(pad.ok, false);
    assert.match(pad.zprava, /nemá platnou URL/);
  });
});
