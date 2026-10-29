// Jednotkový test KPI marketingového přehledu — běží bez databáze i serveru:
//
//   node --test test/marketing-kpi.test.js
//
// Hlídá definice z hlavičky kpi.js: pořadí pravidel kanálu (click-id před
// placeným médiem před UTM před referrerem; placený zdroj ve tvaru hostu je
// platforma, ne „placené ostatní“), že objednávka bez atribuce je „neznámý“
// a ne „direct“, marži ze známé i odhadnuté nákupní ceny bez pseudo-položek,
// rozpočítání ručního nákladu po dnech na překryv s obdobím a hlášení
// překryvu s náklady z API, dělení nulou → null, prahy porovnání ±10/25 %
// a nulové doplnění grafu i pro neplatné období. SQL pomocníci jedou proti
// falešné databázi, která dotaz jen složí a vrátí připravené řádky —
// kontroluje se, že se ptají na sloupce z migrace 042 (proti souboru
// migrace, když už je v repozitáři) a filtrují pražský den; skutečné SQL tu
// neběží. Kopie pravidel z expedice.js (zaplaceno, pseudo-položky) se
// porovnávají s jeho zdrojovým textem, aby se obě místa nerozešla.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KANALY, KANALY_PLACENE, KANAL_POPIS, ODCHYLKA_OK_PCT, ODCHYLKA_VAROVANI_PCT, PSEUDO_SKU, SAZBA_DPH,
  STAVY_MIMO_TRZBY, bezDph, dnyNakladuPlatforem, eshopStatistiky, funnelGa4, jePseudoPolozka, kanalObjednavky,
  kanalPrvnihoDotyku, kanalZeSegmentuGa4, kanalZeZdrojeAMedia, kanalyGa4, marzeObjednavek, nakladyPlatforem,
  nakladyPoDnech, objednavkyZaObdobi, organikaSearchConsole, platformniKonverze, podminkaZaplaceno,
  polozkyObjednavek, porovnej, prekryvRucnichNakladu, radyProGraf, rozdelPodleKanalu, rozpoctiManualniNaklad,
  rozpoctiManualniNakladPoDnech, rucniNaklady, seskupKanalyGa4, spoctiKpi, stavMerchantu, trzbyPoDnech,
} from '../src/marketing/kpi.js';
import { blokTabulky, nactiMigraci042, pridaneSloupce, sloupceTabulky } from './fixtures/marketing/migrace-042.js';

/** Zdrojový text expedice.js s bílými znaky sraženými na mezeru — pro kontrolu, že se místní kopie pravidel nerozešly. */
const EXPEDICE_ZDROJ = readFileSync(new URL('../src/expedice.js', import.meta.url), 'utf8').replace(/\s+/g, ' ');

describe('DPH a číselníky', () => {
  test('tržby bez DPH: 3 189 Kč s DPH → 2 635,54 (ruční přepočet z plánu)', () => {
    assert.equal(SAZBA_DPH, 21);
    assert.equal(bezDph(3189), 2635.54);
    assert.equal(bezDph(1210), 1000);
    assert.equal(bezDph('121'), 100);   // NUMERIC z DB jako řetězec
    assert.equal(bezDph(null), 0);
  });

  test('kanály mají popisky a placené jsou podmnožina', () => {
    assert.equal(KANALY.length, 12);
    for (const k of KANALY) assert.equal(typeof KANAL_POPIS[k], 'string', k);
    for (const k of KANALY_PLACENE) assert.ok(KANALY.includes(k), k);
    assert.deepEqual(STAVY_MIMO_TRZBY, ['Stornována', 'Platba se nezdařila']);
  });

  test('pseudo-položky: místní kopie seznamu se shoduje s expedice.js (sjednotit s expedice.js)', () => {
    assert.deepEqual(PSEUDO_SKU, ['SLEVA-REG', 'DOPRAVA', 'DOBIRKA']);
    assert.equal(jePseudoPolozka(' doprava '), true);
    assert.equal(jePseudoPolozka('T03065'), false);
    assert.equal(jePseudoPolozka(null), false);
    assert.ok(EXPEDICE_ZDROJ.includes("PSEUDO_SKU = ['SLEVA-REG', 'DOPRAVA', 'DOBIRKA']"),
      'PSEUDO_SKU se v expedice.js změnil nebo přestěhoval — sjednotit kopii v kpi.js');
  });
});

describe('kanalZeZdrojeAMedia — pořadí pravidel', () => {
  const pripady = [
    // click-id vyhrává nad vším
    [['seznam', 'cpc', 'www.seznam.cz', 'gclid'], 'google_ads'],
    [['', '', '', 'gbraid'], 'google_ads'],
    [['', '', '', 'wbraid'], 'google_ads'],
    [['', '', '', 'FBCLID'], 'meta'],
    [['google', 'cpc', '', 'sznclid'], 'sklik'],
    [['', '', '', 'sznaiid'], 'sklik'],
    [['', '', '', 'hgtid'], 'heureka'],
    [['', '', '', 'aku'], 'heureka'],
    [['google', 'cpc', '', 'neznamy-druh'], 'google_ads'],   // neznámý druh se ignoruje
    // placené médium + zdroj
    [['google', 'cpc'], 'google_ads'],
    [[' Google ', 'CPC'], 'google_ads'],
    [['google', 'display'], 'google_ads'],
    [['seznam', 'cpc'], 'sklik'],
    [['sklik', 'ppc'], 'sklik'],
    [['facebook', 'paid'], 'meta'],
    [['instagram', 'cpm'], 'meta'],
    [['meta', 'paidsocial'], 'meta'],
    [['facebook', 'paid_social'], 'meta'],
    [['heureka.cz', 'cpc'], 'heureka'],
    [['heureka', 'cpc'], 'heureka'],
    [['zbozi.cz', 'cpc'], 'zbozi'],
    [['zbozi', 'cpc'], 'zbozi'],
    [['bing', 'cpc'], 'placene_jine'],
    // zdroj ve tvaru hostu (kopírovaná šablona sledování) je tatáž platforma
    [['www.google.com', 'cpc'], 'google_ads'],
    [['google.cz', 'cpc'], 'google_ads'],
    [['seznam.cz', 'cpc'], 'sklik'],
    [['search.seznam.cz', 'ppc'], 'sklik'],
    [['facebook.com', 'paid'], 'meta'],
    [['l.facebook.com', 'cpc'], 'meta'],
    [['www.heureka.cz', 'cpc'], 'heureka'],
    [['bing.com', 'cpc'], 'placene_jine'],
    [['idnes.cz', 'cpc'], 'placene_jine'],
    // zdroj heureka / zbozi s jakýmkoli médiem
    [['heureka.cz', 'referral'], 'heureka'],
    [['Heureka', 'organic'], 'heureka'],
    [['zbozi.cz', '(not set)'], 'zbozi'],
    // médium
    [['newsletter', 'email'], 'email'],
    [['ecomail', 'newsletter'], 'email'],
    [['seznam', 'e-mail'], 'email'],
    [['google', 'organic'], 'organic'],
    [['seznam', 'organic'], 'organic'],
    [['facebook', 'social'], 'social'],
    [['instagram', 'social-media'], 'social'],
    // host referreru
    [['', '', 'www.google.cz'], 'organic'],
    [['', '', 'google.com'], 'organic'],
    [['', '', 'www.google.co.uk'], 'organic'],
    [['', '', 'search.seznam.cz'], 'organic'],
    [['', '', 'seznam.cz'], 'organic'],
    [['', '', 'www.bing.com'], 'organic'],
    [['', '', 'duckduckgo.com'], 'organic'],
    [['', '', 'www.ecosia.org'], 'organic'],
    [['', '', 'www.heureka.cz'], 'heureka'],
    [['', '', 'obchody.heureka.sk'], 'heureka'],
    [['', '', 'www.zbozi.cz'], 'zbozi'],
    [['', '', 'l.facebook.com'], 'social'],
    [['', '', 'www.instagram.com'], 'social'],
    [['', '', 'fb.me'], 'social'],
    [['', '', 'www.idnes.cz'], 'referral'],
    [['', '', 'googleadservices.com'], 'referral'],   // není google.*
    [['', '', ''], 'direct'],
    [['(direct)', '(none)', ''], 'direct'],
    [[undefined, null, undefined], 'direct'],
    // GA4 „zdroj / médium“: zdroj ve tvaru hostu projde pravidly hostu
    [['l.facebook.com', 'referral'], 'social'],
    [['idnes.cz', 'referral'], 'referral'],
    [['seznam', 'referral'], 'referral'],
    [['google', '(not set)'], 'direct'],
    // referrer má přednost před zdrojem-hostem, médium organic před hostem
    [['idnes.cz', 'referral', 'www.google.cz'], 'organic'],
    [['google', 'organic', 'www.idnes.cz'], 'organic'],
  ];

  for (const [vstup, ocekavany] of pripady) {
    test(`${JSON.stringify(vstup)} → ${ocekavany}`, () => {
      assert.equal(kanalZeZdrojeAMedia(...vstup), ocekavany);
    });
  }
});

describe('kanál objednávky', () => {
  test('bez touch_last_at je kanál neznámý, i kdyby UTM sloupce něco nesly', () => {
    assert.equal(kanalObjednavky({ utm_source_last: 'google', utm_medium_last: 'cpc', touch_last_at: null }), 'neznamy');
    assert.equal(kanalObjednavky({ utm_source_last: 'google', utm_medium_last: 'cpc' }), 'neznamy');
    assert.equal(kanalObjednavky({}), 'neznamy');
    assert.equal(kanalObjednavky(null), 'neznamy');
  });

  test('s dotykem se bere poslední dotyk; první jen informativně', () => {
    const o = {
      touch_first_at: new Date('2026-10-01T10:00:00Z'), utm_source_first: 'google', utm_medium_first: 'organic', referrer_host_first: 'www.google.cz', click_id_kind_first: '',
      touch_last_at: new Date('2026-10-05T10:00:00Z'), utm_source_last: 'seznam', utm_medium_last: 'cpc', referrer_host_last: '', click_id_kind_last: 'sznclid',
    };
    assert.equal(kanalObjednavky(o), 'sklik');
    assert.equal(kanalPrvnihoDotyku(o), 'organic');
    assert.equal(kanalPrvnihoDotyku({ ...o, touch_first_at: null }), 'neznamy');
    // dotyk bez zdroje i referreru = přímý přístup
    assert.equal(kanalObjednavky({ touch_last_at: '2026-10-05T10:00:00Z', utm_source_last: '', utm_medium_last: '', referrer_host_last: '', click_id_kind_last: '' }), 'direct');
  });

  test('rozdělení podle kanálů: počty, tržby bez DPH, pokrytí atribuce, všechny kanály v mapě', () => {
    const r = rozdelPodleKanalu([
      { total_price: 1210, touch_last_at: '2026-10-05T10:00:00Z', utm_source_last: 'google', utm_medium_last: 'cpc' },
      { total_price: '605', touch_last_at: null },
      { total_price: 2420, touch_last_at: '2026-10-06T10:00:00Z', click_id_kind_last: 'hgtid' },
      { total_price: 1210, touch_last_at: '2026-10-06T10:00:00Z', utm_source_last: 'google', utm_medium_last: 'cpc' },
    ]);
    assert.deepEqual(Object.keys(r.kanaly), KANALY);
    assert.deepEqual(r.kanaly.google_ads, { pocet: 2, trzbyBezDph: 2000 });
    assert.deepEqual(r.kanaly.neznamy, { pocet: 1, trzbyBezDph: 500 });
    assert.deepEqual(r.kanaly.heureka, { pocet: 1, trzbyBezDph: 2000 });
    assert.deepEqual(r.kanaly.direct, { pocet: 0, trzbyBezDph: 0 });
    assert.equal(r.pokrytiAtribuce, 0.75);
  });

  test('bez objednávek je pokrytí 0 a mapa nulová', () => {
    const r = rozdelPodleKanalu([]);
    assert.equal(r.pokrytiAtribuce, 0);
    assert.ok(KANALY.every(k => r.kanaly[k].pocet === 0));
  });
});

describe('marzeObjednavek', () => {
  test('známá nákupní cena bez DPH: (cena/1,21 − nákupní) × ks', () => {
    const r = marzeObjednavek([{ sku: 'T03065', price: 1210, quantity: 2, cost_price: 600, cost_price_vat_included: false }], 33);
    assert.deepEqual(r, { marze: 800, zname: 800, odhadnute: 0, bezMarze: 0, podilOdhadu: 0, trzbyZbozi: 2000 });
  });

  test('nákupní cena s DPH se nejdřív dělí 1,21', () => {
    const r = marzeObjednavek([{ sku: 'T03065', price: 1210, quantity: 2, cost_price: 726, cost_price_vat_included: true }], 0);
    assert.equal(r.zname, 800);
    assert.equal(r.marze, 800);
  });

  test('bez nákupní ceny odhad podle marže e-shopu; podíl odhadu z tržeb', () => {
    const jen = marzeObjednavek([{ sku: 'T03065', price: 1210, quantity: 2, cost_price: null, cost_price_vat_included: null }], 33);
    assert.deepEqual(jen, { marze: 660, zname: 0, odhadnute: 660, bezMarze: 0, podilOdhadu: 1, trzbyZbozi: 2000 });

    const mix = marzeObjednavek([
      { sku: 'T03065', price: 1210, quantity: 1, cost_price: '600', cost_price_vat_included: false },   // známá, tržba 1000
      { sku: 'C05142', price: 605, quantity: 2, cost_price: null, cost_price_vat_included: null },      // odhad, tržba 1000
    ], 33);
    assert.equal(mix.zname, 400);
    assert.equal(mix.odhadnute, 330);
    assert.equal(mix.marze, 730);
    assert.equal(mix.podilOdhadu, 0.5);
    assert.equal(mix.trzbyZbozi, 2000);
  });

  test('bez nákupní ceny a bez marže e-shopu jde tržba do koše bezMarze', () => {
    const r = marzeObjednavek([{ sku: 'T03065', price: 1210, quantity: 1, cost_price: null }], 0);
    assert.deepEqual(r, { marze: 0, zname: 0, odhadnute: 0, bezMarze: 1000, podilOdhadu: 0, trzbyZbozi: 1000 });
    assert.equal(marzeObjednavek([{ sku: 'T03065', price: 1210, quantity: 1 }], null).bezMarze, 1000);
    assert.equal(marzeObjednavek([{ sku: 'T03065', price: 1210, quantity: 1 }], 'nic').bezMarze, 1000);
  });

  test('pseudo-položky (doprava, dobírka, sleva) se do marže nepočítají', () => {
    const r = marzeObjednavek([
      { sku: 'DOPRAVA', price: 99, quantity: 1, cost_price: null },
      { sku: 'dobirka', price: 39, quantity: 1, cost_price: 0 },
      { sku: 'SLEVA-REG', price: -50, quantity: 1, cost_price: null },
      { sku: 'T03065', price: 1210, quantity: 1, cost_price: 600 },
    ], 33);
    assert.deepEqual(r, { marze: 400, zname: 400, odhadnute: 0, bezMarze: 0, podilOdhadu: 0, trzbyZbozi: 1000 });
  });

  test('záporná marže zůstane záporná, nulové množství nic nepřidá, prázdný vstup je nula', () => {
    assert.equal(marzeObjednavek([{ sku: 'T1', price: 1210, quantity: 1, cost_price: 1500 }], 0).marze, -500);
    assert.equal(marzeObjednavek([{ sku: 'T1', price: 1210, quantity: 0, cost_price: 600 }], 33).marze, 0);
    assert.deepEqual(marzeObjednavek([], 33), { marze: 0, zname: 0, odhadnute: 0, bezMarze: 0, podilOdhadu: 0, trzbyZbozi: 0 });
    assert.equal(marzeObjednavek(undefined, 33).marze, 0);
  });

  test('zaokrouhluje se až součet, ne každá položka', () => {
    // 3× položka 100 Kč s DPH, bez nákupní ceny, marže 33 %: 82,6446… × 0,33 × 3 = 81,82
    const r = marzeObjednavek([{ sku: 'T1', price: 100, quantity: 3, cost_price: null }], 33);
    assert.equal(r.odhadnute, 81.82);
    assert.equal(r.trzbyZbozi, 247.93);
  });
});

describe('rozpočítání ručního nákladu', () => {
  const rijen = { date_from: '2026-10-01', date_to: '2026-10-31', amount: 3100 };

  test('celé období nákladu uvnitř okna → celá částka', () => {
    assert.equal(rozpoctiManualniNaklad(rijen, '2026-10-01', '2026-10-31'), 3100);
    assert.equal(rozpoctiManualniNaklad(rijen, '2026-09-20', '2026-11-10'), 3100);
  });

  test('částečný překryv na začátku, na konci a okno uvnitř nákladu', () => {
    assert.equal(rozpoctiManualniNaklad(rijen, '2026-10-01', '2026-10-10'), 1000);
    assert.equal(rozpoctiManualniNaklad(rijen, '2026-10-25', '2026-11-05'), 700);
    assert.equal(rozpoctiManualniNaklad(rijen, '2026-10-10', '2026-10-12'), 300);
  });

  test('bez překryvu nula; jednodenní náklad celý v den, kdy platí', () => {
    assert.equal(rozpoctiManualniNaklad(rijen, '2026-09-01', '2026-09-30'), 0);
    assert.equal(rozpoctiManualniNaklad(rijen, '2026-11-01', '2026-11-30'), 0);
    const den = { date_from: '2026-10-05', date_to: '2026-10-05', amount: 50 };
    assert.equal(rozpoctiManualniNaklad(den, '2026-10-01', '2026-10-31'), 50);
    assert.equal(rozpoctiManualniNaklad(den, '2026-10-06', '2026-10-31'), 0);
  });

  test('datum z DB jako Date (půlnoc UTC) i částka jako řetězec; nesmyslný náklad je nula', () => {
    const z = { date_from: new Date('2026-10-01T00:00:00Z'), date_to: new Date('2026-10-31T00:00:00Z'), amount: '3100' };
    assert.equal(rozpoctiManualniNaklad(z, '2026-10-01', '2026-10-10'), 1000);
    assert.equal(rozpoctiManualniNaklad({ date_from: '2026-10-10', date_to: '2026-10-01', amount: 100 }, '2026-10-01', '2026-10-31'), 0);
    assert.equal(rozpoctiManualniNaklad({ date_from: '2026-10-01', date_to: '2026-10-31', amount: 'x' }, '2026-10-01', '2026-10-31'), 0);
    assert.equal(rozpoctiManualniNaklad({ date_from: null, date_to: '2026-10-31', amount: 100 }, '2026-10-01', '2026-10-31'), 0);
  });

  test('neceločíselný podíl se zaokrouhlí na haléře', () => {
    assert.equal(rozpoctiManualniNaklad({ date_from: '2026-10-01', date_to: '2026-10-03', amount: 1000 }, '2026-10-01', '2026-10-01'), 333.33);
    assert.equal(rozpoctiManualniNaklad({ date_from: '2026-10-01', date_to: '2026-10-03', amount: 1000 }, '2026-10-02', '2026-10-03'), 666.67);
  });

  test('po dnech: jen dny překryvu, každý den stejný díl', () => {
    const n = { date_from: '2026-10-01', date_to: '2026-10-03', amount: 300 };
    assert.deepEqual(rozpoctiManualniNakladPoDnech(n, '2026-10-01', '2026-10-31'), { '2026-10-01': 100, '2026-10-02': 100, '2026-10-03': 100 });
    assert.deepEqual(rozpoctiManualniNakladPoDnech(n, '2026-10-03', '2026-10-31'), { '2026-10-03': 100 });
    assert.deepEqual(rozpoctiManualniNakladPoDnech(n, '2026-11-01', '2026-11-30'), {});
  });

  test('překryv s API: jen platformy a dny, kde je ruční i API náklad, v mezích období', () => {
    const rucni = [
      { id: 1, platform: 'sklik', date_from: '2026-10-01', date_to: '2026-10-10', amount: 1000 },
      { id: 2, platform: 'sklik', date_from: '2026-10-09', date_to: '2026-10-12', amount: 400 },
      { id: 3, platform: 'heureka', date_from: '2026-10-01', date_to: '2026-10-31', amount: 3100 },
      { id: 4, platform: 'ostatni', date_from: '2026-10-01', date_to: '2026-10-31', amount: 500 },
      { id: 5, platform: 'google_ads', date_from: '2026-09-01', date_to: '2026-09-30', amount: 900 },
    ];
    const api = [
      { platform: 'sklik', den: '2026-10-08' }, { platform: 'sklik', den: '2026-10-09' }, { platform: 'sklik', den: '2026-10-20' },
      { platform: 'google_ads', den: '2026-09-15' }, { platform: 'google_ads', den: '2026-10-05' },
      { platform: 'ga4', den: '2026-10-05' },
    ];
    assert.deepEqual(prekryvRucnichNakladu(rucni, api, '2026-10-01', '2026-10-31'), [
      { platform: 'sklik', dny: ['2026-10-08', '2026-10-09'], idNakladu: [1, 2] },
    ]);
    // období ořeže i překryv: od 9. 10. zbývá z obou nákladů jen 9. 10.
    assert.deepEqual(prekryvRucnichNakladu(rucni, api, '2026-10-09', '2026-10-31'), [
      { platform: 'sklik', dny: ['2026-10-09'], idNakladu: [1, 2] },
    ]);
    assert.deepEqual(prekryvRucnichNakladu(rucni, api, '2026-10-10', '2026-10-31'), []);
    // den z DB jako Date, platformy abecedně
    assert.deepEqual(prekryvRucnichNakladu(
      [{ id: 9, platform: 'meta', date_from: '2026-10-05', date_to: '2026-10-05', amount: 10 }, ...rucni],
      [{ platform: 'meta', den: new Date('2026-10-05T00:00:00Z') }, ...api], '2026-10-01', '2026-10-31',
    ).map(p => p.platform), ['meta', 'sklik']);
    assert.deepEqual(prekryvRucnichNakladu([], api, '2026-10-01', '2026-10-31'), []);
    assert.deepEqual(prekryvRucnichNakladu(rucni, [], '2026-10-01', '2026-10-31'), []);
    assert.deepEqual(prekryvRucnichNakladu(undefined, undefined, '2026-10-01', '2026-10-31'), []);
  });
});

describe('spoctiKpi', () => {
  test('běžný měsíc: PNO 25 %, ROAS 4, CPA 250, průměrná 1 000, zisk 800, ROI 32 %', () => {
    assert.deepEqual(spoctiKpi({ trzbyBezDph: 10000, pocetObjednavek: 10, naklady: 2500, marze: 3300 }),
      { pno: 25, roas: 4, cpa: 250, prumerna: 1000, zisk: 800, roi: 32 });
  });

  test('dělení nulou dává null, ne Infinity ani NaN', () => {
    assert.deepEqual(spoctiKpi({ trzbyBezDph: 0, pocetObjednavek: 0, naklady: 0 }),
      { pno: null, roas: null, cpa: null, prumerna: null, zisk: null, roi: null });
    // tržby bez nákladů: PNO 0 %, ROAS nejde, CPA je 0 Kč (dělí se počtem, ne náklady), zisk = marže, ROI nejde
    assert.deepEqual(spoctiKpi({ trzbyBezDph: 5000, pocetObjednavek: 4, naklady: 0, marze: 1500 }),
      { pno: 0, roas: null, cpa: 0, prumerna: 1250, zisk: 1500, roi: null });
    // náklady bez tržeb: PNO nejde, ROAS 0
    assert.deepEqual(spoctiKpi({ trzbyBezDph: 0, pocetObjednavek: 0, naklady: 800, marze: 0 }),
      { pno: null, roas: 0, cpa: null, prumerna: null, zisk: -800, roi: -100 });
  });

  test('bez marže není zisk ani ROI; čísla mohou přijít jako řetězce', () => {
    const r = spoctiKpi({ trzbyBezDph: '1000', pocetObjednavek: '2', naklady: '300' });
    assert.deepEqual(r, { pno: 30, roas: 3.33, cpa: 150, prumerna: 500, zisk: null, roi: null });
    assert.equal(spoctiKpi({ trzbyBezDph: 1000, pocetObjednavek: 1, naklady: 300, marze: '' }).zisk, null);
  });
});

describe('porovnej', () => {
  test('±10 % ok, ±25 % varování, dál chyba; rozdíl v procentech od hodnoty Seilu', () => {
    assert.deepEqual(porovnej(100, 105), { rozdilPct: 5, stav: 'ok' });
    assert.deepEqual(porovnej(100, 90), { rozdilPct: -10, stav: 'ok' });
    assert.deepEqual(porovnej(100, 110.1), { rozdilPct: 10.1, stav: 'varovani' });
    assert.deepEqual(porovnej(100, 125), { rozdilPct: 25, stav: 'varovani' });
    assert.deepEqual(porovnej(100, 75), { rozdilPct: -25, stav: 'varovani' });
    assert.deepEqual(porovnej(100, 125.1), { rozdilPct: 25.1, stav: 'chyba' });
    assert.deepEqual(porovnej(100, 60), { rozdilPct: -40, stav: 'chyba' });
    assert.deepEqual(porovnej(2635.54, 2700), { rozdilPct: 2.4, stav: 'ok' });
  });

  test('nuly: obě ok, jen jedna chyba', () => {
    assert.deepEqual(porovnej(0, 0), { rozdilPct: 0, stav: 'ok' });
    assert.deepEqual(porovnej(0, 5), { rozdilPct: null, stav: 'chyba' });
    assert.deepEqual(porovnej(100, 0), { rozdilPct: -100, stav: 'chyba' });
    assert.deepEqual(porovnej(null, undefined), { rozdilPct: 0, stav: 'ok' });
  });

  test('prahy jsou pojmenované konstanty z plánu D4, ne parametr', () => {
    assert.equal(ODCHYLKA_OK_PCT, 10);
    assert.equal(ODCHYLKA_VAROVANI_PCT, 25);
    assert.equal(porovnej.length, 2);
  });
});

describe('radyProGraf', () => {
  test('každý den období, nula kde nejsou data, popisky „1. 10.“, PNO null bez tržeb', () => {
    const r = radyProGraf({
      od: '2026-10-01', do: '2026-10-05',
      trzbyPoDnech: [{ den: '2026-10-02', castka: 1000 }, { den: '2026-10-05', castka: 400 }],
      nakladyPoDnech: { '2026-10-02': 250, '2026-10-04': 100, '2026-10-05': 100 },
    });
    assert.deepEqual(r.dny, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    assert.deepEqual(r.popisky, ['1. 10.', '2. 10.', '3. 10.', '4. 10.', '5. 10.']);
    assert.deepEqual(r.trzby, [0, 1000, 0, 0, 400]);
    assert.deepEqual(r.naklady, [0, 250, 0, 100, 100]);
    assert.deepEqual(r.pno, [null, 25, null, null, 25]);
  });

  test('den i jako Date z DB, dny mimo období se ignorují, duplicitní dny se sečtou', () => {
    const r = radyProGraf({
      od: '2026-10-01', do: '2026-10-02',
      trzbyPoDnech: [{ den: new Date('2026-10-01T00:00:00Z'), castka: 10 }, { den: '2026-10-01', castka: 5 }, { den: '2026-10-09', castka: 99 }],
      nakladyPoDnech: [],
    });
    assert.deepEqual(r.trzby, [15, 0]);
    assert.deepEqual(r.naklady, [0, 0]);
  });

  test('obrácené, chybějící nebo neplatné období dá prázdné řady, ne nekonečnou smyčku', () => {
    const r = radyProGraf({ od: '2026-10-05', do: '2026-10-01', trzbyPoDnech: [], nakladyPoDnech: [] });
    assert.deepEqual(r, { dny: [], popisky: [], trzby: [], naklady: [], pno: [] });
    assert.deepEqual(radyProGraf({ trzbyPoDnech: [], nakladyPoDnech: [] }).dny, []);
    assert.deepEqual(radyProGraf({ od: '2026-10-01', do: '9999-99-99', trzbyPoDnech: [], nakladyPoDnech: [] }).dny, []);
    assert.deepEqual(radyProGraf({ od: '2026-13-01', do: '2026-13-05', trzbyPoDnech: [], nakladyPoDnech: [] }).dny, []);
  });
});

describe('rozpad GA4', () => {
  test('segment „zdroj / médium“ projde stejným jádrem; názvy výchozích skupin GA4 jsou neznámý kanál', () => {
    assert.equal(kanalZeSegmentuGa4('google / cpc'), 'google_ads');
    assert.equal(kanalZeSegmentuGa4('(direct) / (none)'), 'direct');
    assert.equal(kanalZeSegmentuGa4('heureka.cz / cpc'), 'heureka');
    assert.equal(kanalZeSegmentuGa4('Seznam / organic'), 'organic');
    // skupiny GA4 se schválně nepřekládají — „Paid Search“ není ani Google Ads, ani Sklik
    assert.equal(kanalZeSegmentuGa4('Organic Search'), 'neznamy');
    assert.equal(kanalZeSegmentuGa4('Paid Search'), 'neznamy');
    assert.equal(kanalZeSegmentuGa4('Direct'), 'neznamy');
    assert.equal(kanalZeSegmentuGa4('Cross-network'), 'neznamy');
    assert.equal(kanalZeSegmentuGa4('něco jiného'), 'neznamy');
    assert.equal(kanalZeSegmentuGa4(''), 'neznamy');
  });

  test('seskupení řádků GA4 do kanálů, všechny kanály v mapě', () => {
    const r = seskupKanalyGa4([
      { segment: 'google / cpc', sessions: 100, total_users: 80, purchase: 3, purchase_revenue: 2999.996 },
      { segment: 'google / organic', sessions: 50, total_users: 40, purchase: 1, purchase_revenue: 500 },
      { segment: 'seznam / organic', sessions: '20', total_users: '20', purchase: 0, purchase_revenue: 0 },
    ]);
    assert.deepEqual(Object.keys(r), KANALY);
    assert.deepEqual(r.google_ads, { sessions: 100, total_users: 80, purchase: 3, purchase_revenue: 3000 });
    assert.deepEqual(r.organic, { sessions: 70, total_users: 60, purchase: 1, purchase_revenue: 500 });
    assert.deepEqual(r.meta, { sessions: 0, total_users: 0, purchase: 0, purchase_revenue: 0 });
  });
});

// ── SQL pomocníci proti falešné databázi ───────────────────────

/**
 * `sql` jako tagged template, který dotaz jen složí: vnořené fragmenty
 * (`${podminkaObdobi(...)}`) se vloží do textu, parametry jdou do pole,
 * `sql(pole)` dá seznam pro IN. Dotaz je thenable — při `await` se zapíše
 * a vrátí připravené řádky podle části textu.
 */
function falesnaDatabaze(odpovedi = []) {
  const dotazy = [];
  const sloz = (strings, values) => {
    let text = '';
    const params = [];
    strings.forEach((s, i) => {
      text += s;
      if (i >= values.length) return;
      const v = values[i];
      if (v?.__fragment) { text += v.text; params.push(...v.params); } else { text += '?'; params.push(v); }
    });
    return { text, params };
  };
  const sql = (strings, ...values) => {
    if (!strings?.raw) {   // sql(pole) → (?, ?, …)
      return { __fragment: true, text: `(${strings.map(() => '?').join(', ')})`, params: [...strings] };
    }
    const { text, params } = sloz(strings, values);
    const normalizovany = text.replace(/\s+/g, ' ').trim();
    return {
      __fragment: true, text, params,
      then(resolve, reject) {
        dotazy.push({ text: normalizovany, params });
        const odpoved = odpovedi.find(o => normalizovany.includes(o.obsahuje));
        return Promise.resolve(odpoved ? odpoved.radky : []).then(resolve, reject);
      },
    };
  };
  return { sql, dotazy };
}

const OBDOBI = { shopId: 7, od: '2026-10-01', do: '2026-10-31' };

describe('SQL pomocníci', () => {
  test('objednávky za období: sloupce z migrace 042, pražský den, bez storen, zaplaceno', async () => {
    const radky = [{ id: 'o1', total_price: 1210, touch_last_at: null }];
    const db = falesnaDatabaze([{ obsahuje: 'FROM shop_orders o', radky }]);
    const r = await objednavkyZaObdobi(db.sql, OBDOBI);
    assert.deepEqual(r, radky);
    assert.equal(db.dotazy.length, 1);
    const { text, params } = db.dotazy[0];
    for (const sloupec of [
      'o.id', 'o.order_number', 'o.status', 'o.payment_method', 'o.total_price::float8 AS total_price', 'o.created_at',
      'o.utm_source_first', 'o.utm_medium_first', 'o.utm_campaign_first', 'o.utm_term_first', 'o.utm_content_first',
      'o.click_id_kind_first', 'o.click_id_first', 'o.referrer_host_first', 'o.landing_page_first', 'o.touch_first_at',
      'o.utm_source_last', 'o.utm_medium_last', 'o.utm_campaign_last', 'o.utm_term_last', 'o.utm_content_last',
      'o.click_id_kind_last', 'o.click_id_last', 'o.referrer_host_last', 'o.landing_page_last', 'o.touch_last_at',
      'o.attribution_consent', 'AS zaplaceno', "type = 'proforma'",
    ]) assert.ok(text.includes(sloupec), sloupec);
    assert.ok(text.includes("o.created_at >= (?::date::timestamp AT TIME ZONE 'Europe/Prague')"));
    assert.ok(text.includes("o.created_at < ((?::date + 1)::timestamp AT TIME ZONE 'Europe/Prague')"));
    assert.ok(text.includes('o.status NOT IN (?, ?)'));
    assert.ok(text.includes('WHERE o.shop_id = ?'));
    assert.deepEqual(params, [7, '2026-10-01', '2026-10-31', 'Stornována', 'Platba se nezdařila']);
    // stavy filtru jsou parametry; jediný literál 'Stornována' v textu je v kopii pravidla zaplaceno z expedice.js
    // a leží v SELECTu, ne ve WHERE
    assert.equal(text.split("'Stornována'").length - 1, 1);
    assert.ok(text.indexOf("'Stornována'") < text.indexOf('FROM shop_orders o'), 'literál patří do SELECTu (zaplaceno), ne do WHERE');
  });

  test('podmínka zaplaceno: doslovná kopie pravidel z expedice.js i se stavy, vždy TRUE/FALSE (sjednotit s expedice.js)', () => {
    const db = falesnaDatabaze();
    const text = podminkaZaplaceno(db.sql).text.replace(/\s+/g, ' ').trim();
    // Kopie z podminkaKExpedici (src/expedice.js:306-311): řádek se stavy a tři větve platby.
    for (const pravidlo of [
      "o.status NOT IN ('Stornována', 'Čeká na platbu', 'Platba se nezdařila')",
      "(o.payment_method = 'Platba kartou' AND (o.status IN ('Zaplaceno', 'Vyřízena') OR o.tracking_number <> ''))",
      "OR (o.payment_method = 'Bankovní převod' AND p.status = 'Zaplacena')",
      "OR o.payment_method = 'Dobírka'",
    ]) {
      assert.ok(text.includes(pravidlo), `kpi.js: ${pravidlo}`);
      assert.ok(EXPEDICE_ZDROJ.includes(pravidlo), `pravidlo se v expedice.js změnilo — sjednotit kopii v kpi.js: ${pravidlo}`);
    }
    // Převod bez zálohovky má p.status NULL — bez COALESCE by „zaplaceno“ bylo NULL, ne FALSE.
    assert.ok(text.startsWith('COALESCE(('), text);
    assert.ok(text.endsWith('), FALSE)'), text);
  });

  test('položky: prázdný seznam id nedělá dotaz; jinak nákupní cena a příznak DPH', async () => {
    const db = falesnaDatabaze([{ obsahuje: 'FROM shop_order_items', radky: [{ order_id: 'o1', sku: 'T1' }] }]);
    assert.deepEqual(await polozkyObjednavek(db.sql, []), []);
    assert.deepEqual(await polozkyObjednavek(db.sql, undefined), []);
    assert.equal(db.dotazy.length, 0);

    const r = await polozkyObjednavek(db.sql, ['o1', 'o2']);
    assert.deepEqual(r, [{ order_id: 'o1', sku: 'T1' }]);
    const { text, params } = db.dotazy[0];
    assert.ok(text.includes('order_id, sku, name, quantity, price::float8 AS price'));
    assert.ok(text.includes('cost_price::float8 AS cost_price, cost_price_vat_included'));
    assert.ok(text.includes('WHERE order_id = ANY(?::text[])'));
    assert.deepEqual(params, [['o1', 'o2']]);
  });

  test('náklady platforem a po dnech jen z denních součtů (segment_kind = \'\')', async () => {
    const db = falesnaDatabaze([{ obsahuje: 'GROUP BY platform', radky: [{ platform: 'sklik', naklady: 1200.5 }] }]);
    const r = await nakladyPlatforem(db.sql, OBDOBI);
    assert.deepEqual(r, [{ platform: 'sklik', naklady: 1200.5 }]);
    assert.ok(db.dotazy[0].text.includes("FROM marketing_daily_stats WHERE shop_id = ? AND segment_kind = '' AND date BETWEEN ? AND ?"));
    assert.ok(db.dotazy[0].text.includes('COALESCE(SUM(cost), 0)::float8 AS naklady'));
    assert.deepEqual(db.dotazy[0].params, [7, '2026-10-01', '2026-10-31']);

    await nakladyPoDnech(db.sql, OBDOBI);
    assert.ok(db.dotazy[1].text.includes('SELECT date::text AS den, COALESCE(SUM(cost), 0)::float8 AS castka'));
    assert.ok(db.dotazy[1].text.includes("segment_kind = ''"));
    assert.ok(db.dotazy[1].text.includes('GROUP BY date ORDER BY date'));

    // dny s nákladem z API — pro varování o překryvu s ručním nákladem
    await dnyNakladuPlatforem(db.sql, OBDOBI);
    assert.ok(db.dotazy[2].text.includes('SELECT platform, date::text AS den FROM marketing_daily_stats'));
    assert.ok(db.dotazy[2].text.includes("segment_kind = '' AND cost > 0 AND date BETWEEN ? AND ?"));
  });

  test('tržby po dnech: pražský den, bez storen, s DPH z DB → bez DPH v JS', async () => {
    const db = falesnaDatabaze([{ obsahuje: 'FROM shop_orders o', radky: [{ den: '2026-10-01', pocet: 4, trzby_s_dph: 3189 }] }]);
    const r = await trzbyPoDnech(db.sql, OBDOBI);
    assert.deepEqual(r, [{ den: '2026-10-01', pocet: 4, castka: 2635.54, trzbySDph: 3189 }]);
    const { text, params } = db.dotazy[0];
    assert.ok(text.includes("to_char(o.created_at AT TIME ZONE 'Europe/Prague', 'YYYY-MM-DD') AS den"));
    assert.ok(text.includes('o.status NOT IN (?, ?)'));
    assert.ok(text.includes("AT TIME ZONE 'Europe/Prague')"));
    assert.deepEqual(params, [7, '2026-10-01', '2026-10-31', 'Stornována', 'Platba se nezdařila']);
  });

  test('ruční náklady: překryv s obdobím, data jako text, částka jako číslo', async () => {
    const db = falesnaDatabaze([{ obsahuje: 'FROM marketing_manual_costs', radky: [{ id: 1, date_from: '2026-09-20', date_to: '2026-10-05', amount: 500 }] }]);
    const r = await rucniNaklady(db.sql, OBDOBI);
    assert.equal(r.length, 1);
    const { text, params } = db.dotazy[0];
    assert.ok(text.includes('date_from::text AS date_from, date_to::text AS date_to, amount::float8 AS amount'));
    assert.ok(text.includes('WHERE shop_id = ? AND date_from <= ? AND date_to >= ?'));
    assert.deepEqual(params, [7, '2026-10-31', '2026-10-01']);
  });

  test('funnel GA4: jeden objekt, bez dat samé nuly', async () => {
    const plny = falesnaDatabaze([{ obsahuje: "platform = 'ga4' AND segment_kind = ''", radky: [{ dni: 30, sessions: 5000, purchase: 40, purchase_revenue: 80000 }] }]);
    const r = await funnelGa4(plny.sql, OBDOBI);
    assert.equal(r.sessions, 5000);
    assert.ok(plny.dotazy[0].text.includes('COALESCE(SUM(begin_checkout), 0)::int AS begin_checkout'));
    assert.ok(plny.dotazy[0].text.includes('COALESCE(SUM(view_item), 0)::int AS view_item'));

    const prazdny = falesnaDatabaze();
    assert.deepEqual(await funnelGa4(prazdny.sql, OBDOBI),
      { dni: 0, sessions: 0, total_users: 0, view_item: 0, add_to_cart: 0, begin_checkout: 0, purchase: 0, purchase_revenue: 0 });
  });

  test('kanály GA4: rozpad channel', async () => {
    const db = falesnaDatabaze([{ obsahuje: "segment_kind = 'channel'", radky: [{ segment: 'google / cpc', sessions: 10 }] }]);
    const r = await kanalyGa4(db.sql, OBDOBI);
    assert.deepEqual(r, [{ segment: 'google / cpc', sessions: 10 }]);
    assert.ok(db.dotazy[0].text.includes("platform = 'ga4' AND segment_kind = 'channel'"));
    assert.ok(db.dotazy[0].text.includes('GROUP BY segment'));
  });

  test('organika: součty, průměrná pozice z position_sum / impressions, top 20 dotazů', async () => {
    const db = falesnaDatabaze([
      { obsahuje: "segment_kind = ''", radky: [{ dni: 30, clicks: 400, impressions: 20000, position_sum: 50000 }] },
      { obsahuje: "segment_kind = 'query'", radky: [{ dotaz: 'toner canon', clicks: 40, impressions: 1000, position_sum: 1500 }, { dotaz: 'x', clicks: 0, impressions: 0, position_sum: 0 }] },
    ]);
    const r = await organikaSearchConsole(db.sql, OBDOBI);
    assert.equal(r.celkem.pozice, 2.5);
    assert.equal(r.celkem.clicks, 400);
    assert.deepEqual(r.dotazy.map(d => d.pozice), [1.5, null]);
    assert.equal(db.dotazy.length, 2);
    assert.ok(db.dotazy.every(d => d.text.includes("platform = 'search_console'")));
    assert.ok(db.dotazy[1].text.includes('LIMIT 20'));

    const prazdna = await organikaSearchConsole(falesnaDatabaze().sql, OBDOBI);
    assert.deepEqual(prazdna, { celkem: { dni: 0, clicks: 0, impressions: 0, position_sum: 0, pozice: null }, dotazy: [] });
  });

  test('merchant: poslední den s daty + součty; bez dat den null', async () => {
    const db = falesnaDatabaze([
      { obsahuje: 'ORDER BY date DESC LIMIT 1', radky: [{ den: '2026-10-30', approved_items: 1500, disapproved_items: 12 }] },
      { obsahuje: 'COUNT(*)::int AS dni', radky: [{ dni: 20, clicks: 300, impressions: 9000 }] },
    ]);
    assert.deepEqual(await stavMerchantu(db.sql, OBDOBI), { den: '2026-10-30', approved_items: 1500, disapproved_items: 12, clicks: 300, impressions: 9000, dni: 20 });
    assert.ok(db.dotazy.every(d => d.text.includes("platform = 'merchant' AND segment_kind = ''")));

    assert.deepEqual(await stavMerchantu(falesnaDatabaze().sql, OBDOBI), { den: null, approved_items: 0, disapproved_items: 0, clicks: 0, impressions: 0, dni: 0 });
  });

  test('konverze platforem a statistiky e-shopu', async () => {
    const db = falesnaDatabaze([
      { obsahuje: 'GROUP BY platform', radky: [{ platform: 'google_ads', conversions: 12.5, conversion_value: 30000 }] },
      { obsahuje: "platform = 'eshop'", radky: [{ den: '2026-10-01', searches_no_result: 5, carts_abandoned: 3, carts_value: 4500 }] },
    ]);
    const k = await platformniKonverze(db.sql, OBDOBI);
    assert.equal(k[0].conversions, 12.5);
    assert.ok(db.dotazy[0].text.includes('COALESCE(SUM(conversions), 0)::float8 AS conversions'));
    assert.ok(db.dotazy[0].text.includes("segment_kind = ''"));

    const e = await eshopStatistiky(db.sql, OBDOBI);
    assert.equal(e[0].carts_value, 4500);
    assert.ok(db.dotazy[1].text.includes('searches_no_result, carts_abandoned, carts_value::float8 AS carts_value'));
    assert.ok(db.dotazy[1].text.includes("platform = 'eshop' AND segment_kind = ''"));
  });

  test('každý dotaz na statistiky filtruje e-shop a období parametry', async () => {
    const db = falesnaDatabaze();
    await Promise.all([
      nakladyPlatforem(db.sql, OBDOBI), nakladyPoDnech(db.sql, OBDOBI), funnelGa4(db.sql, OBDOBI),
      kanalyGa4(db.sql, OBDOBI), organikaSearchConsole(db.sql, OBDOBI), stavMerchantu(db.sql, OBDOBI),
      platformniKonverze(db.sql, OBDOBI), eshopStatistiky(db.sql, OBDOBI), dnyNakladuPlatforem(db.sql, OBDOBI),
    ]);
    assert.equal(db.dotazy.length, 11);
    for (const d of db.dotazy) {
      assert.ok(d.text.includes('FROM marketing_daily_stats'), d.text);
      assert.ok(d.text.includes('shop_id = ?'), d.text);
      assert.ok(d.text.includes('date BETWEEN ? AND ?'), d.text);
      assert.deepEqual(d.params, [7, '2026-10-01', '2026-10-31']);
    }
  });

  test('sloupce v dotazech existují v migraci 042 (když už je v repozitáři)', (t) => {
    const migrace = nactiMigraci042();
    if (!migrace) { t.skip('migrations/042_marketing.sql tu ještě není — píše ji jiný krok'); return; }

    const rucni = sloupceTabulky(blokTabulky(migrace, 'marketing_manual_costs'));
    for (const s of ['id', 'platform', 'date_from', 'date_to', 'amount', 'note', 'invoice_id', 'receipt_id', 'created_by', 'created_at']) {
      assert.ok(rucni[s], `marketing_manual_costs.${s}`);
    }
    const stats = sloupceTabulky(blokTabulky(migrace, 'marketing_daily_stats'));
    for (const s of ['platform', 'date', 'segment_kind', 'segment', 'cost', 'cost_with_vat', 'impressions', 'clicks', 'conversions',
      'conversion_value', 'sessions', 'total_users', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'purchase_revenue',
      'position_sum', 'approved_items', 'disapproved_items', 'searches_no_result', 'carts_abandoned', 'carts_value']) {
      assert.ok(stats[s], `marketing_daily_stats.${s}`);
    }
    const objednavky = pridaneSloupce(migrace, 'shop_orders');
    for (const s of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'click_id_kind', 'click_id', 'referrer_host', 'landing_page']) {
      assert.ok(objednavky.includes(`${s}_first`), `shop_orders.${s}_first`);
      assert.ok(objednavky.includes(`${s}_last`), `shop_orders.${s}_last`);
    }
    for (const s of ['touch_first_at', 'touch_last_at', 'attribution_consent']) assert.ok(objednavky.includes(s), `shop_orders.${s}`);
    const polozky = pridaneSloupce(migrace, 'shop_order_items');
    for (const s of ['cost_price', 'cost_price_vat_included']) assert.ok(polozky.includes(s), `shop_order_items.${s}`);
    const eshopy = pridaneSloupce(migrace, 'shops');
    for (const s of ['marketing_margin_pct', 'marketing_pno_alert_pct']) assert.ok(eshopy.includes(s), `shops.${s}`);
  });
});
