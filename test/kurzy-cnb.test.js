// Kurzy ČNB a přepočet dokladů v cizí měně na koruny.
//
// Část bez databáze testuje čtení souboru ČNB a plánování stažení. Část
// s databází jede proti DATABASE_URL (lokální testovací DB s migrací 049)
// a používá měnu XTS – ISO 4217 ji drží právě pro testy, takže se nepotká
// se skutečnými kurzy. Všechno, co vytvoří, na konci smaže.
//   DATABASE_URL=… node --test test/kurzy-cnb.test.js

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import {
  aktualizujKurzy, ocekavanyDen, parseRocniKurzy, potrebujeStahnout, URL_ROK,
} from '../src/kurzy-cnb.js';
import { naklady, popisPrepoctu, trzby } from '../src/finance.js';

// Výřez skutečného souboru ČNB (rok.txt) se změnou hlavičky uprostřed,
// jak se stane, když ČNB přidá nebo ubere měnu.
const SOUBOR = '﻿' + [
  'Datum|1 AUD|1 EUR|100 JPY|1000 IDR|1 USD',
  '02.01.2026|13,797|24,170|13,141|1,233|20,611',
  '05.01.2026|13,835|24,195|13,226|1,239|20,742',
  'Datum|1 EUR|1 USD|100 TRY',
  '06.01.2026|24,195|20,670|48,020',
  '',
].join('\n');

describe('soubor ČNB', () => {
  const radky = parseRocniKurzy(SOUBOR);
  const kurz = (mena, datum) => radky.find(r => r.mena === mena && r.datum === datum)?.kurz;

  test('čte den, měnu a kurz s desetinnou čárkou', () => {
    assert.equal(kurz('EUR', '2026-01-02'), '24.170000');
    assert.equal(kurz('USD', '2026-01-05'), '20.742000');
  });

  test('kurz za 100 nebo 1000 jednotek vydělí na jednu', () => {
    // 100 JPY = 13,141 Kč, tedy 1 JPY = 0,13141 Kč. Bez dělení by faktura
    // na 10 000 JPY vyšla na 131 410 Kč místo 1 314 Kč.
    assert.equal(kurz('JPY', '2026-01-02'), '0.131410');
    assert.equal(kurz('IDR', '2026-01-02'), '0.001233');
  });

  test('nová hlavička uprostřed souboru platí pro další řádky', () => {
    assert.equal(kurz('TRY', '2026-01-06'), '0.480200');
    assert.equal(kurz('USD', '2026-01-06'), '20.670000', 'USD je v nové hlavičce v jiném sloupci');
    assert.equal(kurz('AUD', '2026-01-06'), undefined);
    assert.equal(radky.length, 5 + 5 + 3);
  });

  test('chybová stránka místo souboru nedá žádný kurz', () => {
    assert.deepEqual(parseRocniKurzy('<html><body>Chyba</body></html>'), []);
    assert.deepEqual(parseRocniKurzy(''), []);
  });
});

// Pražský čas: 11. 11. 2026 je středa a platí zimní čas (UTC+1).
const praha = (datum, cas) => new Date(`${datum}T${cas}:00+01:00`);

describe('kdy ČNB vyhlašuje', () => {
  test('po 14:30 v pracovní den je to dnešek, dopoledne včerejšek', () => {
    assert.equal(ocekavanyDen(praha('2026-11-11', '15:00')), '2026-11-11');
    assert.equal(ocekavanyDen(praha('2026-11-11', '14:29')), '2026-11-10');
  });

  test('o víkendu a v pondělí dopoledne je to pátek', () => {
    assert.equal(ocekavanyDen(praha('2026-11-14', '12:00')), '2026-11-13');
    assert.equal(ocekavanyDen(praha('2026-11-15', '18:00')), '2026-11-13');
    assert.equal(ocekavanyDen(praha('2026-11-16', '09:00')), '2026-11-13');
  });
});

describe('kdy stahovat', () => {
  const ted = praha('2026-11-11', '15:00');

  test('rok, který ještě nikdy nestáhl, stáhne', () => {
    assert.equal(potrebujeStahnout(null, 2026, ted), true);
    assert.equal(potrebujeStahnout(null, 2024, ted), true);
  });

  test('budoucí rok nestahuje', () => {
    assert.equal(potrebujeStahnout(null, 2027, ted), false);
  });

  test('letošek stáhne, až může přibýt den, který chybí', () => {
    const vcera = { stazeno_at: praha('2026-11-10', '15:00'), posledni_datum: '2026-11-10' };
    assert.equal(potrebujeStahnout(vcera, 2026, ted), true, 'po 14:30 je dnešní kurz venku');
    assert.equal(potrebujeStahnout(vcera, 2026, praha('2026-11-11', '10:00')), false, 'dopoledne nic nového');
    const dnes = { stazeno_at: praha('2026-11-11', '14:40'), posledni_datum: '2026-11-11' };
    assert.equal(potrebujeStahnout(dnes, 2026, ted), false);
  });

  test('o víkendu se po páteční aktualizaci nestahuje', () => {
    const patek = { stazeno_at: praha('2026-11-13', '15:00'), posledni_datum: '2026-11-13' };
    assert.equal(potrebujeStahnout(patek, 2026, praha('2026-11-15', '12:00')), false);
  });

  test('když kurz po 14:30 nepřibyl, zkouší to ten den jen jednou za hodinu', () => {
    // Svátek (17. 11. je úterý) nebo zpoždění ČNB.
    const svatek = { stazeno_at: praha('2026-11-17', '14:40'), posledni_datum: '2026-11-16' };
    assert.equal(potrebujeStahnout(svatek, 2026, praha('2026-11-17', '15:00')), false);
    assert.equal(potrebujeStahnout(svatek, 2026, praha('2026-11-17', '15:41')), true);
    // Druhý den dopoledne už ne: čeká na vyhlášení 18. 11. po 14:30.
    const pozde = { stazeno_at: praha('2026-11-17', '23:50'), posledni_datum: '2026-11-16' };
    assert.equal(potrebujeStahnout(pozde, 2026, praha('2026-11-18', '10:00')), false);
  });

  test('uzavřený rok stáhne jednou po jeho konci', () => {
    const vLete = { stazeno_at: praha('2025-07-01', '15:00'), posledni_datum: '2025-07-01' };
    assert.equal(potrebujeStahnout(vLete, 2025, ted), true, 'stažený uprostřed roku je neúplný');
    const poKonci = { stazeno_at: praha('2026-01-05', '15:00'), posledni_datum: '2025-12-31' };
    assert.equal(potrebujeStahnout(poKonci, 2025, ted), false);
  });
});

describe('přepočet v databázi', { skip: !process.env.DATABASE_URL && 'chybí DATABASE_URL' }, () => {
  let sql;
  const r = crypto.randomBytes(4).toString('hex');
  // Období daleko od skutečných dat a jiné než v test/finance.test.js, který
  // běží souběžně. 6. 6. 2031 je pátek.
  const OD = '2031-06-01', DO = '2031-06-30';
  const id = s => `kurz_${s}_${r}`;

  before(async () => {
    sql = postgres(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === 'true', max: 3 });
    await sql`DELETE FROM kurzy_cnb WHERE mena = 'XTS'`;
    await sql`
      INSERT INTO kurzy_cnb (mena, datum, kurz) VALUES
        ('XTS', '2031-06-05', 25.000000),
        ('XTS', '2031-06-06', 24.500000)
    `;
    await sql`
      INSERT INTO accounting_invoices (id, type, number, supplier, issue_date, total_amount, vat_amount, currency) VALUES
        (${id('kc')},     'received', ${'KURZKC' + r},  'Dodavatel CZ', '2031-06-09', 1000, 0, 'CZK'),
        -- Sobota: platí páteční kurz 24,50
        (${id('xts')},    'received', ${'KURZXTS' + r}, 'Dodavatel EU', '2031-06-07', 100,  0, 'XTS'),
        -- Bez kurzu: do součtu nesmí přijít jako 50 Kč
        (${id('bez')},    'received', ${'KURZBEZ' + r}, 'Dodavatel US', '2031-06-25', 50,   0, 'XTS'),
        (${id('vydana')}, 'issued',   ${'KURZVYD' + r}, '',             '2031-06-06', 10,   0, ' xts ')
    `;
    await sql`
      INSERT INTO receipts (vendor, total_amount, receipt_date, currency)
      VALUES (${'KURZ ' + r}, 2, '2031-06-05', 'XTS')
    `;
  });

  after(async () => {
    if (!sql) return;
    await sql`DELETE FROM accounting_invoices WHERE id LIKE ${'kurz\\_%\\_' + r}`;
    await sql`DELETE FROM receipts WHERE vendor = ${'KURZ ' + r}`;
    await sql`DELETE FROM kurzy_cnb WHERE mena = 'XTS'`;
    await sql.end();
  });

  test('koruny mají kurz 1 a varianty zápisu měny se sjednotí', async () => {
    const [v] = await sql`
      SELECT kurz_czk('CZK', '2031-06-07') AS czk, kurz_czk('', '2031-06-07') AS prazdna,
             kurz_czk('Kč', '2031-06-07') AS kc, mena_kod('€') AS euro, mena_kod(' usd ') AS usd
    `;
    assert.equal(Number(v.czk), 1);
    assert.equal(Number(v.prazdna), 1);
    assert.equal(Number(v.kc), 1);
    assert.equal(v.euro, 'EUR');
    assert.equal(v.usd, 'USD');
  });

  test('víkend bere poslední kurz před ním, starý kurz se nepoužije', async () => {
    const [v] = await sql`
      SELECT castka_czk(100, 'XTS', '2031-06-07') AS sobota,
             castka_czk(100, 'XTS', '2031-06-05') AS ctvrtek,
             castka_czk(100, 'XTS', '2031-06-04') AS pred_prvnim,
             castka_czk(100, 'XTS', '2031-06-22') AS po_dvou_tydnech
    `;
    assert.equal(Number(v.sobota), 2450);
    assert.equal(Number(v.ctvrtek), 2500);
    assert.equal(v.pred_prvnim, null);
    assert.equal(v.po_dvou_tydnech, null, 'kurz starší 14 dní znamená, že stažení chybí');
  });

  test('náklady jsou v korunách a doklad bez kurzu se nepřičte', async () => {
    const n = await naklady(sql, OD, DO);
    assert.equal(n.faktury, 1000 + 2450, '100 XTS × 24,50; 50 XTS bez kurzu chybí');
    assert.equal(n.uctenky, 50, '2 XTS × 25,00 (čtvrteční kurz)');
    assert.equal(n.pocty.faktury, 3, 'počet dokladů zůstává úplný');
    assert.deepEqual(n.meny, { cizi: 3, bezKurzu: 1 });
  });

  test('přehled řekne, že v součtu něco chybí', async () => {
    const n = await naklady(sql, OD, DO);
    assert.match(popisPrepoctu(n.meny), /^Bez kurzu ČNB, v součtu chybí: 1 doklad$/);
    assert.equal(popisPrepoctu({ cizi: 3, bezKurzu: 0 }), 'Cizí měna v Kč kurzem ČNB: 3 doklady');
    assert.equal(popisPrepoctu({ cizi: 5, bezKurzu: 0 }), 'Cizí měna v Kč kurzem ČNB: 5 dokladů');
    assert.equal(popisPrepoctu({ cizi: 0, bezKurzu: 0 }), '');
  });

  test('tržby se přepočítají stejně', async () => {
    const t = await trzby(sql, OD, DO);
    assert.equal(t.celkem, 245);
    assert.deepEqual(t.meny, { cizi: 1, bezKurzu: 0 });
  });

  test('doplněný kurz opraví součet bez zásahu do dokladu', async () => {
    await sql`INSERT INTO kurzy_cnb (mena, datum, kurz) VALUES ('XTS', '2031-06-25', 20)`;
    try {
      const n = await naklady(sql, OD, DO);
      assert.equal(n.faktury, 1000 + 2450 + 1000);
      assert.equal(n.meny.bezKurzu, 0);
    } finally {
      await sql`DELETE FROM kurzy_cnb WHERE mena = 'XTS' AND datum = '2031-06-25'`;
    }
  });

  test('stažení uloží kurzy a podruhé už ČNB neotravuje', async () => {
    // „Teď“ je 2032, takže potřebné roky jsou 2031 (doklady výš) a 2032.
    const ted = praha('2032-03-10', '15:00');
    const dotazy = [];
    const fetchImpl = async url => {
      dotazy.push(url);
      const rok = new URL(url).searchParams.get('rok');
      return new Response(`Datum|1 XTS\n09.03.${rok}|30,000\n10.03.${rok}|31,000\n`);
    };
    const stazene = [];
    try {
      const { stazeno } = await aktualizujKurzy(sql, { now: ted, fetchImpl });
      stazene.push(...stazeno);
      assert.ok(stazeno.includes(2031) && stazeno.includes(2032), `staženo: ${stazeno}`);
      assert.ok(dotazy.every(u => u.startsWith(`${URL_ROK}?rok=`)));

      const [k] = await sql`SELECT kurz FROM kurzy_cnb WHERE mena = 'XTS' AND datum = '2032-03-10'`;
      assert.equal(Number(k.kurz), 31);
      const [z] = await sql`SELECT posledni_datum FROM kurzy_cnb_stazeni WHERE rok = 2032`;
      assert.equal(z.posledni_datum.toISOString().slice(0, 10), '2032-03-10');

      dotazy.length = 0;
      const druhe = await aktualizujKurzy(sql, { now: praha('2032-03-10', '16:00'), fetchImpl });
      assert.equal(dotazy.filter(u => /rok=203[12]$/.test(u)).length, 0, 'dnešní kurz už má');
      stazene.push(...druhe.stazeno);
    } finally {
      await sql`DELETE FROM kurzy_cnb_stazeni WHERE rok = ANY(${[...new Set(stazene)]})`;
    }
  });

  test('výpadek ČNB nic nerozbije a neoznačí rok za stažený', async () => {
    const ted = praha('2033-03-10', '15:00');
    const fetchImpl = async () => new Response('Service Unavailable', { status: 503 });
    const { stazeno } = await aktualizujKurzy(sql, { now: ted, fetchImpl });
    assert.equal(stazeno.includes(2033), false);
    const z = await sql`SELECT 1 FROM kurzy_cnb_stazeni WHERE rok = 2033`;
    assert.equal(z.length, 0);
  });
});
