// Jednotkový test normalizace řádků statistik z adaptérů — běží bez databáze
// i serveru:
//
//   node --test test/marketing-normalizace.test.js
//
// Hlídá, že z libovolně rozházené odpovědi platformy (řetězce, haléřové
// zlomky, záporné opravy, data mimo okno, segment u denního součtu) vznikne
// řádek, který projde CHECK constrainty a UNIQUE indexem marketing_daily_stats,
// že každý řádek nese platformu (Sklik a Zboží téhož dne se nikdy nesečtou
// do jednoho) a že se nic podezřelého nezahodí potichu — ani při součtu
// kampaní před normalizací — ale vrátí se jako varování nebo důvod.
// Když je v repozitáři migrace 042, kontrolují se proti ní typy sloupců
// a číselníky; bez ní se ten test přeskočí.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESETINNE_METRIKY, MAX_DELKA_SEGMENTU, METRIKY, PLATFORMY, SEGMENT_KINDS,
  normalizujRadek, prazdneMetriky, sectiRadky, zaokrouhli2,
} from '../src/marketing/normalizace.js';
import { blokTabulky, hodnotyCheck, nactiMigraci042, sloupceTabulky } from './fixtures/marketing/migrace-042.js';

const OKNO = { from: '2026-10-01', to: '2026-10-14', platform: 'ga4' };
const TVAR_RADKU = ['platform', 'date', 'segment_kind', 'segment', ...METRIKY];

describe('číselníky', () => {
  test('platformy, druhy segmentů a metriky odpovídají plánu D1', () => {
    assert.deepEqual(PLATFORMY, ['ga4', 'google_ads', 'search_console', 'merchant', 'sklik', 'zbozi', 'heureka', 'meta', 'eshop']);
    assert.deepEqual(SEGMENT_KINDS, ['', 'campaign', 'channel', 'query', 'page', 'country', 'product']);
    assert.equal(METRIKY.length, 20);
    assert.ok(METRIKY.includes('cost') && METRIKY.includes('carts_value') && METRIKY.includes('position_sum'));
    for (const m of DESETINNE_METRIKY) assert.ok(METRIKY.includes(m), m);
  });

  test('metriky a číselníky sedí na migraci 042 (když už je v repozitáři)', (t) => {
    const migrace = nactiMigraci042();
    if (!migrace) { t.skip('migrations/042_marketing.sql tu ještě není — píše ji jiný krok'); return; }
    const blok = blokTabulky(migrace, 'marketing_daily_stats');
    assert.ok(blok, 'CREATE TABLE marketing_daily_stats v migraci');
    const sloupce = sloupceTabulky(blok);
    for (const m of METRIKY) {
      assert.ok(sloupce[m], `sloupec ${m} v migraci`);
      if (DESETINNE_METRIKY.includes(m)) {
        assert.match(sloupce[m], /^NUMERIC\(/, `${m} musí být NUMERIC — 2,5 konverze by jinak spadlo na INSERTu`);
      } else {
        assert.match(sloupce[m], /^(INTEGER|BIGINT)$/, `${m} je počet, čeká se celé číslo`);
      }
    }
    assert.deepEqual(hodnotyCheck(blok, 'platform'), PLATFORMY);
    assert.deepEqual(hodnotyCheck(blok, 'segment_kind'), SEGMENT_KINDS);
  });

  test('prázdné metriky jsou samé nuly pro všechny metriky', () => {
    const m = prazdneMetriky();
    assert.deepEqual(Object.keys(m), METRIKY);
    assert.ok(Object.values(m).every(v => v === 0));
  });

  test('zaokrouhlení na haléře zvládne 1.005', () => {
    assert.equal(zaokrouhli2(1.005), 1.01);
    assert.equal(zaokrouhli2(2635.5371), 2635.54);
    assert.equal(zaokrouhli2(0), 0);
  });
});

describe('normalizujRadek', () => {
  test('řetězce a chybějící metriky dají čísla; peníze na haléře, počty celé', () => {
    const { radek, varovani } = normalizujRadek({
      date: '2026-10-05', segment_kind: 'campaign', segment: '  Tonery CZ  ',
      cost: '123.456', cost_with_vat: ' 149.38 ', impressions: '1000.6', clicks: 12.4,
      conversions: '2.5', conversion_value: 999.999, position_sum: '12.345',
    }, OKNO);
    assert.deepEqual(varovani, []);
    assert.equal(radek.platform, 'ga4');
    assert.equal(radek.date, '2026-10-05');
    assert.equal(radek.segment_kind, 'campaign');
    assert.equal(radek.segment, 'Tonery CZ');
    assert.equal(radek.cost, 123.46);
    assert.equal(radek.cost_with_vat, 149.38);
    assert.equal(radek.impressions, 1001);
    assert.equal(radek.clicks, 12);
    assert.equal(radek.conversions, 2.5);          // Google Ads hlásí zlomky konverzí
    assert.equal(radek.conversion_value, 1000);
    assert.equal(radek.position_sum, 12.35);
    for (const m of ['sessions', 'purchase', 'carts_value', 'approved_items']) assert.equal(radek[m], 0, m);
    assert.deepEqual(Object.keys(radek), TVAR_RADKU);
  });

  test('platforma: z řádku, jinak z voleb; řádek bez ní nebo s neznámou se zahodí s důvodem', () => {
    // řádek má přednost — adaptér Skliku posílá sklik i zbozi v jedné dávce
    assert.equal(normalizujRadek({ date: '2026-10-05', platform: 'zbozi' }, { ...OKNO, platform: 'sklik' }).radek.platform, 'zbozi');
    assert.equal(normalizujRadek({ date: '2026-10-05', platform: ' sklik ' }, OKNO).radek.platform, 'sklik');
    assert.equal(normalizujRadek({ date: '2026-10-05', platform: '' }, OKNO).radek.platform, 'ga4');
    assert.equal(normalizujRadek({ date: '2026-10-05', platform: null }, OKNO).radek.platform, 'ga4');
    assert.deepEqual(normalizujRadek({ date: '2026-10-05', platform: 'adwords' }, OKNO), { radek: null, duvod: 'neznámá platforma "adwords"' });
    assert.deepEqual(normalizujRadek({ date: '2026-10-05' }, { from: OKNO.from, to: OKNO.to }), { radek: null, duvod: 'chybí platforma' });
    assert.deepEqual(normalizujRadek({ date: '2026-10-05' }, { ...OKNO, platform: 'yahoo' }), { radek: null, duvod: 'neznámá platforma "yahoo"' });
  });

  test('cizí klíče vstupu se nepřenášejí, platforma ano', () => {
    const { radek } = normalizujRadek({ date: '2026-10-05', platform: 'ga4', run_id: 5, ctr: 0.1 }, OKNO);
    assert.equal(radek.platform, 'ga4');
    assert.equal('run_id' in radek, false);
    assert.equal('ctr' in radek, false);
  });

  test('datum může přijít jako Date, ISO s časem i YYYYMMDD z GA4', () => {
    assert.equal(normalizujRadek({ date: new Date('2026-10-05T00:00:00Z') }, OKNO).radek.date, '2026-10-05');
    assert.equal(normalizujRadek({ date: '2026-10-14T10:00:00' }, OKNO).radek.date, '2026-10-14');
    assert.equal(normalizujRadek({ date: '20261005' }, OKNO).radek.date, '2026-10-05');
    assert.equal(normalizujRadek({ date: '20261332' }, OKNO).radek, null);
  });

  test('neplatné datum nebo datum mimo okno řádek zahodí s důvodem', () => {
    assert.deepEqual(normalizujRadek({ date: '2026-02-30', clicks: 1 }, OKNO), { radek: null, duvod: 'neplatné datum "2026-02-30"' });
    assert.deepEqual(normalizujRadek({ clicks: 1 }, OKNO), { radek: null, duvod: 'neplatné datum null' });
    assert.deepEqual(normalizujRadek({ date: '2026-09-30' }, OKNO), { radek: null, duvod: 'datum 2026-09-30 je mimo okno 2026-10-01 – 2026-10-14' });
    assert.equal(normalizujRadek({ date: '2026-10-15' }, OKNO).radek, null);
    // Kraje okna patří dovnitř.
    assert.ok(normalizujRadek({ date: '2026-10-01' }, OKNO).radek);
    assert.ok(normalizujRadek({ date: '2026-10-14' }, OKNO).radek);
  });

  test('neznámý druh segmentu řádek zahodí, chybějící je denní součet', () => {
    assert.deepEqual(normalizujRadek({ date: '2026-10-05', segment_kind: 'device' }, OKNO),
      { radek: null, duvod: 'neznámý druh segmentu "device"' });
    assert.equal(normalizujRadek({ date: '2026-10-05' }, OKNO).radek.segment_kind, '');
    assert.equal(normalizujRadek({ date: '2026-10-05', segment_kind: null }, OKNO).radek.segment_kind, '');
  });

  test('varování u rozpadu jmenuje i segment', () => {
    const { varovani } = normalizujRadek({ date: '2026-10-05', segment_kind: 'campaign', segment: 'Tonery', cost: -1 }, OKNO);
    assert.deepEqual(varovani, ['cost 2026-10-05 (Tonery): záporná hodnota -1 nahrazena nulou']);
  });

  test('záporná hodnota se nahradí nulou a ohlásí', () => {
    const { radek, varovani } = normalizujRadek({ date: '2026-10-05', cost: -12.5, clicks: -1, impressions: 10 }, OKNO);
    assert.equal(radek.cost, 0);
    assert.equal(radek.clicks, 0);
    assert.equal(radek.impressions, 10);
    assert.equal(varovani.length, 2);
    assert.match(varovani[0], /^cost 2026-10-05: záporná hodnota -12\.5 nahrazena nulou$/);
    assert.match(varovani[1], /^clicks 2026-10-05: záporná hodnota -1 nahrazena nulou$/);
  });

  test('chybějící hodnota (null, undefined, prázdný řetězec) je nula bez varování', () => {
    const { radek, varovani } = normalizujRadek({ date: '2026-10-05', sessions: null, carts_value: undefined, cost: '' }, OKNO);
    for (const m of ['cost', 'sessions', 'carts_value']) assert.equal(radek[m], 0, m);
    assert.deepEqual(varovani, []);
  });

  test('nečíselná hodnota (text, čárka, NaN, Infinity, objekt) je nula s varováním — chyba adaptéru má být vidět', () => {
    const { radek, varovani } = normalizujRadek(
      { date: '2026-10-05', cost: NaN, clicks: Infinity, purchase: 'n/a', cost_with_vat: '149,38', sessions: { a: 1 } }, OKNO,
    );
    for (const m of ['cost', 'clicks', 'purchase', 'cost_with_vat', 'sessions']) assert.equal(radek[m], 0, m);
    assert.equal(varovani.length, 5);
    assert.ok(varovani.includes('cost 2026-10-05: nečíselná hodnota NaN nahrazena nulou'), varovani.join('; '));
    assert.ok(varovani.includes('clicks 2026-10-05: nečíselná hodnota Infinity nahrazena nulou'));
    assert.ok(varovani.includes('purchase 2026-10-05: nečíselná hodnota "n/a" nahrazena nulou'));
    assert.ok(varovani.includes('cost_with_vat 2026-10-05: nečíselná hodnota "149,38" nahrazena nulou'));
    assert.ok(varovani.includes('sessions 2026-10-05: nečíselná hodnota {"a":1} nahrazena nulou'));
  });

  test('segment se ořeže, zbaví řídicích znaků a zkrátí na 300 znaků s varováním', () => {
    const dlouhy = 'x'.repeat(MAX_DELKA_SEGMENTU + 20);
    const { radek, varovani } = normalizujRadek({ date: '2026-10-05', segment_kind: 'query', segment: `${dlouhy}` }, OKNO);
    assert.equal(radek.segment.length, MAX_DELKA_SEGMENTU);
    assert.equal(varovani.length, 1);
    assert.match(varovani[0], /zkrácen na 300 znaků/);

    const s = normalizujRadek({ date: '2026-10-05', segment_kind: 'page', segment: '/a\u0000b\n\tc ' }, OKNO);
    assert.equal(s.radek.segment, '/a b c');
    assert.equal(s.radek.segment.includes('\u0000'), false);
  });

  test('denní součet nenese segment — kdyby přišel, zahodí se s varováním', () => {
    const { radek, varovani } = normalizujRadek({ date: '2026-10-05', segment_kind: '', segment: 'Kampaň' }, OKNO);
    assert.equal(radek.segment, '');
    assert.deepEqual(varovani, ['denní součet nenese segment, „Kampaň“ zahozen']);
  });
});

describe('sectiRadky', () => {
  test('sečte metriky podle (platforma, datum, druh, segment), drží pořadí prvního výskytu a nečíselné hlásí', () => {
    const { radky, varovani } = sectiRadky([
      { platform: 'sklik', date: '2026-10-05', segment_kind: 'campaign', segment: 'A', cost: 10.004, clicks: 1 },
      { platform: 'sklik', date: '2026-10-05', segment_kind: 'campaign', segment: 'B', cost: 5, clicks: 2 },
      { platform: 'sklik', date: '2026-10-05', segment_kind: 'campaign', segment: 'A', cost: '2.003', clicks: '3', conversions: 0.5, sessions: 'x' },
      { platform: 'sklik', date: '2026-10-06', segment_kind: 'campaign', segment: 'A', cost: 1 },
    ]);
    assert.equal(radky.length, 3);
    assert.deepEqual(radky.map(r => `${r.platform}|${r.date}|${r.segment}`), ['sklik|2026-10-05|A', 'sklik|2026-10-05|B', 'sklik|2026-10-06|A']);
    assert.equal(radky[0].cost, 12.01);
    assert.equal(radky[0].clicks, 4);
    assert.equal(radky[0].conversions, 0.5);
    assert.equal(radky[0].sessions, 0);
    assert.equal(radky[1].cost, 5);
    assert.equal(radky[2].cost, 1);
    assert.deepEqual(Object.keys(radky[0]), TVAR_RADKU);
    // „x“ v sessions se nesmí ztratit v nule potichu — tohle je jediné místo, kde ji ještě někdo vidí
    assert.deepEqual(varovani, ['sessions 2026-10-05 (A): nečíselná hodnota "x" nahrazena nulou']);
  });

  test('Sklik a Zboží téhož dne zůstanou dva řádky — platforma je součást klíče', () => {
    const { radky, varovani } = sectiRadky([
      { platform: 'sklik', date: '2026-10-05', cost: 100, clicks: 10 },
      { platform: 'zbozi', date: '2026-10-05', cost: 40, clicks: 4 },
      { platform: 'sklik', date: '2026-10-05', cost: 20, clicks: 2 },
    ]);
    assert.deepEqual(varovani, []);
    assert.deepEqual(radky.map(r => [r.platform, r.date, r.cost, r.clicks]), [['sklik', '2026-10-05', 120, 12], ['zbozi', '2026-10-05', 40, 4]]);
    // a projdou normalizací každý se svou platformou, i když volby říkají sklik
    const okno = { from: '2026-10-01', to: '2026-10-14', platform: 'sklik' };
    assert.deepEqual(radky.map(r => normalizujRadek(r, okno).radek.platform), ['sklik', 'zbozi']);
  });

  test('formátovaná částka z Heureky („1 234,50“) se neztratí v nule potichu', () => {
    const { radky, varovani } = sectiRadky([
      { platform: 'heureka', date: '2026-10-05', segment_kind: 'product', segment: 'T1', cost: '1 234,50' },
      { platform: 'heureka', date: '2026-10-05', segment_kind: 'product', segment: 'T2', cost: 10 },
    ]);
    assert.equal(radky[0].cost, 0);
    assert.equal(radky[1].cost, 10);
    assert.deepEqual(varovani, ['cost 2026-10-05 (T1): nečíselná hodnota "1 234,50" nahrazena nulou']);
  });

  test('chybějící druh, segment i platforma znamenají denní součet bez platformy; segment „A“ a „“ jsou různé klíče', () => {
    const { radky } = sectiRadky([
      { date: '2026-10-05', cost: 1 },
      { date: '2026-10-05', platform: '', segment_kind: '', segment: '', cost: 2 },
      { date: '2026-10-05', segment_kind: 'campaign', segment: 'A', cost: 4 },
    ]);
    assert.equal(radky.length, 2);
    assert.equal(radky[0].cost, 3);
    assert.equal(radky[0].platform, '');
    assert.equal(radky[0].segment_kind, '');
    assert.equal(radky[1].cost, 4);
    // platformu doplní až normalizace z voleb
    assert.equal(normalizujRadek(radky[0], OKNO).radek.platform, 'ga4');
  });

  test('prázdný vstup dá prázdné pole bez varování', () => {
    assert.deepEqual(sectiRadky([]), { radky: [], varovani: [] });
    assert.deepEqual(sectiRadky(undefined), { radky: [], varovani: [] });
  });
});
