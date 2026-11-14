// Jednotkový test generátoru POHODA XML – běží bez databáze i serveru:
//
//   node --test test/pohoda.test.js
//
// Hlídá připomínky účetní ze srpna 2026: doklad placený kartou nesmí spadnout
// do pokladny a u reprezentace se nesmí uplatnit odpočet DPH.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPohodaXml, isCashReceipt, isVatDeductible, receiptAgenda } from '../src/pohoda.js';

const uctenka = (over = {}) => ({
  _type: 'receipt', id: 1, number: '2026001234', vendor: 'Kavárna s.r.o.', vendor_ico: '12345678',
  amount: 100, vat_amount: 21, total_amount: 121, currency: 'CZK',
  receipt_date: '2026-08-01', category: 'Provoz', ...over,
});

const faktura = (over = {}) => ({
  id: 'ab12cd', type: 'received', number: 'FV-2026/0042', supplier: 'Dodavatel a.s.',
  supplier_ico: '87654321', supplier_dic: 'CZ87654321', amount: 2000, vat_amount: 420,
  total_amount: 2420, currency: 'CZK', issue_date: '2026-08-03', due_date: '2026-08-17', ...over,
});

// <typ:priceNone>121.00</typ:priceNone> → 121
const cislo = (xml, tag) => {
  const m = xml.match(new RegExp(`<typ:${tag}>([-\\d.]+)</typ:${tag}>`));
  return m ? Number(m[1]) : null;
};

describe('účtenka podle formy úhrady', () => {
  test('hotovost jde do pokladny jako výdajový doklad', () => {
    const xml = buildPohodaXml([uctenka()], { ico: '04245610', cashAccount: 'Pokladna hlavní' });
    assert.match(xml, /<vou:voucherType>expense<\/vou:voucherType>/);
    assert.match(xml, /<typ:ids>Pokladna hlavní<\/typ:ids>/);
    assert.doesNotMatch(xml, /commitment/);
    // Evidenční číslo přiděluje POHODA z řady pokladny, číslo paragonu jde vedle
    assert.doesNotMatch(xml, /<vou:number>/);
    assert.match(xml, /<vou:originalDocument>2026001234<\/vou:originalDocument>/);
  });

  test('karta jde do ostatních závazků, ne do pokladny', () => {
    const xml = buildPohodaXml([uctenka({ payment_method: 'Karta' })], { ico: '04245610' });
    assert.match(xml, /<inv:invoiceType>commitment<\/inv:invoiceType>/);
    assert.match(xml, /<typ:paymentType>creditcard<\/typ:paymentType>/);
    assert.doesNotMatch(xml, /vou:voucher/);
  });

  test('převodem jde také mimo pokladnu, ale příkazem', () => {
    const xml = buildPohodaXml([uctenka({ payment_method: 'Převodem' })], { ico: '04245610' });
    assert.match(xml, /<inv:invoiceType>commitment<\/inv:invoiceType>/);
    assert.match(xml, /<typ:paymentType>draft<\/typ:paymentType>/);
  });

  test('agenda se dá zjistit i mimo generátor (pro seznam a filtry)', () => {
    assert.equal(isCashReceipt(uctenka()), true);
    assert.equal(receiptAgenda(uctenka()), 'Pokladna');
    assert.equal(receiptAgenda(uctenka({ payment_method: 'Karta' })), 'Ostatní závazky');
  });
});

describe('doklad bez nároku na odpočet DPH (reprezentace)', () => {
  test('celá částka jde do nákladů a DPH se neodečítá', () => {
    const xml = buildPohodaXml([uctenka({ vat_deductible: false })], { ico: '04245610' });
    assert.equal(cislo(xml, 'priceNone'), 121);           // základ i DPH v nákladech
    assert.doesNotMatch(xml, /priceHigh/);                // žádný rozpad sazby
    assert.match(xml, /nonSubsume/);                      // do přiznání DPH nevstupuje
    assert.doesNotMatch(xml, /<vou:dateTax>/);            // bez data zdanitelného plnění
  });

  test('platí i pro účtenku placenou kartou', () => {
    const xml = buildPohodaXml([uctenka({ payment_method: 'Karta', vat_deductible: false })], {});
    assert.equal(cislo(xml, 'priceNone'), 121);
    assert.match(xml, /nonSubsume/);
    assert.doesNotMatch(xml, /<inv:dateTax>/);
  });

  test('platí i pro přijatou fakturu', () => {
    const xml = buildPohodaXml([faktura({ vat_deductible: false })], {});
    assert.equal(cislo(xml, 'priceNone'), 2420);
    assert.match(xml, /nonSubsume/);
    assert.doesNotMatch(xml, /priceHighVAT/);
  });

  test('předkontace bez odpočtu přebije tu z dokladu', () => {
    const xml = buildPohodaXml([uctenka({ vat_deductible: false, account_debit: '518' })],
      { predkontace: '3Vd', predkontaceNoVat: '513Repre' });
    assert.match(xml, /<typ:ids>513Repre<\/typ:ids>/);
    assert.doesNotMatch(xml, /<typ:ids>518<\/typ:ids>/);
  });

  test('s nárokem na odpočet zůstává rozpad podle sazby', () => {
    const xml = buildPohodaXml([uctenka()], {});
    assert.equal(cislo(xml, 'priceHigh'), 100);
    assert.equal(cislo(xml, 'priceHighVAT'), 21);
    assert.doesNotMatch(xml, /nonSubsume/);
    assert.equal(isVatDeductible(uctenka()), true);
  });
});

describe('přijatá faktura', () => {
  test('evidenční číslo si přiděluje POHODA, dodavatelovo jde do pole Doklad', () => {
    const xml = buildPohodaXml([faktura()], { ico: '04245610' });
    assert.doesNotMatch(xml, /numberRequested/);
    assert.match(xml, /<inv:originalDocument>FV-2026\/0042<\/inv:originalDocument>/);
    assert.match(xml, /<inv:symVar>20260042<\/inv:symVar>/);   // VS jen z číslic
  });

  test('nese adresu dodavatele včetně DIČ a data účetního případu', () => {
    const xml = buildPohodaXml([faktura({
      supplier_address: 'Dlouhá 1', supplier_city: 'Praha', supplier_zip: '11000',
    })], {});
    assert.match(xml, /<typ:dic>CZ87654321<\/typ:dic>/);
    assert.match(xml, /<typ:street>Dlouhá 1<\/typ:street>/);
    assert.match(xml, /<inv:dateAccounting>2026-08-03<\/inv:dateAccounting>/);
    assert.match(xml, /<inv:dateDue>2026-08-17<\/inv:dateDue>/);
  });

  test('tuzemsko se neposílá, cizí země ano', () => {
    assert.doesNotMatch(buildPohodaXml([faktura({ supplier_country: 'Česká republika' })], {}), /typ:country/);
    assert.match(buildPohodaXml([faktura({ supplier_country: 'Slovensko' })], {}), /<typ:ids>SK<\/typ:ids>/);
  });

  test('předkontace z nastavení se použije, když ji doklad nemá', () => {
    assert.match(buildPohodaXml([faktura()], { predkontaceReceived: '1Pf' }), /<typ:ids>1Pf<\/typ:ids>/);
    assert.match(buildPohodaXml([faktura({ account_debit: '518' })], { predkontaceReceived: '1Pf' }),
      /<typ:ids>518<\/typ:ids>/);
  });

  test('součet položek a rekapitulace sedí na celkovou částku', () => {
    const xml = buildPohodaXml([faktura()], {});
    const soucet = cislo(xml, 'priceHigh') + cislo(xml, 'priceHighVAT') + cislo(xml, 'priceRound');
    assert.equal(soucet, 2420);
  });
});

describe('vydaná faktura', () => {
  const vydana = {
    id: 'x1', type: 'issued', number: '2026-0007', client_name: 'Klient s.r.o.', client_ico: '11112222',
    amount: 1000, vat_amount: 210, total_amount: 1210, currency: 'CZK', issue_date: '2026-08-05',
    due_date: '2026-08-19',
    _items: [{ name: 'Služba', quantity: 2, unit_price: 500, vat_rate: 21, amount: 1000, vat_amount: 210 }],
  };

  test('číslo z naší řady si držíme, VS je jen z číslic', () => {
    const xml = buildPohodaXml([vydana], { ico: '04245610' });
    assert.match(xml, /<typ:numberRequested>2026-0007<\/typ:numberRequested>/);
    assert.match(xml, /<inv:symVar>20260007<\/inv:symVar>/);
    assert.match(xml, /<inv:invoiceType>issuedInvoice<\/inv:invoiceType>/);
  });

  test('položky se přenesou i s rozpadem DPH', () => {
    const xml = buildPohodaXml([vydana], {});
    assert.match(xml, /<inv:text>Služba<\/inv:text>/);
    assert.equal(cislo(xml, 'priceHigh'), 1000);
    assert.equal(cislo(xml, 'priceHighVAT'), 210);
  });
});

describe('balíček', () => {
  test('IČO účetní jednotky jde do hlavičky', () => {
    assert.match(buildPohodaXml([], { ico: '042 456 10' }), /ico="04245610"/);
  });

  test('XML se neláme na uvozovkách a ampersandech', () => {
    const xml = buildPohodaXml([uctenka({ vendor: 'Pekař "U & U" s.r.o.', notes: '<test>' })], {});
    assert.match(xml, /Pekař &quot;U &amp; U&quot; s\.r\.o\./);
    assert.doesNotMatch(xml, /<test>/);
  });

  test('krátký nečíselný symbol se raději neposílá', () => {
    const xml = buildPohodaXml([uctenka({ number: 'B2', payment_method: 'Karta' })], {});
    assert.doesNotMatch(xml, /symVar/);
  });

  test('zaokrouhlení paragonu skončí v priceRound, ne v základu', () => {
    const xml = buildPohodaXml([uctenka({ amount: 100, vat_amount: 21, total_amount: 121.5 })], {});
    assert.equal(cislo(xml, 'priceRound'), 0.5);
  });
});

// Listopad 2026: faktury Anthropicu v eurech přišly do POHODY s nulou. XML neslo
// částky v homeCurrency a jen značku měny, POHODA u dokladu v cizí měně bere
// částky z foreignCurrency, a ty chyběly.
describe('doklad v cizí měně', () => {
  const anthropic = (over = {}) => faktura({
    number: 'IM69EW9T-0034', supplier: 'Anthropic, PBC', supplier_ico: '', supplier_dic: '',
    amount: 12.41, vat_amount: 0, total_amount: 12.41, currency: 'EUR', issue_date: '2026-11-05', ...over,
  });
  // Obsah prvního výskytu značky, např. <inv:foreignCurrency>…</inv:foreignCurrency>
  const blok = (xml, tag) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? null;

  test('částky položky jdou v cizí měně, ne jako koruny', () => {
    const xml = buildPohodaXml([anthropic()], {});
    const polozka = blok(xml, 'inv:invoiceItem');
    assert.doesNotMatch(polozka, /homeCurrency/);
    assert.equal(cislo(blok(polozka, 'inv:foreignCurrency'), 'unitPrice'), 12.41);
    assert.match(polozka, /<inv:rateVAT>none<\/inv:rateVAT>/);
  });

  // Kurz bere POHODA ze svého lístku (vyhlášený předchozí pracovní den), jako
  // u dokladů, které účetní zadala ručně.
  test('souhrn nese jen měnu, kurz a koruny doplní POHODA', () => {
    const souhrn = blok(buildPohodaXml([anthropic()], {}), 'inv:invoiceSummary');
    assert.match(souhrn, /<inv:foreignCurrency>\s*<typ:currency>\s*<typ:ids>EUR<\/typ:ids>\s*<\/typ:currency>\s*<\/inv:foreignCurrency>/);
    assert.doesNotMatch(souhrn, /typ:rate|homeCurrency/);
  });

  test('měna zapsaná znakem se převede na kód', () => {
    assert.match(buildPohodaXml([anthropic({ currency: '€' })], {}), /<typ:ids>EUR<\/typ:ids>/);
    const xml = buildPohodaXml([faktura({ currency: 'Kč' })], {});
    assert.doesNotMatch(xml, /foreignCurrency/);
    assert.equal(cislo(xml, 'priceHigh'), 2000);
  });

  test('koruny zůstávají v homeCurrency i s rekapitulací', () => {
    const xml = buildPohodaXml([faktura()], {});
    assert.doesNotMatch(xml, /foreignCurrency/);
    assert.match(blok(xml, 'inv:invoiceSummary'), /<inv:homeCurrency>/);
  });
});

describe('předkontace a členění DPH z POHODY', () => {
  const vzor = { predkontace: '11Fp', cleneni: 'bez', cislo: '261100121' };
  const ucetni = (xml) => blok(xml, 'inv:accounting');
  const cleneni = (xml) => blok(xml, 'inv:classificationVAT');
  const blok = (xml, tag) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? null;

  test('zkratky z dokladu mají přednost před vzorem i nastavením', () => {
    const xml = buildPohodaXml([faktura({ pohoda_predkontace: '13Fp', pohoda_cleneni_dph: 'PD', _vzor: vzor })],
      { predkontaceReceived: '7Fp' });
    assert.match(ucetni(xml), /<typ:ids>13Fp<\/typ:ids>/);
    assert.match(cleneni(xml), /<typ:ids>PD<\/typ:ids>/);
  });

  test('doklad bez zkratek vezme vzor z předchozí faktury dodavatele', () => {
    const xml = buildPohodaXml([faktura({ _vzor: vzor })], { predkontaceReceived: '7Fp' });
    assert.match(ucetni(xml), /<typ:ids>11Fp<\/typ:ids>/);
    assert.match(cleneni(xml), /<typ:ids>bez<\/typ:ids>/);
    assert.doesNotMatch(cleneni(xml), /classificationVATType/);
  });

  test('bez zkratek i vzoru platí nastavení a členění POHODA doplní sama', () => {
    const xml = buildPohodaXml([faktura()], { predkontaceReceived: '7Fp' });
    assert.match(ucetni(xml), /<typ:ids>7Fp<\/typ:ids>/);
    assert.doesNotMatch(xml, /classificationVAT/);
  });

  test('reprezentace si drží svou předkontaci a nezahrnutí do DPH i proti vzoru', () => {
    const xml = buildPohodaXml([faktura({ vat_deductible: false, _vzor: { predkontace: '11Fp', cleneni: 'PD' } })],
      { predkontaceNoVat: '513Repre' });
    assert.match(ucetni(xml), /<typ:ids>513Repre<\/typ:ids>/);
    assert.match(cleneni(xml), /nonSubsume/);
    assert.doesNotMatch(cleneni(xml), /PD/);
  });

  test('vydaná faktura nese zkratky stejně', () => {
    const xml = buildPohodaXml([{
      id: 'v1', type: 'issued', number: '21260027', client_name: 'LASVIT s.r.o.', amount: 1000, vat_amount: 0,
      total_amount: 1000, currency: 'CZK', issue_date: '2026-11-10', _vzor: { predkontace: 'L', cleneni: 'UDA4' },
    }], {});
    assert.match(ucetni(xml), /<typ:ids>L<\/typ:ids>/);
    assert.match(cleneni(xml), /<typ:ids>UDA4<\/typ:ids>/);
  });
});
