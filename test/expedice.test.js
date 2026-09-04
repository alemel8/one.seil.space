// Jednotkový test ranní expedice do skladu — běží bez databáze i serveru:
//
//   node --test test/expedice.test.js
//
// Hlídá tři věci, na kterých stojí celý automat: že se číslo zásilky ve všech
// zápisech sloučí na jeden klíč, že řádek pro sklad má přesně dohodnutý tvar
// „kód - 2x - název", a že se okno i obnova po restartu rozhodují správně
// (pátek večer → pondělí, odeslaný e-mail se nikdy neposílá podruhé).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatujCisloZasilky, jeMultipack, jePseudoPolozka, jeVOkne, normalizujCisloZasilky,
  prazskyCas, radekPolozky, rozhodniBeh, seskupPodleZasilek, sestavEmail, zasilkyPlural,
} from '../src/expedice.js';

describe('číslo zásilky', () => {
  test('různé zápisy téhož čísla dají jeden klíč', () => {
    for (const zapis of ['Z 864 684', 'Z864684', ' z864684 ', '864684', '864 684']) {
      assert.equal(normalizujCisloZasilky(zapis), 'Z864684', `zápis ${zapis}`);
    }
  });

  test('volný text z Airtable není číslo zásilky', () => {
    // Historické objednávky mají v tracking_number, co kdo napsal rukou.
    for (const nesmysl of ['', null, undefined, 'ručně', 'předáno osobně', 'Z12345']) {
      assert.equal(normalizujCisloZasilky(nesmysl), '', `hodnota ${nesmysl}`);
    }
  });

  test('zobrazení po trojicích zleva, osamocená číslice se přilepí', () => {
    assert.equal(formatujCisloZasilky('Z864684'), 'Z 864 684');
    assert.equal(formatujCisloZasilky('Z1234567890'), 'Z 123 456 7890');
    assert.equal(formatujCisloZasilky('Z12345678'), 'Z 123 456 78');
    // Idempotence: už naformátované číslo projde beze změny
    assert.equal(formatujCisloZasilky('Z 864 684'), 'Z 864 684');
    assert.equal(formatujCisloZasilky(''), '');
  });
});

describe('položky objednávky', () => {
  test('dopočtené řádky e-shopu se do skladu neposílají', () => {
    for (const sku of ['SLEVA-REG', 'DOPRAVA', 'DOBIRKA']) {
      assert.equal(jePseudoPolozka(sku), true, sku);
    }
    assert.equal(jePseudoPolozka('T03065'), false);
    assert.equal(jePseudoPolozka(''), false);
  });

  test('multipack se pozná podle prefixu', () => {
    // V katalogu jsou obě řady: MC pro inkousty, MT pro tonery.
    assert.equal(jeMultipack('MT0603'), true);
    assert.equal(jeMultipack('MC0319'), true);
    assert.equal(jeMultipack('T03065'), false);
    assert.equal(jeMultipack('C05142'), false);
    assert.equal(jeMultipack(''), false);
  });

  test('řádek má přesně dohodnutý tvar', () => {
    const r = radekPolozky({ supplier_code: '11208', quantity: 2, name: 'Canon CRG-737' });
    assert.equal(r.text, '11208 - 2x - Canon CRG-737');
    assert.equal(r.varovani, null);
  });

  test('bez kódu dodavatele se tiskne SKU a řádek si nese varování', () => {
    const r = radekPolozky({ supplier_code: '', sku: 'T03065', quantity: 1, name: 'Canon CRG-737' });
    assert.equal(r.text, 'T03065 - 1x - Canon CRG-737');
    assert.equal(r.varovani, 'chybí kód dodavatele');
  });

  test('multipack a prázdná položka se nerozbijí', () => {
    assert.equal(radekPolozky({ supplier_code: '', sku: 'MT0603', quantity: 1, name: 'Sada' }).varovani,
      'multipack, chybí kód dodavatele');
    assert.equal(radekPolozky({ supplier_code: '10952', sku: 'MT0603', quantity: 1, name: 'Sada' }).varovani,
      'multipack');
    // Objednávky přenesené z Airtable mají prázdné sku i cenu
    assert.equal(radekPolozky({ sku: '', name: 'Toner', quantity: 1 }).text, '? - 1x - Toner');
  });
});

describe('seskupení podle zásilek', () => {
  const objednavky = [
    { id: 'o1', order_number: '10234', tracking_number: 'Z 864 684' },
    { id: 'o2', order_number: '10235', tracking_number: 'Z864684' },
    { id: 'o3', order_number: '10236', tracking_number: 'ručně' },
  ];
  const polozky = new Map([
    ['o1', [{ supplier_code: '11208', sku: 'T1', name: 'Canon CRG-737', quantity: 2 },
            { supplier_code: '', sku: 'DOPRAVA', name: 'Doprava', quantity: 1 }]],
    ['o2', [{ supplier_code: '13409', sku: 'T2', name: 'HP 278', quantity: 1 }]],
    ['o3', [{ supplier_code: '99999', sku: 'T3', name: 'Nikdy', quantity: 1 }]],
  ]);

  test('stejná zásilka ve dvou zápisech je jeden nadpis', () => {
    const skupiny = seskupPodleZasilek(objednavky, polozky);
    assert.equal(skupiny.length, 1);
    assert.equal(skupiny[0].zobrazeni, 'Z 864 684');
    assert.deepEqual(skupiny[0].orderNumbers, ['10234', '10235']);
  });

  test('doprava se nevychystává, pořadí položek zůstává', () => {
    const [skupina] = seskupPodleZasilek(objednavky, polozky);
    assert.deepEqual(skupina.radky.map(r => r.text),
      ['11208 - 2x - Canon CRG-737', '13409 - 1x - HP 278']);
  });
});

describe('pražský čas a okno odeslání', () => {
  // Fixní okamžiky v UTC — test nesmí záviset na TZ stroje ani kontejneru.
  test('letní čas: 04:59 UTC je v Praze 06:59', () => {
    const c = prazskyCas(new Date('2026-09-04T04:59:00Z'));
    assert.deepEqual([c.datum, c.den, c.hodina], ['2026-09-04', 5, 6]);
  });

  test('letní čas: 05:00 UTC je v Praze 07:00', () => {
    assert.equal(prazskyCas(new Date('2026-09-04T05:00:00Z')).hodina, 7);
  });

  test('zimní čas: 06:00 UTC je v Praze 07:00', () => {
    assert.equal(prazskyCas(new Date('2026-12-04T06:00:00Z')).hodina, 7);
  });

  test('po půlnoci pražského času už platí další den', () => {
    assert.equal(prazskyCas(new Date('2026-09-04T22:30:00Z')).datum, '2026-09-05');
  });

  test('víkend oknem neprojde, takže pátek jde až v pondělí', () => {
    assert.equal(jeVOkne(prazskyCas(new Date('2026-09-05T08:00:00Z'))), false); // sobota
    assert.equal(jeVOkne(prazskyCas(new Date('2026-09-06T08:00:00Z'))), false); // neděle
    assert.equal(jeVOkne(prazskyCas(new Date('2026-09-07T05:00:00Z'))), true);  // pondělí 07:00
  });

  test('okno nemá horní hranici — po výpadku se pošle i odpoledne', () => {
    assert.equal(jeVOkne({ den: 1, hodina: 6 }), false);
    assert.equal(jeVOkne({ den: 1, hodina: 7 }), true);
    assert.equal(jeVOkne({ den: 5, hodina: 15 }), true);
  });
});

describe('rozhodnutí o běhu', () => {
  const now = new Date('2026-09-07T07:00:00Z');
  const pred = (minut) => new Date(now.getTime() - minut * 60_000);

  test('dnes ještě neběželo → založit', () => {
    assert.equal(rozhodniBeh({ dnesni: null, now }).akce, 'zalozit');
  });

  test('doběhlý den se neopakuje', () => {
    for (const status of ['odeslano', 'prazdno']) {
      assert.equal(rozhodniBeh({ dnesni: { status, started_at: pred(60) }, now }).akce, 'nic');
    }
  });

  test('rozběhnutý běh se nechá být', () => {
    assert.equal(rozhodniBeh({ dnesni: { status: 'probiha', started_at: pred(5) }, now }).akce, 'nic');
    assert.equal(rozhodniBeh({ dnesni: { status: 'probiha', started_at: pred(99) }, now, bezi: true }).akce, 'nic');
  });

  test('zamrzlý běh s odeslaným e-mailem se jen dopíše, neposílá podruhé', () => {
    const dnesni = { status: 'probiha', started_at: pred(31), email_sent_at: pred(30) };
    assert.equal(rozhodniBeh({ dnesni, now }).akce, 'dokoncit');
  });

  test('zamrzlý běh bez e-mailu je chyba k zopakování', () => {
    const dnesni = { status: 'probiha', started_at: pred(31), email_sent_at: null };
    const { akce, duvod } = rozhodniBeh({ dnesni, now });
    assert.equal(akce, 'oznacit-chybu');
    assert.match(duvod, /restart/i);
  });

  test('backoff se prodlužuje s každým pokusem', () => {
    assert.equal(rozhodniBeh({ dnesni: { status: 'chyba', attempt: 1, started_at: pred(9) }, now }).akce, 'nic');
    assert.equal(rozhodniBeh({ dnesni: { status: 'chyba', attempt: 1, started_at: pred(11) }, now }).akce, 'opakovat');
    assert.equal(rozhodniBeh({ dnesni: { status: 'chyba', attempt: 3, started_at: pred(25) }, now }).akce, 'nic');
    assert.equal(rozhodniBeh({ dnesni: { status: 'chyba', attempt: 3, started_at: pred(31) }, now }).akce, 'opakovat');
  });

  test('po šesti pokusech si běh řekne o obsluhu', () => {
    assert.equal(rozhodniBeh({ dnesni: { status: 'chyba', attempt: 6, started_at: pred(999) }, now }).akce, 'nic');
  });
});

describe('e-mail skladu', () => {
  const skupiny = [{
    norm: 'Z864684', zobrazeni: 'Z 864 684', orderNumbers: ['10234'],
    radky: [
      radekPolozky({ supplier_code: '11208', quantity: 2, name: 'Canon CRG-737' }),
      radekPolozky({ supplier_code: '13409', quantity: 1, name: 'HP 278' }),
    ],
  }];

  test('nadpisem je tučné číslo zásilky, pod ním řádky položek', () => {
    const { html } = sestavEmail({
      shopName: 'Toneráček', obdobiOd: null,
      obdobiDo: new Date('2026-09-07T05:00:00Z'), skupiny,
    });
    assert.match(html, /<strong>Z 864 684<\/strong>/);
    const nadpis = html.indexOf('Z 864 684');
    const radek  = html.indexOf('11208 - 2x - Canon CRG-737');
    assert.ok(nadpis > -1 && radek > nadpis, 'nadpis musí být před položkami');
    assert.match(html, /13409 - 1x - HP 278/);
  });

  test('název položky se escapuje', () => {
    const s = [{ ...skupiny[0], radky: [radekPolozky({ supplier_code: '1', quantity: 1, name: 'HP <A&B>' })] }];
    const { html } = sestavEmail({ shopName: 'T', obdobiDo: new Date('2026-09-07T05:00:00Z'), skupiny: s });
    assert.match(html, /HP &lt;A&amp;B&gt;/);
    assert.doesNotMatch(html, /HP <A/);
  });

  test('předmět nese počet zásilek ve správném pádu', () => {
    const predmet = (n) => sestavEmail({
      shopName: 'Toneráček', obdobiDo: new Date('2026-09-07T05:00:00Z'),
      skupiny: Array.from({ length: n }, () => ({ ...skupiny[0], radky: [] })),
    }).subject;
    assert.match(predmet(1), /1 zásilka/);
    assert.match(predmet(3), /3 zásilky/);
    assert.match(predmet(7), /7 zásilek/);
    assert.equal(zasilkyPlural(0), 'zásilek');
  });

  test('období se uvede, jen když je odkud počítat', () => {
    const s = { shopName: 'T', obdobiDo: new Date('2026-09-07T05:00:00Z'), skupiny };
    assert.match(sestavEmail({ ...s, obdobiOd: new Date('2026-09-04T05:01:00Z') }).html, /za období od/);
    assert.doesNotMatch(sestavEmail({ ...s, obdobiOd: null }).html, /za období od/);
  });

  test('objednávka bez položek se v e-mailu přizná, místo aby zmizela', () => {
    const s = [{ ...skupiny[0], radky: [] }];
    const { html } = sestavEmail({ shopName: 'T', obdobiDo: new Date('2026-09-07T05:00:00Z'), skupiny: s });
    assert.match(html, /bez položek/);
  });
});
