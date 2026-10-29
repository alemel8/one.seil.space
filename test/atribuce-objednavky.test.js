// Jednotkový test atribuce objednávky a nákupní ceny položky — běží bez
// databáze i serveru:
//
//   node --test test/atribuce-objednavky.test.js
//
// Hlídá kontrakt s e-shopem (docs/api.md): 21 sloupců shop_orders přesně
// podle migrace 042, čištění textů (řídicí a neviditelné formátovací znaky,
// <>"'`\, délky, malá písmena u source/medium), enumy jen z povolených
// hodnot, čas dotyku jen ISO 8601 s pásmem a do ±1 roku — jinak u dotyku
// s údaji čas přijetí, u dotyku bez údajů NULL —, click-id jen
// s marketingovým souhlasem, a že bez `marketing` v těle vyjdou výchozí
// hodnoty sloupců. Nákupní cena na haléře, ne na celé koruny.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELKY, DRUHY_CLICK_ID, SLOUPCE_ATRIBUCE, SOUHLASY, atribuceZTela, nakupniCenaZPolozky,
} from '../src/atribuce-objednavky.js';

// Pevné „teď“ — hranice ±1 rok nesmí záviset na dni spuštění testu.
const TED = new Date('2026-10-29T12:00:00Z');

const PRAZDNY_DOTYK = (p) => ({
  [`utm_source_${p}`]: '', [`utm_medium_${p}`]: '', [`utm_campaign_${p}`]: '', [`utm_term_${p}`]: '',
  [`utm_content_${p}`]: '', [`click_id_kind_${p}`]: '', [`click_id_${p}`]: '', [`referrer_host_${p}`]: '',
  [`landing_page_${p}`]: '', [`touch_${p}_at`]: null,
});
const VYCHOZI = { ...PRAZDNY_DOTYK('first'), ...PRAZDNY_DOTYK('last'), attribution_consent: '' };

describe('sloupce', () => {
  test('přesně 21 sloupců podle kontraktu, v pořadí first, last, souhlas', () => {
    assert.deepEqual(SLOUPCE_ATRIBUCE, [
      'utm_source_first', 'utm_medium_first', 'utm_campaign_first', 'utm_term_first', 'utm_content_first',
      'click_id_kind_first', 'click_id_first', 'referrer_host_first', 'landing_page_first', 'touch_first_at',
      'utm_source_last', 'utm_medium_last', 'utm_campaign_last', 'utm_term_last', 'utm_content_last',
      'click_id_kind_last', 'click_id_last', 'referrer_host_last', 'landing_page_last', 'touch_last_at',
      'attribution_consent',
    ]);
    assert.equal(SLOUPCE_ATRIBUCE.length, 21);
    assert.deepEqual(Object.keys(atribuceZTela(undefined, TED)), SLOUPCE_ATRIBUCE);
    assert.deepEqual(Object.keys(atribuceZTela({ consent: 'all', first: { source: 'google' } }, TED)), SLOUPCE_ATRIBUCE);
  });

  test('enumy odpovídají kontraktu', () => {
    assert.deepEqual(DRUHY_CLICK_ID, ['gclid', 'gbraid', 'wbraid', 'fbclid', 'sznclid', 'sznaiid', 'hgtid', 'aku']);
    assert.deepEqual(SOUHLASY, ['none', 'analytics', 'marketing', 'all']);
    assert.deepEqual(DELKY, { utm: 120, clickId: 200, host: 100, cesta: 200 });
  });
});

describe('bez marketingu v těle', () => {
  test('chybějící, null i nesmysl dají výchozí hodnoty sloupců', () => {
    for (const telo of [undefined, null, '', 0, 'x', [], {}, { consent: 'spam' }, { first: 'ne', last: 5 }]) {
      assert.deepEqual(atribuceZTela(telo, TED), VYCHOZI, `tělo ${JSON.stringify(telo)}`);
    }
  });

  test('jen souhlas bez dotyků', () => {
    assert.deepEqual(atribuceZTela({ consent: 'none' }, TED), { ...VYCHOZI, attribution_consent: 'none' });
  });
});

describe('dotyky', () => {
  const DOTYK = {
    source: 'Google', medium: 'CPC', campaign: 'Tonery HP', term: 'hp 12a', content: 'textovy',
    clickIdKind: 'gclid', clickId: 'Cj0KCQ-abc_123', referrerHost: 'www.google.com',
    landingPage: '/produkty/hp-12a', at: '2026-10-28T09:15:00.000Z',
  };

  test('mapování first a last na sloupce, source/medium malými', () => {
    const r = atribuceZTela({
      consent: 'all', first: DOTYK,
      last: { ...DOTYK, source: 'seznam', medium: 'cpc', clickIdKind: 'sznclid', clickId: 'szn-1', at: '2026-10-29T10:00:00Z' },
    }, TED);
    assert.deepEqual(r, {
      utm_source_first: 'google', utm_medium_first: 'cpc', utm_campaign_first: 'Tonery HP',
      utm_term_first: 'hp 12a', utm_content_first: 'textovy', click_id_kind_first: 'gclid',
      click_id_first: 'Cj0KCQ-abc_123', referrer_host_first: 'google.com', landing_page_first: '/produkty/hp-12a',
      touch_first_at: new Date('2026-10-28T09:15:00.000Z'),
      utm_source_last: 'seznam', utm_medium_last: 'cpc', utm_campaign_last: 'Tonery HP',
      utm_term_last: 'hp 12a', utm_content_last: 'textovy', click_id_kind_last: 'sznclid',
      click_id_last: 'szn-1', referrer_host_last: 'google.com', landing_page_last: '/produkty/hp-12a',
      touch_last_at: new Date('2026-10-29T10:00:00Z'),
      attribution_consent: 'all',
    });
  });

  test('jen last: first zůstane prázdný', () => {
    const r = atribuceZTela({ consent: 'analytics', last: { source: 'direct', medium: '(none)', at: DOTYK.at } }, TED);
    assert.deepEqual(r, {
      ...VYCHOZI, utm_source_last: 'direct', utm_medium_last: '(none)',
      touch_last_at: new Date(DOTYK.at), attribution_consent: 'analytics',
    });
  });

  test('řídicí znaky a <>"\'`\\ se odstraní, text se ořízne', () => {
    const r = atribuceZTela({
      consent: 'none',
      last: { source: ' <b>Goo"gle\'</b>\x00\x1f ', medium: '`cpc`\\', campaign: 'a\tb\nc\x7f' },
    }, TED);
    assert.equal(r.utm_source_last, 'bgoogle/b');
    assert.equal(r.utm_medium_last, 'cpc');
    assert.equal(r.utm_campaign_last, 'abc');
  });

  test('C1, nulová šířka, bidi a BOM se odstraní stejně jako ASCII řídicí znaky', () => {
    // Jinak by RLO + „google“ vyšlo obráceně a „tonery“ + ZWSP + „hp“ bylo jinou kampaní než „toneryhp“.
    const r = atribuceZTela({
      consent: 'none',
      last: {
        source: '\u202Egoogle', campaign: 'tonery\u200Bhp', term: 'a\u0085b\u009Fc\u0080',
        content: '\uFEFFx\u2060y\u2066z\u2069\u200D\u200E\u202A\u2064',
      },
    }, TED);
    assert.equal(r.utm_source_last, 'google');
    assert.equal(r.utm_campaign_last, 'toneryhp');
    assert.equal(r.utm_term_last, 'abc');
    assert.equal(r.utm_content_last, 'xyz');
  });

  test('délky podle kontraktu: utm 120, click-id 200, host 100, cesta 200', () => {
    const dlouhy = (n, znak = 'a') => znak.repeat(n);
    const r = atribuceZTela({
      consent: 'all',
      last: {
        source: dlouhy(300, 'S'), medium: dlouhy(300), campaign: dlouhy(300), term: dlouhy(300), content: dlouhy(300),
        clickIdKind: 'gclid', clickId: dlouhy(300), referrerHost: `${dlouhy(300)}.cz`, landingPage: `/${dlouhy(300)}`,
      },
    }, TED);
    assert.equal(r.utm_source_last, dlouhy(120, 's'));
    assert.equal(r.utm_medium_last.length, 120);
    assert.equal(r.utm_campaign_last.length, 120);
    assert.equal(r.utm_term_last.length, 120);
    assert.equal(r.utm_content_last.length, 120);
    assert.equal(r.click_id_last.length, 200);
    assert.equal(r.referrer_host_last.length, 100);
    assert.equal(r.landing_page_last.length, 200);
  });

  test('ořez počítá znaky, ne bajty — diakritika a emoji se nerozpůlí', () => {
    const r = atribuceZTela({ consent: 'none', last: { campaign: 'ě'.repeat(119) + '😀' + 'x'.repeat(10) } }, TED);
    assert.equal(r.utm_campaign_last, 'ě'.repeat(119) + '😀');
    assert.equal(Array.from(r.utm_campaign_last).length, 120);
  });

  test('čísla se vezmou jako text, jiné typy jako prázdné', () => {
    const r = atribuceZTela({ consent: 'none', last: { campaign: 2026, term: true, content: { a: 1 }, source: ['x'] } }, TED);
    assert.equal(r.utm_campaign_last, '2026');
    assert.equal(r.utm_term_last, '');
    assert.equal(r.utm_content_last, '');
    assert.equal(r.utm_source_last, '');
  });
});

describe('click-id', () => {
  test('každý povolený druh projde s marketingovým souhlasem', () => {
    for (const druh of DRUHY_CLICK_ID) {
      for (const souhlas of ['marketing', 'all']) {
        const r = atribuceZTela({ consent: souhlas, last: { clickIdKind: druh, clickId: 'id-1' } }, TED);
        assert.equal(r.click_id_kind_last, druh);
        assert.equal(r.click_id_last, 'id-1');
      }
    }
  });

  test('bez marketingového souhlasu se neuloží druh ani hodnota', () => {
    for (const souhlas of ['none', 'analytics', undefined, 'spam']) {
      const r = atribuceZTela({ consent: souhlas, first: { clickIdKind: 'gclid', clickId: 'x' }, last: { clickIdKind: 'fbclid', clickId: 'y' } }, TED);
      assert.equal(r.click_id_kind_first, '', `souhlas ${souhlas}`);
      assert.equal(r.click_id_first, '');
      assert.equal(r.click_id_kind_last, '');
      assert.equal(r.click_id_last, '');
    }
  });

  test('neznámý druh zahodí i hodnotu, druh bez hodnoty se neuloží', () => {
    assert.deepEqual(
      [atribuceZTela({ consent: 'all', last: { clickIdKind: 'msclkid', clickId: 'x' } }, TED)].map((r) => [r.click_id_kind_last, r.click_id_last]),
      [['', '']]
    );
    const bezHodnoty = atribuceZTela({ consent: 'all', last: { clickIdKind: 'gclid', clickId: '  ' } }, TED);
    assert.equal(bezHodnoty.click_id_kind_last, '');
    assert.equal(bezHodnoty.click_id_last, '');
    const jenHodnota = atribuceZTela({ consent: 'all', last: { clickId: 'x' } }, TED);
    assert.equal(jenHodnota.click_id_last, '');
  });
});

describe('referrer a vstupní stránka', () => {
  test('jen hostitel malými písmeny bez www., schématu, portu a cesty', () => {
    const host = (v) => atribuceZTela({ consent: 'none', last: { referrerHost: v } }, TED).referrer_host_last;
    assert.equal(host('www.Google.com'), 'google.com');
    assert.equal(host('https://www.seznam.cz/hledani?q=toner'), 'seznam.cz');
    assert.equal(host('localhost:3000'), 'localhost');
    assert.equal(host('heureka.cz'), 'heureka.cz');
    assert.equal(host('ne host!'), '');
    assert.equal(host(''), '');
    assert.equal(host(undefined), '');
  });

  test('jen cesta bez dotazu a kotvy, vždy s úvodním lomítkem', () => {
    const cesta = (v) => atribuceZTela({ consent: 'none', last: { landingPage: v } }, TED).landing_page_last;
    assert.equal(cesta('/produkty?utm_source=google#top'), '/produkty');
    assert.equal(cesta('https://toneracek.cz/produkty/hp-12a?gclid=1'), '/produkty/hp-12a');
    assert.equal(cesta('produkty/hp'), '/produkty/hp');
    assert.equal(cesta('/'), '/');
    assert.equal(cesta(''), '');
    assert.equal(cesta(null), '');
  });
});

describe('čas dotyku', () => {
  // Dotyk bez údajů: čas se bere jen platný, jinak NULL.
  const cas = (v) => atribuceZTela({ consent: 'none', last: { at: v } }, TED).touch_last_at;
  // Dotyk se zdrojem: čas má vždy — nepoužitelný nahradí čas přijetí (TED).
  const casSeZdrojem = (v) => atribuceZTela({ consent: 'none', last: { source: 'google', medium: 'cpc', at: v } }, TED).touch_last_at;

  test('ISO 8601 s pásmem projde, i s posunem', () => {
    assert.deepEqual(cas('2026-10-28T09:15:00.000Z'), new Date('2026-10-28T09:15:00.000Z'));
    assert.deepEqual(cas('2026-10-28T11:15:00+02:00'), new Date('2026-10-28T09:15:00Z'));
    assert.deepEqual(cas('2026-10-28T11:15:00+0200'), new Date('2026-10-28T09:15:00Z'));
    assert.deepEqual(cas(' 2026-10-29T12:00Z '), new Date('2026-10-29T12:00:00Z'));
    assert.deepEqual(casSeZdrojem('2026-10-28T09:15:00Z'), new Date('2026-10-28T09:15:00Z'), 'platný čas zůstane i se zdrojem');
  });

  test('bez pásma se čas nebere — new Date by ho vzal v pásmu serveru, ne v UTC', () => {
    for (const v of ['2026-10-28T09:15:00', '2026-10-28T09:15', '2026-10-28T09:15:00.000']) {
      assert.equal(cas(v), null, `hodnota ${v}`);
      assert.deepEqual(casSeZdrojem(v), TED, `hodnota ${v} se zdrojem → čas přijetí`);
    }
  });

  test('neplatný, jiný tvar nebo jiný typ → NULL u dotyku bez údajů', () => {
    for (const v of ['nesmysl', '2026-13-45T00:00:00Z', '2026', '12', 1761730000000, null, undefined, {}, '2026-10-28', '2026-10-28T09:15:00Z x']) {
      assert.equal(cas(v), null, `hodnota ${JSON.stringify(v)}`);
    }
  });

  test('víc než rok od teď → NULL, rok a méně projde', () => {
    assert.equal(cas('2025-10-01T12:00:00Z'), null, 'starší než rok');
    assert.equal(cas('2027-11-15T12:00:00Z'), null, 'dál než rok v budoucnu');
    assert.equal(cas('1970-01-01T00:00:00Z'), null);
    assert.deepEqual(cas('2025-11-15T12:00:00Z'), new Date('2025-11-15T12:00:00Z'));
    assert.deepEqual(cas('2026-11-05T12:00:00Z'), new Date('2026-11-05T12:00:00Z'), 'pár dní dopředu (hodiny klienta) projde');
  });

  test('dotyk s údaji má čas vždy: nepoužitelný nahradí čas přijetí, ne NULL', () => {
    // touch_last_at IS NULL = e-shop atribuci neposlal (migrace 042); dotyk
    // se zdrojem by jinak v KPI vyšel jako neznámý kanál.
    for (const v of ['nesmysl', undefined, '1970-01-01T00:00:00Z', '2027-11-15T12:00:00Z']) {
      assert.deepEqual(casSeZdrojem(v), TED, `hodnota ${JSON.stringify(v)}`);
    }
    // Stačí jediný údaj — i referrer bez UTM určuje kanál.
    assert.deepEqual(atribuceZTela({ consent: 'none', first: { referrerHost: 'seznam.cz', at: 'x' } }, TED).touch_first_at, TED);
    // Click-id bez marketingového souhlasu se zahodí celý: dotyk pak nic nenese a čas zůstane NULL.
    assert.equal(atribuceZTela({ consent: 'none', last: { clickIdKind: 'gclid', clickId: 'x', at: 'x' } }, TED).touch_last_at, null);
    // Chybějící dotyk čas přijetí nedostane.
    assert.equal(atribuceZTela({ consent: 'all', first: { source: 'google', medium: 'cpc' } }, TED).touch_last_at, null);
  });
});

describe('nákupní cena položky', () => {
  test('na haléře, ne na celé koruny', () => {
    assert.deepEqual(nakupniCenaZPolozky({ costPrice: 210.456, costPriceVatIncluded: false }),
      { cost_price: 210.46, cost_price_vat_included: false });
    assert.deepEqual(nakupniCenaZPolozky({ costPrice: 1.005, costPriceVatIncluded: true }),
      { cost_price: 1.01, cost_price_vat_included: true });
    assert.deepEqual(nakupniCenaZPolozky({ costPrice: 210, costPriceVatIncluded: false }),
      { cost_price: 210, cost_price_vat_included: false });
    assert.deepEqual(nakupniCenaZPolozky({ costPrice: 0, costPriceVatIncluded: false }),
      { cost_price: 0, cost_price_vat_included: false });
  });

  test('číselný text projde, i s desetinnou čárkou', () => {
    assert.equal(nakupniCenaZPolozky({ costPrice: '210.5' }).cost_price, 210.5);
    assert.equal(nakupniCenaZPolozky({ costPrice: ' 210,25 ' }).cost_price, 210.25);
  });

  test('mimo [0, 1e6), nekonečno, NaN, prázdno a jiné typy → NULL', () => {
    for (const v of [-1, -0.001, 1e6, 1e9, Infinity, -Infinity, NaN, null, undefined, '', ' ', 'abc', true, [], {}]) {
      assert.equal(nakupniCenaZPolozky({ costPrice: v }).cost_price, null, `hodnota ${String(v)}`);
    }
    assert.equal(nakupniCenaZPolozky({ costPrice: 999999.999 }).cost_price, 1000000, 'těsně pod stropem se zaokrouhlí');
  });

  test('příznak DPH jen true/false, jinak NULL', () => {
    assert.equal(nakupniCenaZPolozky({ costPrice: 1, costPriceVatIncluded: true }).cost_price_vat_included, true);
    assert.equal(nakupniCenaZPolozky({ costPrice: 1, costPriceVatIncluded: false }).cost_price_vat_included, false);
    for (const v of ['true', 1, 0, null, undefined, 'ano']) {
      assert.equal(nakupniCenaZPolozky({ costPrice: 1, costPriceVatIncluded: v }).cost_price_vat_included, null, `hodnota ${String(v)}`);
    }
  });

  test('pseudo-položka a starší e-shop bez polí → oba NULL', () => {
    assert.deepEqual(nakupniCenaZPolozky({ sku: 'DOPRAVA', name: 'Doprava', quantity: 1, price: 79, costPrice: null, costPriceVatIncluded: null }),
      { cost_price: null, cost_price_vat_included: null });
    assert.deepEqual(nakupniCenaZPolozky({ sku: 'K-1', name: 'Položka', quantity: 2, price: 149 }),
      { cost_price: null, cost_price_vat_included: null });
    assert.deepEqual(nakupniCenaZPolozky(null), { cost_price: null, cost_price_vat_included: null });
  });
});
