// Převod záznamů z Airtable na řádky pro databázi.
//
// Testuje se na skutečných odpovědích z API (test/fixtures/airtable.json),
// jen s vyměněnými URL příloh — ty expirují po dvou hodinách.
// Nepotřebuje běžící server ani databázi:
//   node --test test/airtable-map.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mapujPodklad, mapujMzdu, mapujExtraVydaj, mapujDokument, mapujPayroll,
  mapujUkol, mapujMereni,
  cisloMesice, rozdelLokalitu, cisloFakturyZNazvu, kategoriePrilohyMzdy,
  kategorieDokumentu, kontrolaUhrazeno, POLE,
} from '../src/airtable-map.js';

const fix = JSON.parse(readFileSync(new URL('./fixtures/airtable.json', import.meta.url), 'utf8'));

describe('drobné převody', () => {
  test('české měsíce — červen a červenec se nesmí splést', () => {
    assert.equal(cisloMesice('Leden'), 1);
    assert.equal(cisloMesice('Červen'), 6);
    assert.equal(cisloMesice('Červenec'), 7);
    assert.equal(cisloMesice('Prosinec'), 12);
    assert.equal(cisloMesice('nesmysl'), null);
  });

  test('lokalita se dělí na poslední čárce', () => {
    // „Singapore, Singapore" i „Nový Bor, Česká Republika"
    assert.deepEqual(rozdelLokalitu('Singapore, Singapore'), { city: 'Singapore', country: 'Singapore' });
    assert.deepEqual(rozdelLokalitu('Nový Bor, Česká Republika'), { city: 'Nový Bor', country: 'Česká Republika' });
    assert.deepEqual(rozdelLokalitu('Moskva'), { city: 'Moskva', country: '' });
  });

  test('číslo faktury z názvu PDF', () => {
    assert.equal(cisloFakturyZNazvu('Faktura_25240001.pdf'), '25240001');
    assert.equal(cisloFakturyZNazvu('Faktura_25250005 (1).pdf'), '25250005');
    assert.equal(cisloFakturyZNazvu('Faktura_25260004 .pdf'), '25260004');
    assert.equal(cisloFakturyZNazvu('neco jineho.pdf'), '');
  });

  test('kategorie přílohy mzdy podle názvu', () => {
    assert.equal(kategoriePrilohyMzdy('MH-04245610-2026-cervenec_radne_04.08.2026_Veta.xml'), 'epodani_cssz');
    assert.equal(kategoriePrilohyMzdy('Příkaz_k_úhradě_(s_kódem_QR_Platba) 2.pdf'), 'prikaz_k_uhrade');
    assert.equal(kategoriePrilohyMzdy('Výplatnice_mezd 07.pdf'), 'vyplatni_paska');
    assert.equal(kategoriePrilohyMzdy('Rekapitulace_mezd 2.pdf'), 'mzdovy_rozpis');
  });

  test('kategorie dokumentu se odvodí z názvu', () => {
    // V Airtable je vyplněná jen u tří záznamů z deseti
    assert.equal(kategorieDokumentu('Pracovní smlouva', null), 'Pracovní smlouva');
    assert.equal(kategorieDokumentu('DODATEK Č.1 PRACOVNÍ SMLOUVY', null), 'Dodatek smlouvy');
    assert.equal(kategorieDokumentu('Přihláška do registru zaměstnavatelů', null), 'Přihláška');
    assert.equal(kategorieDokumentu('Něco jiného', null), '');
    assert.equal(kategorieDokumentu('Cokoliv', 'Mzdový výměr'), 'Mzdový výměr', 'vyplněná kategorie má přednost');
  });
});

describe('fakturační podklady', () => {
  test('vícehodnotová zakázka se nerozebírá z formule Označení', () => {
    const p = mapujPodklad(fix.podklady[0]);
    assert.ok(p.projekty.length >= 3, `čekal jsem 3+ kódů, mám ${JSON.stringify(p.projekty)}`);
    assert.ok(p.projekty.every(k => k && !k.includes('|')), 'kódy nesmí nést zbytky formule');
    assert.ok(p.totalAmount > 0);
    assert.match(p.reportDate, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('podklad s jednou zakázkou', () => {
    const p = mapujPodklad(fix.podklady[1]);
    assert.equal(p.projekty.length, 1);
    assert.equal(p.status, 'odeslano');
  });

  test('dvě lokality se rozpadnou na město a zemi', () => {
    const p = mapujPodklad(fix.podklady[2]);
    assert.ok(p.lokality.length >= 2);
    for (const l of p.lokality) {
      assert.ok(l.city, 'město nesmí být prázdné');
      assert.ok(!l.city.includes(','), 'město nesmí obsahovat čárku');
    }
  });

  test('faktura se pozná z názvu přílohy a PDF se nestahuje dvakrát', () => {
    for (const rec of fix.podklady) {
      const p = mapujPodklad(rec);
      assert.match(p.invoiceNumber, /^\d{8}$/, `číslo faktury z ${JSON.stringify(p.title)}`);
      // příloha faktury je vedená zvlášť, ne mezi rozpisy a doklady
      assert.ok(!p.prilohy.some(a => a.kategorie === 'vystavena_faktura'));
    }
  });
});

describe('mzdový rozpis', () => {
  test('měsíc a rok dají první den měsíce', () => {
    const m = mapujMzdu(fix.mzdy[1]);
    assert.equal(m.period, '2024-05-01');
    assert.equal(m.paid, true);
  });

  test('XML pro ČSSZ se pozná a nezahodí', () => {
    const m = mapujMzdu(fix.mzdy[0]);
    const xml = m.prilohy.filter(p => p.kategorie === 'epodani_cssz');
    assert.ok(xml.length > 0, 'balíček obsahuje e-podání, které se musí naimportovat');
    assert.ok(m.prilohy.some(p => p.kategorie === 'vyplatni_paska'));
  });

  test('dopočtené UHRAZENO sedí na Airtable u všech 27 měsíců', () => {
    // Tohle je pojistka pro generovaný sloupec v databázi: kdyby se vzorec
    // lišil byť u jednoho měsíce, kontrolní součet po migraci nevyjde a
    // vypadalo by to jako chyba importu.
    let nesedi = [];
    for (const m of fix.mzdyVse) {
      const kontrola = kontrolaUhrazeno({
        net: m.fldIqeQmZaGzDJIM4 ?? 0, social: m.fld0aNTM8i5WK2FYU ?? 0,
        health: m.fldw3XK3322IyV6qW ?? 0, garnishment: m.fldfVc3MzY5wGxxJr ?? 0,
        tax: m.fldHPfgoAEyg7tUnx ?? 0, insolvency: m.fldM6wkPJrX3XzFm2 ?? 0,
        accidentInsurance: m.fldGNcaeCeeMOlLtn ?? 0,
        uhrazenoAirtable: m.fld0j33q7oymWKHnt ?? 0,
      });
      if (!kontrola.sedi) nesedi.push(`${m._id}: dopočet ${kontrola.dopocet} vs ${m.fld0j33q7oymWKHnt}`);
    }
    assert.deepEqual(nesedi, [], 'vzorec UHRAZENO se u některých měsíců rozchází');
  });

  test('kontrolní součty sedí na rollup z Airtable', () => {
    const uhrazeno = fix.mzdyVse.reduce((a, m) => a + (m.fld0j33q7oymWKHnt ?? 0), 0);
    assert.equal(Math.round(uhrazeno * 100) / 100, fix.soucty.mzdyUhrazeno);
    assert.equal(fix.soucty.mzdyUhrazeno, 1036044, 'Výdaje z přehledové tabulky');
    assert.equal(fix.soucty.podkladyCelkem, 1488721.70, 'Příjmy z přehledové tabulky');
    assert.equal(fix.soucty.podkladuPocet, 31);
    assert.equal(fix.soucty.mzdyPocet, 27);
  });
});

describe('platby mimo mzdu', () => {
  test('extra výdaj jde vždy jako záloha', () => {
    // Zálohu od proplaceného nákladu nejde z dat poznat — u dvanácti záznamů
    // je poznámka prázdná. Špatné zařazení by posunulo hrubý zisk, takže se
    // hádat nebude a druh se překlikne v UI.
    const v = mapujExtraVydaj({
      id: 'rec1', createdTime: '2026-07-27T20:06:41.000Z',
      cellValuesByFieldId: { fldz9xhiT1oSKQziC: '2026-07-27', fldC5KInyTYPwxjJx: 20000, fldD5wjw6j1UZMydY: 'Babicka' },
    });
    assert.equal(v.kind, 'zaloha');
    assert.equal(v.amount, 20000);
    assert.equal(v.paidOn, '2026-07-27');
  });

  test('Heříkova mzdová tabulka se rozplete na mzdy a nákupy', () => {
    const nakup = mapujPayroll({
      id: 'recN', cellValuesByFieldId: {
        fld9XvhXBN6VKfKFO: 19653, fldANpFgwBzqgKvYw: 'Tablet',
        fldGoBhsBR3ors3fb: '2025-09-01',
      },
    });
    assert.equal(nakup.druh, 'naklad');
    assert.equal(nakup.amount, 19653);
    assert.equal(nakup.description, 'Tablet');

    const mzda = mapujPayroll({
      id: 'recM', cellValuesByFieldId: {
        fldd7enwrQ4sIPp1r: 56, fldUPt2gygHqtOrDH: 11400, fldGoBhsBR3ors3fb: '2025-08-01',
        fldYY5tGdxEeLENv3: { linkedRecordIds: ['recX'], valuesByLinkedRecordId: { recX: [500] } },
      },
    });
    assert.equal(mzda.druh, 'mzda');
    assert.equal(mzda.hours, 56);
    assert.equal(mzda.hourlyRate, 500);
    assert.equal(mzda.earned, 28000, '56 h × 500 Kč');
    assert.equal(mzda.gross, 11400);

    // Prázdný řádek se nemá tvářit ani jako mzda, ani jako nákup
    assert.equal(mapujPayroll({ id: 'recP', cellValuesByFieldId: {} }).druh, 'prazdny');
  });
});

describe('úkoly a měření času', () => {
  const F = POLE;

  test('priorita „6 | Needed" se rozdělí na číslo a popis', () => {
    // Číslo řadí, text popisuje. Kdyby se ukládal jen text, nešlo by
    // podle priority seřadit; kdyby jen číslo, ztratil by se význam.
    const u = mapujUkol({ id: 'recU', cellValuesByFieldId: {
      [F.task.priorita]: { id: 'sel1', name: '6 | Needed' },
      [F.task.souhrn]: 'Oprava exportu',
    }});
    assert.equal(u.priority, 6);
    assert.equal(u.priorityLabel, '6 | Needed');
    assert.equal(u.summary, 'Oprava exportu');
  });

  test('priorita mimo rozsah 1–10 se zahodí, popis zůstane', () => {
    const u = mapujUkol({ id: 'recU', cellValuesByFieldId: {
      [F.task.priorita]: { id: 'sel1', name: '42 | Nesmysl' },
    }});
    assert.equal(u.priority, null);
    assert.equal(u.priorityLabel, '42 | Nesmysl');
  });

  test('neznámý stav spadne na todo, ne na chybu', () => {
    assert.equal(mapujUkol({ id: 'r', cellValuesByFieldId: {
      [F.task.status]: { id: 's', name: 'Něco Nového' } }}).status, 'todo');
    assert.equal(mapujUkol({ id: 'r', cellValuesByFieldId: {
      [F.task.status]: { id: 's', name: 'In progress' } }}).status, 'in_progress');
  });

  test('nadřazený úkol se přenese jako Airtable ID k dořešení druhým průchodem', () => {
    const u = mapujUkol({ id: 'recDite', cellValuesByFieldId: {
      [F.task.nadrazeny]: [{ id: 'recRodic', name: 'GUK-1' }],
    }});
    assert.equal(u.nadrazenyAirtableId, 'recRodic');
  });

  test('měření bez konce znamená běžící stopky', () => {
    const m = mapujMereni({ id: 'recM', cellValuesByFieldId: {
      [F.cas.start]: '2026-03-02T08:00:00.000Z',
    }});
    assert.equal(m.startedAt, '2026-03-02T08:00:00.000Z');
    assert.equal(m.endedAt, null);
  });

  test('Meeting se odliší od práce na úkolu', () => {
    const typ = v => mapujMereni({ id: 'r', cellValuesByFieldId: { [F.cas.typ]: v } }).kind;
    assert.equal(typ({ id: 's', name: 'Meeting' }), 'meeting');
    assert.equal(typ({ id: 's', name: 'Task' }), 'task');
    assert.equal(typ(undefined), 'task');
  });
});
