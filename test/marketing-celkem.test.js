// Celkový marketingový přehled přes všechny e-shopy (sestavCelkovyPrehled):
// čistá funkce nad hotovými přehledy e-shopů, bez databáze.
//
//   node --test test/marketing-celkem.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sestavCelkovyPrehled, sestavPrehled } from '../src/marketing/prehled.js';

const obdobi = { preset: 'vlastni', od: '2026-01-01', do: '2026-01-03', popis: '' };
const dnes = '2026-01-10';

/** Přehled e-shopu ze zjednodušených řádků (tržby s DPH po dnech, náklady API, ruční náklad). */
function prehledEshopu(shop, { objednavky = [], polozky = [], nakladyApi = [], nakladyDny = [], rucni = [] }) {
  const poDnech = new Map();
  for (const o of objednavky) {
    const den = o.den;
    const z = poDnech.get(den) ?? { den, pocet: 0, castka: 0 };
    z.pocet += 1;
    z.castka += o.total_price / 1.21;
    poDnech.set(den, z);
  }
  return {
    shop,
    prehled: sestavPrehled({
      shop, obdobi, dnes,
      objednavky: objednavky.map((o, i) => ({ id: `${shop.slug}-${i}`, status: 'Přijata', zaplaceno: true, ...o })),
      polozky, nakladyApi, nakladyDny, rucni, trzbyDny: [...poDnech.values()],
    }),
  };
}

const toneracek = { id: 1, slug: 'toneracek', name: 'Toneráček.cz', barva: '#0891b2', marketing_margin_pct: 0, marketing_pno_alert_pct: 10 };
const dilna = { id: 2, slug: 'dilnavlnenka', name: 'Dílna Vlněnka', barva: '#A85E56', marketing_margin_pct: 30, marketing_pno_alert_pct: 0 };

// Toneráček: 2 objednávky po 1 210 Kč s DPH (2 000 bez DPH), 500 Kč Google Ads z API, bez marže.
const t = prehledEshopu(toneracek, {
  objednavky: [{ total_price: 1210, den: '2026-01-01' }, { total_price: 1210, den: '2026-01-02' }],
  nakladyApi: [{ platform: 'google_ads', naklady: 500, naklady_s_dph: 605 }],
  nakladyDny: [{ den: '2026-01-01', castka: 500 }],
});
// Dílna: 1 objednávka 2 420 Kč s DPH (2 000 bez DPH), položka s odhadem marže 30 %,
// 300 Kč Google Ads z API a 300 Kč Meta ručně na tři dny.
const d = prehledEshopu(dilna, {
  objednavky: [{ total_price: 2420, den: '2026-01-03' }],
  polozky: [{ order_id: 'dilnavlnenka-0', sku: 'KLUBKO', quantity: 1, price: 2420, cost_price: null }],
  nakladyApi: [{ platform: 'google_ads', naklady: 300, naklady_s_dph: 363 }],
  nakladyDny: [{ den: '2026-01-03', castka: 300 }],
  rucni: [{ id: 1, platform: 'meta', date_from: '2026-01-01', date_to: '2026-01-03', amount: 300 }],
});

describe('sestavCelkovyPrehled', () => {
  const c = sestavCelkovyPrehled([t, d]);

  test('tržby, objednávky a náklady jsou součty e-shopů', () => {
    assert.equal(c.trzby.bezDph, 4000);
    assert.equal(c.trzby.pocet, 3);
    assert.equal(c.naklady.celkem, 1100);
    assert.equal(c.naklady.api, 800);
    assert.equal(c.naklady.rucni, 300);
  });

  test('PNO, ROAS a cena za objednávku ze součtů, ne průměrem procent', () => {
    assert.equal(c.kpi.pno, 27.5);          // 1 100 / 4 000
    assert.equal(c.kpi.roas, 3.64);         // 4 000 / 1 100
    assert.equal(c.kpi.cpa, 366.67);        // 1 100 / 3

    // Malý e-shop s PNO 100 % celkové číslo nepřetáhne: (500 + 100) / (2 000 + 100), ne (25 + 100) / 2.
    const maly = prehledEshopu({ id: 3, slug: 'maly', name: 'Malý', barva: '#000' }, {
      objednavky: [{ total_price: 121, den: '2026-01-01' }],
      nakladyApi: [{ platform: 'sklik', naklady: 100, naklady_s_dph: 121 }],
    });
    assert.equal(maly.prehled.kpi.pno, 100);
    assert.equal(sestavCelkovyPrehled([t, maly]).kpi.pno, 28.57);
  });

  test('zisk po reklamě jen nad e-shopy, které znají marži', () => {
    assert.equal(c.marze.maMarzi, true);
    assert.equal(c.marze.marze, 600);       // 30 % z 2 000 bez DPH
    assert.deepEqual(c.marze.bezMarze, ['Toneráček.cz']);
    assert.equal(c.kpi.zisk, 0);            // 600 − 600 nákladů Dílny; Toneráček bez marže nepočítá
    assert.equal(c.kpi.roi, 0);
  });

  test('bez marže všude: zisk ani ROI se nevymýšlí', () => {
    const bez = sestavCelkovyPrehled([t]);
    assert.equal(bez.marze.maMarzi, false);
    assert.equal(bez.kpi.zisk, null);
    assert.equal(bez.kpi.roi, null);
  });

  test('náklady po platformách sečtené, s e-shopy, které na nich utrácely', () => {
    const google = c.naklady.radky.find(r => r.platform === 'google_ads');
    assert.equal(google.celkem, 800);
    assert.deepEqual(google.eshopy.map(e => [e.shop.slug, e.celkem]), [['toneracek', 500], ['dilnavlnenka', 300]]);
    const meta = c.naklady.radky.find(r => r.platform === 'meta');
    assert.equal(meta.rucni, 300);
    assert.deepEqual(meta.eshopy.map(e => e.shop.slug), ['dilnavlnenka']);
    assert.deepEqual(c.naklady.radky.map(r => r.platform), ['google_ads', 'meta'], 'od největšího');
  });

  test('graf: řada tržeb za každý e-shop v jeho barvě a součty po dnech', () => {
    assert.deepEqual(c.graf.dny, ['2026-01-01', '2026-01-02', '2026-01-03']);
    assert.deepEqual(c.graf.eshopy.map(e => [e.nazev, e.barva]), [['Toneráček.cz', '#0891b2'], ['Dílna Vlněnka', '#A85E56']]);
    assert.deepEqual(c.graf.trzby, [1000, 1000, 2000]);
    assert.deepEqual(c.graf.naklady, [600, 100, 400]);   // API + ruční 100 Kč denně
    assert.deepEqual(c.graf.pno, [60, 10, 20]);
  });

  test('řádky e-shopů: podíl na tržbách a zisk jen se známou marží', () => {
    assert.deepEqual(c.eshopy.map(r => [r.shop.slug, r.pocet, r.trzbyBezDph, r.naklady, r.podil]),
      [['toneracek', 2, 2000, 500, 50], ['dilnavlnenka', 1, 2000, 600, 50]]);
    assert.equal(c.eshopy[0].zisk, null);
    assert.equal(c.eshopy[1].zisk, 0);
    assert.equal(c.eshopy[0].pnoPrekrocen, true, 'práh Toneráčku 10 %, PNO 25 %');
  });

  test('varování nesou e-shop, ke kterému patří', () => {
    assert.ok(c.varovani.length >= 2);
    assert.deepEqual([...new Set(c.varovani.map(v => v.eshop))], ['Toneráček.cz', 'Dílna Vlněnka']);
    assert.ok(c.varovani.every(v => v.shop && v.text));
  });

  test('bez e-shopů nespadne', () => {
    const prazdny = sestavCelkovyPrehled([]);
    assert.equal(prazdny.trzby.bezDph, 0);
    assert.equal(prazdny.kpi.pno, null);
    assert.deepEqual(prazdny.graf.dny, []);
    assert.deepEqual(prazdny.eshopy, []);
  });
});
