// Jednotkový test daňového dokladu k objednávce — běží bez databáze i serveru:
//
//   node --test test/danovy-doklad.test.js
//
// Hlídá, co našla kontrola ostrých objednávek: faktura musí nést den přijetí
// úplaty počítaný v pražském čase (kontejner běží v UTC), dobírka nesmí být
// zaplacená ani dostat razítko ZAPLACENO s číslem účtu, první potvrzení platby
// se nepřepíše, zálohovka DUZP netiskne a POHODA dostane totéž DUZP jako PDF.
// PDF se testuje jako HTML (renderInvoiceHtml) — puppeteer by test zpomalil
// a do obsahu dokladu nic nepřidává.
//
// Vystavení faktury (generateInvoiceForOrder) a upomínka jedou proti falešné
// databázi, která jen zapisuje dotazy a vrací připravené řádky. Skutečné SQL
// tu neběží — co závisí na Postgresu (COALESCE u paid_at), je popsané u testu.
//
// Výsledek nesmí záviset na časovém pásmu stroje; ověřeno s TZ=UTC,
// Europe/Prague, America/Los_Angeles a Pacific/Kiritimati.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  denPlatbyKartou, denUhradyZFormulare, denVznikuPovinnosti, hraniceUpozorneni,
  objednavkyKUpozorneni, okamzikPlatbySql, uhradaFakturyObjednavky,
  upozorneniNaChybejiciDoklad, zobrazeniUhrady,
} from '../src/danovy-doklad.js';
import { ceskeDatum, jenDatum, prazskeDatum, pridejDny } from '../src/prazsky-cas.js';
import { renderInvoiceHtml } from '../src/pdf.js';
import { buildPohodaXml } from '../src/pohoda.js';
import { renderSeriesNumber } from '../src/series-format.js';
import { deliverReminder, generateInvoiceForOrder, generateProformaForOrder } from '../src/routes/invoices.js';
import { vyberDokladKPlatbe, zaplatDokladPohybem } from '../src/routes/accounting.js';
import { objednavkaProEshop } from '../src/routes/toneracek.js';
import { invoiceSummaryRows } from '../src/email.js';

// Pondělí 19. 10. 2026, poledne v Praze. Fixní okamžik — test nesmí záviset
// na dni ani na TZ stroje.
const NYNI = new Date('2026-10-19T10:00:00Z');

/** DATE sloupec tak, jak ho vrací postgres.js: půlnoc UTC. */
const datum = (iso) => new Date(`${iso}T00:00:00Z`);

describe('stav a data vydané faktury', () => {
  test('karta: den přijetí úplaty je pražský den platby, ne UTC', () => {
    // 22:30 UTC 30. 9. je v Praze (letní čas) už 0:30 1. 10.
    const r = uhradaFakturyObjednavky(
      { payment_method: 'Platba kartou', paid_at: new Date('2026-09-30T22:30:00Z') },
      { now: NYNI },
    );
    assert.deepEqual(r, { status: 'Zaplacena', paidDate: '2026-10-01', taxableDate: '2026-10-01' });
  });

  test('karta v zimním čase: 23:30 UTC na Silvestra je v Praze už Nový rok', () => {
    const r = uhradaFakturyObjednavky(
      { payment_method: 'Platba kartou', paid_at: '2026-12-31T23:30:00Z' },
      { now: new Date('2027-01-05T10:00:00Z') },
    );
    assert.equal(r.taxableDate, '2027-01-01');
  });

  test('zaplacená karta bez paid_at (před migrací 039): pražský den založení objednávky', () => {
    // 22:30 UTC 16. 9. je v Praze už 0:30 17. 9.
    for (const status of ['Zaplaceno', 'Vyřízena']) {
      const r = uhradaFakturyObjednavky(
        { payment_method: 'Platba kartou', status, paid_at: null, created_at: new Date('2026-09-16T22:30:00Z') },
        { now: NYNI },
      );
      assert.deepEqual(r, { status: 'Zaplacena', paidDate: '2026-09-17', taxableDate: '2026-09-17' }, status);
    }
  });

  test('karta bez paid_at, která zaplacená vedená nebyla, dostane pražský dnešek', () => {
    // Den založení by u nezaplacené objednávky nic neznamenal.
    // 23:30 UTC 19. 10. je v Praze 1:30 20. 10.; toISOString() by vrátil 19.
    const r = uhradaFakturyObjednavky(
      { payment_method: 'Platba kartou', status: 'Přijata', paid_at: null, created_at: new Date('2026-09-16T10:00:00Z') },
      { now: new Date('2026-10-19T23:30:00Z') },
    );
    assert.deepEqual(r, { status: 'Zaplacena', paidDate: '2026-10-20', taxableDate: '2026-10-20' });
  });

  test('paid_at má přednost před dnem založení', () => {
    assert.equal(denPlatbyKartou({
      status: 'Zaplaceno', paid_at: new Date('2026-09-18T08:00:00Z'), created_at: new Date('2026-09-16T08:00:00Z'),
    }), '2026-09-18');
    assert.equal(denPlatbyKartou({ status: 'Čeká na platbu', paid_at: null, created_at: NYNI }), null);
    assert.equal(denPlatbyKartou(null), null);
  });

  test('karta zaplacená dávno: DUZP zůstává v den platby, ne v den vystavení', () => {
    const r = uhradaFakturyObjednavky(
      { payment_method: 'Platba kartou', paid_at: new Date('2026-09-01T08:15:00Z') },
      { now: new Date('2026-09-07T09:00:00Z') },
    );
    assert.equal(r.paidDate, '2026-09-01');
    assert.equal(r.taxableDate, '2026-09-01');
  });

  test('převod: den úhrady zálohové faktury', () => {
    const r = uhradaFakturyObjednavky(
      { payment_method: 'Bankovní převod' },
      { fromProforma: { status: 'Zaplacena', paid_date: datum('2026-09-01') }, now: NYNI },
    );
    assert.deepEqual(r, { status: 'Zaplacena', paidDate: '2026-09-01', taxableDate: '2026-09-01' });

    // Řetězec se nesmí posunout přes pásmo
    const s = uhradaFakturyObjednavky(
      { payment_method: 'Bankovní převod' }, { fromProforma: { paid_date: '2026-09-01' }, now: NYNI });
    assert.equal(s.taxableDate, '2026-09-01');
  });

  test('dobírka: nezaplacená, bez dne úhrady, DUZP = den vystavení', () => {
    const r = uhradaFakturyObjednavky({ payment_method: 'Dobírka', paid_at: null }, { now: NYNI });
    // 'Nezaplacena', ne 'Vystavena' — ta v STATUSES_ISSUED není
    assert.deepEqual(r, { status: 'Nezaplacena', paidDate: null, taxableDate: '2026-10-19' });
  });

  test('jiný způsob platby zůstává při dosavadním chování', () => {
    const r = uhradaFakturyObjednavky({ payment_method: 'card' }, { now: NYNI });
    assert.deepEqual(r, { status: 'Zaplacena', paidDate: '2026-10-19', taxableDate: '2026-10-19' });
  });
});

// ── Falešná databáze ──────────────────────────────────────────

/**
 * INSERT jako objekt sloupec → hodnota. Literály ve VALUES ('issued') se berou
 * doslova, zástupné znaky postupně z `values`. Když se tvar dotazu změní,
 * test spadne na počtu sloupců, ne tiše na špatné hodnotě.
 */
function radekInsertu(strings, values) {
  const text = strings.join('\u0000');
  const [, sloupce, hodnoty] = text.match(/\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/);
  const nazvy = sloupce.split(',').map(s => s.trim());
  const polozky = hodnoty.split(',').map(s => s.trim());
  assert.equal(polozky.length, nazvy.length, 'INSERT má jiný počet sloupců a hodnot');
  let i = 0;
  return Object.fromEntries(nazvy.map((nazev, k) =>
    [nazev, polozky[k] === '\u0000' ? values[i++] : polozky[k].replace(/^'|'$/g, '')]));
}

/**
 * `sql` pro funkce, které si databázi berou parametrem. Zapisuje každý dotaz
 * a na známé dotazy vrací připravené řádky; vložená faktura se vrátí jako
 * výsledek závěrečného SELECTu.
 */
function falesnaDatabaze({ rada = { id: 7, format: 'YYYYNNNN', current_number: 6 }, odpovedi = {} } = {}) {
  const dotazy = [];
  let vlozena = null;

  const sql = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    dotazy.push({ text, values });

    for (const [zacatek, odpoved] of Object.entries(odpovedi)) {
      if (text.startsWith(zacatek)) {
        return typeof odpoved === 'function' ? Promise.resolve().then(odpoved) : Promise.resolve(odpoved);
      }
    }
    if (text.startsWith('SELECT * FROM shop_order_items')) {
      return Promise.resolve([{ name: 'Toner', quantity: 1, price: 1210 }]);
    }
    if (text.startsWith('SELECT id FROM invoice_number_series')) return Promise.resolve(rada ? [{ id: rada.id }] : []);
    if (text.startsWith('UPDATE invoice_number_series')) return Promise.resolve(rada ? [rada] : []);
    if (text.startsWith('INSERT INTO accounting_invoices ')) {
      vlozena = radekInsertu(strings, values);
      return Promise.resolve([]);
    }
    if (text.startsWith('SELECT * FROM accounting_invoices WHERE id')) return Promise.resolve([vlozena]);
    return Promise.resolve([]);
  };

  return { sql, dotazy, vlozena: () => vlozena };
}

const objednavka = (over = {}) => ({
  id: 'obj1', shop_id: 1, order_number: '26101234', total_price: 1250,
  first_name: 'Jan', last_name: 'Novák', address: 'Ulice 1', zip: '11000', city: 'Praha',
  invoice_number: '', paid_at: null, ...over,
});

describe('vystavení faktury k objednávce (generateInvoiceForOrder)', () => {
  test('karta: DUZP a den úhrady z paid_at, vystavení a splatnost v pražském čase', async () => {
    const db = falesnaDatabaze();
    // 23:30 UTC 19. 10. je v Praze už 20. 10.
    await generateInvoiceForOrder(
      db.sql,
      objednavka({ payment_method: 'Platba kartou', paid_at: new Date('2026-09-30T22:30:00Z') }),
      { now: new Date('2026-10-19T23:30:00Z') },
    );

    const f = db.vlozena();
    assert.equal(f.type, 'issued');
    assert.equal(f.number, '20260006');
    assert.equal(f.status, 'Zaplacena');
    assert.equal(f.paid_date, '2026-10-01');
    assert.equal(f.taxable_date, '2026-10-01');
    assert.equal(f.issue_date, '2026-10-20');
    assert.equal(f.due_date, '2026-11-03');
  });

  test('karta zaplacená před migrací 039: den úhrady a DUZP z pražského dne založení', async () => {
    const db = falesnaDatabaze();
    // Objednávka z 23:50 pražského času 16. 9. (letní čas = 21:50 UTC)
    await generateInvoiceForOrder(
      db.sql,
      objednavka({ payment_method: 'Platba kartou', status: 'Zaplaceno', paid_at: null,
                   created_at: new Date('2026-09-16T21:50:00Z') }),
      { now: NYNI },
    );

    const f = db.vlozena();
    assert.equal(f.status, 'Zaplacena');
    assert.equal(f.paid_date, '2026-09-16');
    assert.equal(f.taxable_date, '2026-09-16');
    assert.equal(f.issue_date, '2026-10-19');
    assert.equal(f.due_date, '2026-11-02');
  });

  test('do objednávky se zapíše číslo skutečné faktury', async () => {
    const db = falesnaDatabaze();
    await generateInvoiceForOrder(db.sql, objednavka({ payment_method: 'Platba kartou' }), { now: NYNI });

    const zapis = db.dotazy.find(d => d.text.startsWith('UPDATE shop_orders SET invoice_number'));
    assert.ok(zapis, 'číslo faktury se do objednávky nezapsalo');
    assert.deepEqual(zapis.values, ['20260006', 'obj1']);
  });

  test('převod: den úhrady zálohovky a vazba na ni', async () => {
    const db = falesnaDatabaze();
    await generateInvoiceForOrder(
      db.sql, objednavka({ payment_method: 'Bankovní převod' }),
      { fromProforma: { id: 'zf1', status: 'Zaplacena', paid_date: datum('2026-09-30') }, now: NYNI },
    );

    const f = db.vlozena();
    assert.equal(f.status, 'Zaplacena');
    assert.equal(f.paid_date, '2026-09-30');
    assert.equal(f.taxable_date, '2026-09-30');
    assert.equal(f.proforma_invoice_id, 'zf1');
    assert.equal(f.issue_date, '2026-10-19');
  });

  test('dobírka: nezaplacená, bez dne úhrady, DUZP = den vystavení', async () => {
    const db = falesnaDatabaze();
    await generateInvoiceForOrder(db.sql, objednavka({ payment_method: 'Dobírka' }), { now: NYNI });

    const f = db.vlozena();
    assert.equal(f.status, 'Nezaplacena');
    assert.equal(f.paid_date, null);
    assert.equal(f.taxable_date, '2026-10-19');
    assert.equal(f.issue_date, '2026-10-19');
  });

  test('na Nový rok ve 0:30 nese číslo nový rok, stejně jako datum vystavení', async () => {
    const db = falesnaDatabaze({ rada: { id: 7, format: 'YYYYNNNN', current_number: 1 } });
    await generateInvoiceForOrder(db.sql, objednavka({ payment_method: 'Dobírka' }),
      { now: new Date('2026-12-31T23:30:00Z') });

    const f = db.vlozena();
    assert.equal(f.number, '20270001');
    assert.equal(f.issue_date, '2027-01-01');
  });

  test('zálohová faktura: vystavení a splatnost v pražském čase', async () => {
    const db = falesnaDatabaze({ rada: { id: 8, format: 'ZF-YYYYNNNN', current_number: 42 } });
    await generateProformaForOrder(db.sql, objednavka({ payment_method: 'Bankovní převod' }),
      { now: new Date('2026-10-19T23:30:00Z') });

    const f = db.vlozena();
    assert.equal(f.type, 'proforma');
    assert.equal(f.number, 'ZF-20260042');
    assert.equal(f.issue_date, '2026-10-20');
    assert.equal(f.due_date, '2026-10-27');
  });
});

describe('číselná řada', () => {
  test('rok, měsíc a den jsou pražské, ne podle pásma procesu', () => {
    assert.equal(renderSeriesNumber({ format: 'YYYYNNNN', current_number: 1 }, new Date('2026-12-31T23:30:00Z')), '20270001');
    assert.equal(renderSeriesNumber({ format: 'YYYYNNNN', current_number: 1 }, new Date('2026-12-31T22:30:00Z')), '20260001');
    assert.match(renderSeriesNumber({ format: 'YYMMXXXX', current_number: 1 }, new Date('2026-10-31T23:30:00Z')), /^2611\d{4}$/);
    assert.equal(renderSeriesNumber({ format: 'DD', current_number: 1 }, new Date('2026-09-30T22:30:00Z')), '01');
  });

  test('starý tvar prefix-rok-pořadí se nemění', () => {
    assert.equal(renderSeriesNumber({ prefix: 'FV', year: 2026, padding: 4, current_number: 42 }), 'FV-2026-0042');
  });
});

describe('první potvrzení platby se nepřepíše', () => {
  // Bez databáze jde ověřit jen tvar SQL, ne chování Postgresu. Že COALESCE
  // nechá první zapsaný okamžik a opakovaný Stripe webhook den přijetí úplaty
  // neposune, je vlastnost COALESCE — tady se hlídá, že ho PATCH payment-status
  // i payment-method opravdu dostanou (sdílejí okamzikPlatbySql()).
  const falesneSql = (strings, ...values) => ({ text: strings.join('$'), values });

  test('„Zaplaceno“ zapíše okamžik jen do prázdného sloupce', () => {
    assert.equal(okamzikPlatbySql(falesneSql, 'Zaplaceno').text, 'COALESCE(paid_at, NOW())');
  });

  test('jiné stavy okamžik platby nechají být', () => {
    for (const stav of ['Platba se nezdařila', 'Čeká na platbu', 'Přijata', '', undefined]) {
      assert.equal(okamzikPlatbySql(falesneSql, stav).text, 'paid_at', String(stav));
    }
  });
});

describe('data bez závislosti na pásmu', () => {
  test('splatnost přes změnu času neuklouzne o den', () => {
    assert.equal(pridejDny('2026-10-20', 14), '2026-11-03');   // přes konec letního času
    assert.equal(pridejDny('2026-03-25', 7), '2026-04-01');    // přes začátek
    assert.equal(pridejDny('2026-03-01', -1), '2026-02-28');
  });

  test('DATE z databáze se čte v UTC, okamžik v Praze', () => {
    assert.equal(jenDatum(datum('2026-10-01')), '2026-10-01');
    assert.equal(jenDatum('2026-10-01'), '2026-10-01');
    assert.equal(jenDatum(null), null);
    assert.equal(jenDatum('nesmysl'), null);
    // Z formuláře může přijít den, který neexistuje — Date by ho přetočil na 2. 3.
    assert.equal(jenDatum('2026-02-30'), null);
    assert.equal(jenDatum('2026-13-01'), null);
    assert.equal(jenDatum('2028-02-29'), '2028-02-29');
    assert.equal(prazskeDatum(new Date('2026-09-30T21:59:00Z')), '2026-09-30');
    assert.equal(prazskeDatum(new Date('2026-09-30T22:00:00Z')), '2026-10-01');
    assert.equal(prazskeDatum('nesmysl'), null);
    assert.equal(prazskeDatum(null), null);
  });

  test('ruční změna na Zaplacena: den z formuláře, jinak pražský dnešek', () => {
    assert.equal(denUhradyZFormulare('2026-10-02', NYNI), '2026-10-02');
    // Prázdné nebo nesmyslné pole: pražský dnešek. 23:30 UTC je v Praze už 20. 10.
    // (CURRENT_DATE databáze v UTC by dal 19. 10.)
    const poPulnoci = new Date('2026-10-19T23:30:00Z');
    assert.equal(denUhradyZFormulare('', poPulnoci), '2026-10-20');
    assert.equal(denUhradyZFormulare(undefined, poPulnoci), '2026-10-20');
    assert.equal(denUhradyZFormulare('2026-02-30', poPulnoci), '2026-10-20');
    // Předvyplnění detailu: už zapsaný den úhrady (DATE z databáze) zůstává
    assert.equal(denUhradyZFormulare(datum('2026-09-30'), poPulnoci), '2026-09-30');
  });

  test('české datum má tvar toLocaleDateString("cs-CZ")', () => {
    assert.equal(ceskeDatum(datum('2026-10-01')), '1. 10. 2026');
    assert.equal(ceskeDatum('2026-12-31'), '31. 12. 2026');
    assert.equal(ceskeDatum(null), '');
  });
});

describe('co PDF a e-mail říkají o úhradě', () => {
  test('dobírka: bez razítka i platebních instrukcí', () => {
    const u = zobrazeniUhrady({ invoice: { type: 'issued', status: 'Nezaplacena' }, paymentMethod: 'Dobírka' });
    assert.equal(u.zaplaceno, false);
    assert.equal(u.dobirka, true);
    assert.equal(u.instrukce, false);
    assert.equal(u.formaPlatby, 'Dobírka');
  });

  test('zaplacená dobírka (Zásilkovna peníze poslala) už je prostě zaplacená', () => {
    const u = zobrazeniUhrady({ invoice: { type: 'issued', status: 'Zaplacena' }, paymentMethod: 'Dobírka' });
    assert.equal(u.zaplaceno, true);
    assert.equal(u.dobirka, false);
  });

  test('neznámý způsob platby tiskne převod jako dosud', () => {
    assert.equal(zobrazeniUhrady({ invoice: { type: 'issued' } }).formaPlatby, 'Bankovní převod');
    assert.equal(zobrazeniUhrady({ invoice: { type: 'issued' }, paymentMethod: 'card' }).formaPlatby, 'Bankovní převod');
  });

  test('DUZP jen na vydané faktuře; bez taxable_date je to datum vystavení', () => {
    const vydana = { type: 'issued', issue_date: datum('2026-10-07') };
    assert.equal(zobrazeniUhrady({ invoice: { ...vydana, taxable_date: datum('2026-10-01') } }).duzp, '2026-10-01');
    assert.equal(zobrazeniUhrady({ invoice: { ...vydana, taxable_date: null } }).duzp, '2026-10-07');
    assert.equal(zobrazeniUhrady({ invoice: { ...vydana, type: 'proforma' } }).duzp, null);
  });

  test('souhrn v e-mailu: zaplacená není „k úhradě“, dobírka nemá splatnost', () => {
    const faktura = { number: '20260005', total_amount: 1210, currency: 'CZK', due_date: datum('2026-10-21'), type: 'issued' };

    const zaplacena = invoiceSummaryRows(faktura, zobrazeniUhrady({ invoice: { ...faktura, status: 'Zaplacena' } }));
    assert.doesNotMatch(zaplacena, /k úhradě/i);
    assert.doesNotMatch(zaplacena, /Splatnost/);
    assert.match(zaplacena, /Zaplaceno/);

    const dobirka = invoiceSummaryRows(faktura,
      zobrazeniUhrady({ invoice: { ...faktura, status: 'Nezaplacena' }, paymentMethod: 'Dobírka' }));
    assert.match(dobirka, /K úhradě při převzetí/);
    assert.doesNotMatch(dobirka, /Splatnost/);

    const prevod = invoiceSummaryRows(faktura, zobrazeniUhrady({ invoice: { ...faktura, status: 'Nezaplacena' } }));
    assert.match(prevod, /Celkem k úhradě/);
    // Splatnost stejně jako v PDF, i když proces běží západně od UTC
    assert.match(prevod, /Splatnost[\s\S]*21\. 10\. 2026/);
  });
});

describe('PDF faktury (HTML ze šablony)', () => {
  const issuer = {
    name: 'SEIL s.r.o.', address: 'Ulice 1', zip: '11000', city: 'Praha', ico: '04245610',
    dic: 'CZ04245610', iban: 'CZ6508000000192000145399', bank_account: '19-2000145399/0800',
  };
  const items = [{
    name: 'Toner', quantity: 1, unit: 'ks', price_per_unit: 1210, vat_rate: 21,
    amount: 1000, vat_amount: 210, total: 1210,
  }];
  const vatSummary = [{ rate: 21, base: 1000, vat: 210, total: 1210 }];
  const faktura = (over = {}) => ({
    id: 'f1', type: 'issued', number: '20260005', status: 'Zaplacena',
    client_name: 'Jan Novák', amount: 1000, vat_amount: 210, total_amount: 1210, currency: 'CZK',
    issue_date: datum('2026-10-07'), due_date: datum('2026-10-21'), taxable_date: datum('2026-10-01'),
    ...over,
  });
  const html = (invoice, extra = {}) => renderInvoiceHtml({ invoice, items, issuer, vatSummary, ...extra });
  const DUZP = (text) => new RegExp(
    `Datum uskutečnění zdanitelného plnění</td>\\s*<td class="value" colspan="3">${text.replace(/\./g, '\\.')}</td>`);

  test('dobírka: žádné ZAPLACENO, QR ani číslo účtu — jen text o dobírce', async () => {
    const h = await html(
      faktura({ status: 'Nezaplacena', paid_date: null, taxable_date: datum('2026-10-07') }),
      { paymentMethod: 'Dobírka', paid: false },
    );
    assert.doesNotMatch(h, /ZAPLACENO/);
    assert.doesNotMatch(h, /data:image\/png/);              // QR platba
    assert.doesNotMatch(h, /Platební instrukce/);
    assert.doesNotMatch(h, /19-2000145399\/0800/);          // číslo účtu
    assert.match(h, /Úhrada dobírkou při převzetí zásilky/);
    assert.match(h, /badge-unpaid">DOBÍRKA/);
    assert.match(h, /Forma platby<\/td>\s*<td class="value">Dobírka<\/td>/);
    assert.match(h, /Datum splatnosti<\/td>\s*<td class="value">Při převzetí<\/td>/);
    assert.doesNotMatch(h, /21\. 10\. 2026/);                 // splatnost +14 dní z databáze
    assert.match(h, /<span>K ÚHRADĚ DOBÍRKOU<\/span>/);
    assert.match(h, DUZP('7. 10. 2026'));
  });

  test('dobírka po splatnosti neříká zákazníkovi PO SPLATNOSTI', async () => {
    const h = await html(faktura({ status: 'Po splatnosti', paid_date: null }), { paymentMethod: 'Dobírka' });
    assert.match(h, /badge-unpaid">DOBÍRKA/);
    assert.doesNotMatch(h, /PO SPLATNOSTI/);
    assert.doesNotMatch(h, /Platební instrukce/);
  });

  test('karta: ZAPLACENO, bez instrukcí, DUZP = den platby', async () => {
    const h = await html(faktura(), { paymentMethod: 'Platba kartou', paid: true });
    assert.match(h, /badge-paid">ZAPLACENO/);
    assert.doesNotMatch(h, /Platební instrukce/);
    assert.doesNotMatch(h, /data:image\/png/);
    assert.match(h, /Forma platby<\/td>\s*<td class="value">Platba kartou<\/td>/);
    assert.match(h, DUZP('1. 10. 2026'));
    assert.match(h, /Datum vystavení<\/td>\s*<td class="value">7\. 10\. 2026<\/td>/);
    assert.match(h, /Datum splatnosti<\/td>\s*<td class="value">21\. 10\. 2026<\/td>/);
  });

  test('ruční nezaplacená faktura: DUZP = vystavení, instrukce i QR zůstávají', async () => {
    const h = await html(faktura({ status: 'Nezaplacena', taxable_date: undefined }));
    assert.match(h, DUZP('7. 10. 2026'));
    assert.match(h, /Platební instrukce/);
    assert.match(h, /data:image\/png/);
    assert.match(h, /badge-unpaid">K ÚHRADĚ/);
    assert.match(h, /<span>K ÚHRADĚ<\/span>/);
    assert.match(h, /Datum splatnosti<\/td>\s*<td class="value">21\. 10\. 2026<\/td>/);
    assert.match(h, /Forma platby<\/td>\s*<td class="value">Bankovní převod<\/td>/);
  });

  test('ruční faktura po splatnosti dál ukazuje PO SPLATNOSTI', async () => {
    const h = await html(faktura({ status: 'Po splatnosti', taxable_date: undefined }));
    assert.match(h, /badge-overdue">PO SPLATNOSTI/);
    assert.match(h, /Platební instrukce/);
  });

  test('zálohová faktura DUZP netiskne — daňovým dokladem není', async () => {
    const h = await html(
      faktura({ type: 'proforma', number: '2026100001', status: 'Nezaplacena', taxable_date: null }),
      { paymentMethod: 'Bankovní převod', vs: '10234' },
    );
    assert.match(h, /ZÁLOHOVÁ FAKTURA/);
    assert.doesNotMatch(h, /Datum uskutečnění zdanitelného plnění/);
    assert.match(h, /Platební instrukce/);
  });

  test('datum z opakované faktury (řetězec) se tiskne stejně', async () => {
    const h = await html({ ...faktura({ status: 'Nezaplacena' }), issue_date: '2026-10-07', taxable_date: undefined });
    assert.match(h, DUZP('7. 10. 2026'));
    assert.match(h, /Datum vystavení<\/td>\s*<td class="value">7\. 10\. 2026<\/td>/);
  });
});

describe('upomínka k dobírce', () => {
  test('neodejde a do historie se zapíše proč', async () => {
    const db = falesnaDatabaze({
      odpovedi: {
        'SELECT * FROM company_settings': [{ name: 'SEIL s.r.o.' }],
        'SELECT order_number, payment_method FROM shop_orders': [{ order_number: '26101234', payment_method: 'Dobírka' }],
        // Pojistka: k vykreslení PDF (a tedy k e-mailu) se upomínka dostat nesmí
        'SELECT * FROM accounting_invoice_items': () => { throw new Error('upomínka k dobírce došla k PDF'); },
      },
    });

    const vysledek = await deliverReminder(db.sql, {
      invoice: { id: 'f1', number: '20260005', order_id: 'obj1', shop_id: 1, due_date: datum('2026-10-01') },
      email: 'zakaznik@example.cz', level: 2, userId: 1,
    });

    assert.equal(vysledek.ok, false);
    assert.match(vysledek.error, /dobírce se neupomíná/);
    const zaznam = db.dotazy.find(d => d.text.startsWith('INSERT INTO invoice_emails'));
    assert.ok(zaznam, 'odmítnutí se má zapsat do historie odeslání');
    assert.ok(zaznam.values.includes('chyba'));
    assert.ok(!db.dotazy.some(d => d.text.startsWith('INSERT INTO invoice_reminders')),
      'odmítnutá upomínka se nesmí vést jako odeslaná');
  });
});

describe('párování plateb s doklady', () => {
  const b2b = { id: 'b2b' };
  const zaloha = { id: 'zf' };

  test('jediný kandidát se páruje jako dřív', () => {
    assert.equal(vyberDokladKPlatbe([zaloha]), zaloha);
    assert.equal(vyberDokladKPlatbe([]), null);
  });

  test('víc kandidátů na jeden VS se nepáruje — rozhodne obsluha', () => {
    // 20260042, ZF-20260042 i FV-2026-0042 mají týž VS; ani shoda částky
    // nerozhoduje, dvě objednávky na stejnou částku jsou běžné.
    assert.equal(vyberDokladKPlatbe([b2b, zaloha]), null);
    assert.equal(vyberDokladKPlatbe([zaloha, { id: 'zf2' }]), null);
  });

  test('ruční spárování: den úhrady je den pohybu na účtu, ne den kliknutí', async () => {
    const db = falesnaDatabaze();
    // 23:30 UTC 19. 10. je v Praze už 20. 10. — pojistka bere pražský den
    await zaplatDokladPohybem(db.sql, { docId: 'zf', txId: 42, now: new Date('2026-10-19T23:30:00Z') });

    const [zapis] = db.dotazy;
    assert.match(zapis.text, /^UPDATE accounting_invoices SET status = 'Zaplacena'/);
    assert.match(zapis.text, /paid_date = COALESCE\( \(SELECT transaction_date FROM accounting_bank_transactions WHERE id = \?\), \?::date \)/);
    assert.doesNotMatch(zapis.text, /CURRENT_DATE/);
    assert.deepEqual(zapis.values, [42, '2026-10-20', 42, 'zf']);
  });
});

describe('číslo faktury pro e-shop', () => {
  test('vymyšlené FV-… z objednávky se zákazníkovi neposílá', () => {
    const o = objednavkaProEshop({ id: 'o1', invoice_number: 'FV-2026-26101234', vydana_faktura: null });
    assert.equal(o.invoice_number, '');
    assert.ok(!('vydana_faktura' in o));
  });

  test('jde číslo vydané faktury, i když objednávka nese staré FV-…', () => {
    const o = objednavkaProEshop({ id: 'o1', invoice_number: 'FV-2026-26101234', vydana_faktura: '20260005' });
    assert.equal(o.invoice_number, '20260005');
  });
});

describe('hlídání lhůty 15 dnů', () => {
  test('den, od kterého lhůta běží, podle způsobu platby', () => {
    // Karta: pražský den platby
    assert.equal(denVznikuPovinnosti({ payment_method: 'Platba kartou', paid_at: new Date('2026-09-30T22:30:00Z') }), '2026-10-01');
    // Zaplacená karta bez paid_at (před migrací 039): pražský den založení
    assert.equal(denVznikuPovinnosti({
      payment_method: 'Platba kartou', status: 'Zaplaceno', paid_at: null,
      created_at: new Date('2026-09-16T22:30:00Z'),
    }), '2026-09-17');
    // Karta bez paid_at, která zaplacená vedená není, se nehlídá
    assert.equal(denVznikuPovinnosti({
      payment_method: 'Platba kartou', status: 'Čeká na platbu', paid_at: null,
      created_at: NYNI, warehouse_sent_at: NYNI,
    }), null);
    // Převod: úhrada zálohovky, paid_at se ignoruje (fakturu dělá taky podle zálohovky)
    assert.equal(denVznikuPovinnosti({ payment_method: 'Bankovní převod', uhrazeno: datum('2026-09-02'), paid_at: NYNI }), '2026-09-02');
    assert.equal(denVznikuPovinnosti({ payment_method: 'Bankovní převod', uhrazeno: null, paid_at: NYNI }), null);
    // Dobírka: odeslání do skladu, pražský den
    assert.equal(denVznikuPovinnosti({ payment_method: 'Dobírka', warehouse_sent_at: new Date('2026-09-30T22:30:00Z') }), '2026-10-01');
    assert.equal(denVznikuPovinnosti({ payment_method: 'Dobírka', warehouse_sent_at: null, paid_at: NYNI }), null);
    // Cokoli jiného: platba, jinak zálohovka
    assert.equal(denVznikuPovinnosti({ payment_method: 'card', paid_at: new Date('2026-09-03T10:00:00Z') }), '2026-09-03');
    assert.equal(denVznikuPovinnosti({ payment_method: 'card', uhrazeno: '2026-09-04' }), '2026-09-04');
  });

  test('upozorňuje se, když lhůta běží deset dní a víc (zbývá pět)', () => {
    const hranice = hraniceUpozorneni('2026-09-12');
    assert.equal(hranice, '2026-09-02');

    const vyber = objednavkyKUpozorneni([
      { id: 'a', order_number: '3', payment_method: 'Bankovní převod', uhrazeno: datum('2026-09-02') },       // deset dní → už ano
      { id: 'e', order_number: '5', payment_method: 'Bankovní převod', uhrazeno: datum('2026-09-03') },       // devět dní → ještě ne
      { id: 'b', order_number: '2', payment_method: 'Dobírka', warehouse_sent_at: new Date('2026-08-31T08:00:00Z') },
      { id: 'c', order_number: '1', payment_method: 'Platba kartou', paid_at: new Date('2026-09-01T08:00:00Z') },
      { id: 'd', order_number: '4', payment_method: 'Platba kartou', status: 'Přijata', paid_at: null,
        created_at: new Date('2026-08-20T08:00:00Z') },                                                      // nezaplacená
      { id: 'f', order_number: '6', payment_method: 'Platba kartou', status: 'Vyřízena', paid_at: null,
        created_at: new Date('2026-08-25T08:00:00Z') },                                                      // před migrací 039
      // Odeslaná dobírka bez faktury se hlásí, i když ji nikdo nevyřídil
      { id: 'g', order_number: '7', payment_method: 'Dobírka', status: 'Přijata',
        warehouse_sent_at: new Date('2026-09-01T22:30:00Z') },                                                // v Praze už 2. 9.
    ], '2026-09-12');

    assert.deepEqual(vyber, [
      { id: 'f', order_number: '6', den: '2026-08-25', dobirka: false },
      { id: 'b', order_number: '2', den: '2026-08-31', dobirka: true },
      { id: 'c', order_number: '1', den: '2026-09-01', dobirka: false },
      { id: 'a', order_number: '3', den: '2026-09-02', dobirka: false },
      { id: 'g', order_number: '7', den: '2026-09-02', dobirka: true },
    ]);
  });

  test('jedna objednávka: lhůta v textu a odkaz rovnou na ni', () => {
    const u = upozorneniNaChybejiciDoklad(
      [{ id: 'abc', order_number: '10234', den: '2026-09-01', dobirka: false }], '2026-09-12');
    assert.equal(u.title, '1 objednávka bez faktury');
    assert.equal(u.body, '#10234 zaplaceno 1. 9., lhůta do 16. 9.');
    assert.equal(u.url, '/ucetnictvi/objednavky/abc');
  });

  test('dobírka se hlásí jako odeslaná, ne zaplacená', () => {
    const u = upozorneniNaChybejiciDoklad(
      [{ id: 'abc', order_number: '10235', den: '2026-09-01', dobirka: true }], '2026-09-12');
    assert.equal(u.body, '#10235 dobírka odeslána 1. 9., lhůta do 16. 9.');
  });

  test('prošlá lhůta se pozná a víc objednávek vede na seznam', () => {
    const objednavky = Array.from({ length: 7 }, (_, i) => ({
      id: `o${i}`, order_number: String(10230 + i), den: '2026-09-01', dobirka: false,
    }));
    const u = upozorneniNaChybejiciDoklad(objednavky, '2026-09-17');
    assert.equal(u.title, '7 objednávek bez faktury');
    assert.match(u.body, /^#10230 zaplaceno 1\. 9\., lhůta uplynula 16\. 9\./);
    assert.match(u.body, / a dalších 2$/);
    assert.equal(u.url, '/ucetnictvi/objednavky');
    assert.equal(upozorneniNaChybejiciDoklad(objednavky.slice(0, 3), '2026-09-12').title,
      '3 objednávky bez faktury');
  });
});

describe('POHODA dostane totéž DUZP jako PDF', () => {
  const vydana = {
    id: 'x1', type: 'issued', number: '20260005', client_name: 'Jan Novák',
    amount: 1000, vat_amount: 210, total_amount: 1210, currency: 'CZK',
    issue_date: datum('2026-10-07'), due_date: datum('2026-10-21'),
    _items: [{ name: 'Toner', quantity: 1, unit_price: 1000, vat_rate: 21, amount: 1000, vat_amount: 210 }],
  };

  test('dateTax = taxable_date, datum dokladu zůstává datum vystavení', () => {
    const xml = buildPohodaXml([{ ...vydana, taxable_date: datum('2026-09-30') }], { ico: '04245610' });
    assert.match(xml, /<inv:dateTax>2026-09-30<\/inv:dateTax>/);
    assert.match(xml, /<inv:date>2026-10-07<\/inv:date>/);
  });

  test('starší doklad bez taxable_date má DUZP = datum vystavení jako dosud', () => {
    const xml = buildPohodaXml([{ ...vydana, taxable_date: null }], { ico: '04245610' });
    assert.match(xml, /<inv:dateTax>2026-10-07<\/inv:dateTax>/);
  });
});
