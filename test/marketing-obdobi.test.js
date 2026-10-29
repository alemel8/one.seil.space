// Jednotkový test období marketingového přehledu — běží bez databáze i serveru:
//
//   node --test test/marketing-obdobi.test.js
//
// Hlídá, že presety dávají správný uzavřený interval s pevným „dnes“ — hlavně
// konce měsíců (únor, přestupný únor, prosinec, přechod roku), které se musí
// počítat řetězcově a ne přes Date v pásmu procesu — že neplatné vlastní
// období nespadne, ale vrátí tento měsíc s vysvětlením v popisku, a že výčet
// dní na neplatnou mez vrátí prázdné pole místo smyčky do přetečení Date.
//
// Výsledek nesmí záviset na časovém pásmu stroje; spouštět i s TZ=Europe/Prague
// a TZ=Pacific/Kiritimati (tam právě selhávalo `new Date(y, m, 0).toISOString()`).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ROZDIL_DNI, PRESETY, popisMesice, posledniDenMesice, prvniDenMesice,
  rozdilDni, rozsahCesky, vyctiDny, vyhodnotObdobi,
} from '../src/marketing/obdobi.js';
import { prazskyCas } from '../src/prazsky-cas.js';

describe('kalendářní pomocníci', () => {
  test('první a poslední den měsíce řetězcově, včetně přestupných únorů', () => {
    assert.equal(prvniDenMesice('2026-02-10'), '2026-02-01');
    assert.equal(posledniDenMesice('2026-02-10'), '2026-02-28');
    assert.equal(posledniDenMesice('2028-02-01'), '2028-02-29');
    assert.equal(posledniDenMesice('2000-02-15'), '2000-02-29');  // dělitelný 400 → přestupný
    assert.equal(posledniDenMesice('2100-02-15'), '2100-02-28');  // dělitelný 100 → nepřestupný
    assert.equal(posledniDenMesice('2026-12-31'), '2026-12-31');
    assert.equal(posledniDenMesice('2026-01-31'), '2026-01-31');
    assert.equal(posledniDenMesice('2026-04-15'), '2026-04-30');
    assert.equal(posledniDenMesice('2026-11-01'), '2026-11-30');
  });

  test('rozdíl dní přes změnu času je celý den', () => {
    assert.equal(rozdilDni('2026-03-28', '2026-03-30'), 2);   // změna na letní čas 29. 3.
    assert.equal(rozdilDni('2026-10-24', '2026-10-26'), 2);   // zpět na zimní 25. 10.
    assert.equal(rozdilDni('2026-10-29', '2026-10-29'), 0);
    assert.equal(rozdilDni('2026-10-29', '2026-10-28'), -1);
    assert.equal(rozdilDni('2025-12-31', '2026-01-01'), 1);
  });

  test('výčet dní je uzavřený interval, obrácený rozsah je prázdný', () => {
    assert.deepEqual(vyctiDny('2026-02-27', '2026-03-01'), ['2026-02-27', '2026-02-28', '2026-03-01']);
    assert.deepEqual(vyctiDny('2026-10-29', '2026-10-29'), ['2026-10-29']);
    assert.deepEqual(vyctiDny('2026-10-30', '2026-10-29'), []);
  });

  test('výčet dní na neplatnou mez vrátí prázdné pole, ne smyčku do přetečení Date', () => {
    assert.deepEqual(vyctiDny('2026-10-01', '9999-99-99'), []);
    assert.deepEqual(vyctiDny('2026-13-01', '2026-13-05'), []);
    assert.deepEqual(vyctiDny('2026-02-30', '2026-03-01'), []);
    assert.deepEqual(vyctiDny('', '2026-10-05'), []);
    assert.deepEqual(vyctiDny(undefined, undefined), []);
    assert.deepEqual(vyctiDny('včera', 'dnes'), []);
    // datum s časem z formuláře se ořízne na den
    assert.deepEqual(vyctiDny('2026-10-01T10:00:00', '2026-10-02T00:00:00'), ['2026-10-01', '2026-10-02']);
  });

  test('český popis měsíce a rozsahu', () => {
    assert.equal(popisMesice('2026-10-29'), 'říjen 2026');
    assert.equal(popisMesice('2026-01-01'), 'leden 2026');
    assert.equal(rozsahCesky('2026-09-30', '2026-10-29'), '30. 9. – 29. 10. 2026');
    assert.equal(rozsahCesky('2025-12-12', '2026-01-10'), '12. 12. 2025 – 10. 1. 2026');
    assert.equal(rozsahCesky('2026-10-29', '2026-10-29'), '29. 10. 2026');
  });
});

describe('presety', () => {
  test('seznam presetů je ten, který zná URL', () => {
    assert.deepEqual(PRESETY, ['tento-mesic', 'minuly-mesic', '30-dni', 'vlastni']);
  });

  test('tento měsíc: od prvního do dneška', () => {
    assert.deepEqual(vyhodnotObdobi({ obdobi: 'tento-mesic' }, '2026-10-29'),
      { od: '2026-10-01', do: '2026-10-29', preset: 'tento-mesic', popis: 'říjen 2026' });
    // První den měsíce je jednodenní období, ne prázdné.
    assert.deepEqual(vyhodnotObdobi({ obdobi: 'tento-mesic' }, '2026-03-01'),
      { od: '2026-03-01', do: '2026-03-01', preset: 'tento-mesic', popis: 'březen 2026' });
    assert.deepEqual(vyhodnotObdobi({ obdobi: 'tento-mesic' }, '2026-12-31'),
      { od: '2026-12-01', do: '2026-12-31', preset: 'tento-mesic', popis: 'prosinec 2026' });
  });

  test('minulý měsíc: celý, i když má únor 28 nebo 29 dní', () => {
    assert.deepEqual(vyhodnotObdobi({ obdobi: 'minuly-mesic' }, '2026-03-01'),
      { od: '2026-02-01', do: '2026-02-28', preset: 'minuly-mesic', popis: 'únor 2026' });
    assert.deepEqual(vyhodnotObdobi({ obdobi: 'minuly-mesic' }, '2028-03-01'),
      { od: '2028-02-01', do: '2028-02-29', preset: 'minuly-mesic', popis: 'únor 2028' });
    assert.deepEqual(vyhodnotObdobi({ obdobi: 'minuly-mesic' }, '2026-12-31'),
      { od: '2026-11-01', do: '2026-11-30', preset: 'minuly-mesic', popis: 'listopad 2026' });
    assert.deepEqual(vyhodnotObdobi({ obdobi: 'minuly-mesic' }, '2026-10-29'),
      { od: '2026-09-01', do: '2026-09-30', preset: 'minuly-mesic', popis: 'září 2026' });
  });

  test('minulý měsíc v lednu je prosinec loňska', () => {
    assert.deepEqual(vyhodnotObdobi({ obdobi: 'minuly-mesic' }, '2026-01-15'),
      { od: '2025-12-01', do: '2025-12-31', preset: 'minuly-mesic', popis: 'prosinec 2025' });
  });

  test('posledních 30 dní včetně dneška', () => {
    assert.deepEqual(vyhodnotObdobi({ obdobi: '30-dni' }, '2026-10-29'), {
      od: '2026-09-30', do: '2026-10-29', preset: '30-dni',
      popis: 'posledních 30 dní (30. 9. – 29. 10. 2026)',
    });
    const r = vyhodnotObdobi({ obdobi: '30-dni' }, '2026-03-01');
    assert.deepEqual([r.od, r.do], ['2026-01-31', '2026-03-01']);
    assert.equal(vyctiDny(r.od, r.do).length, 30);
    // Přes přelom roku nese popis oba roky.
    assert.deepEqual(vyhodnotObdobi({ obdobi: '30-dni' }, '2026-01-10'), {
      od: '2025-12-12', do: '2026-01-10', preset: '30-dni',
      popis: 'posledních 30 dní (12. 12. 2025 – 10. 1. 2026)',
    });
  });

  test('neznámý nebo chybějící preset je tento měsíc', () => {
    assert.equal(vyhodnotObdobi({ obdobi: 'cokoli' }, '2026-10-29').preset, 'tento-mesic');
    assert.equal(vyhodnotObdobi({}, '2026-10-29').preset, 'tento-mesic');
    assert.equal(vyhodnotObdobi(undefined, '2026-10-29').od, '2026-10-01');
  });

  test('bez „dnes“ se vezme pražský dnešek', () => {
    const r = vyhodnotObdobi({ obdobi: 'tento-mesic' });
    assert.equal(r.do, prazskyCas().datum);
    assert.equal(r.od, `${r.do.slice(0, 7)}-01`);
  });

  test('nesmyslné „dnes“ je chyba programátora, ne tichý fallback', () => {
    assert.throws(() => vyhodnotObdobi({ obdobi: 'tento-mesic' }, 'včera'), /YYYY-MM-DD/);
  });
});

describe('vlastní období', () => {
  test('platný rozsah projde beze změny, i jednodenní', () => {
    assert.deepEqual(vyhodnotObdobi({ obdobi: 'vlastni', od: '2026-10-01', do: '2026-10-15' }, '2026-10-29'),
      { od: '2026-10-01', do: '2026-10-15', preset: 'vlastni', popis: '1. 10. – 15. 10. 2026' });
    assert.deepEqual(vyhodnotObdobi({ obdobi: 'vlastni', od: '2026-10-05', do: '2026-10-05' }, '2026-10-29'),
      { od: '2026-10-05', do: '2026-10-05', preset: 'vlastni', popis: '5. 10. 2026' });
  });

  test('datum s časem z formuláře se ořízne na den', () => {
    const r = vyhodnotObdobi({ obdobi: 'vlastni', od: '2026-10-01T00:00:00', do: '2026-10-02T23:59:59' }, '2026-10-29');
    assert.deepEqual([r.od, r.do, r.preset], ['2026-10-01', '2026-10-02', 'vlastni']);
  });

  test('strop rozsahu: přesně 400 dní rozdílu projde, 401 už ne', () => {
    assert.equal(MAX_ROZDIL_DNI, 400);
    const ok = vyhodnotObdobi({ obdobi: 'vlastni', od: '2025-09-24', do: '2026-10-29' }, '2026-10-29');
    assert.equal(rozdilDni(ok.od, ok.do), 400);
    assert.equal(ok.preset, 'vlastni');

    const moc = vyhodnotObdobi({ obdobi: 'vlastni', od: '2025-09-23', do: '2026-10-29' }, '2026-10-29');
    assert.deepEqual([moc.od, moc.do, moc.preset], ['2026-10-01', '2026-10-29', 'tento-mesic']);
    assert.match(moc.popis, /^říjen 2026 — vlastní období se nepoužilo: rozsah je delší než 400 dní$/);
  });

  test('začátek po konci padá na tento měsíc s vysvětlením', () => {
    const r = vyhodnotObdobi({ obdobi: 'vlastni', od: '2026-10-20', do: '2026-10-10' }, '2026-10-29');
    assert.deepEqual([r.od, r.do, r.preset], ['2026-10-01', '2026-10-29', 'tento-mesic']);
    assert.match(r.popis, /začátek je po konci/);
  });

  test('neplatné nebo chybějící datum (30. únor, prázdné, text) padá na tento měsíc', () => {
    for (const q of [
      { od: '2026-02-30', do: '2026-03-01' },
      { od: '', do: '2026-03-01' },
      { od: '2026-02-01' },
      { od: 'včera', do: 'dnes' },
      {},
    ]) {
      const r = vyhodnotObdobi({ obdobi: 'vlastni', ...q }, '2026-03-01');
      assert.deepEqual([r.od, r.do, r.preset], ['2026-03-01', '2026-03-01', 'tento-mesic'], JSON.stringify(q));
      assert.match(r.popis, /^březen 2026 — vlastní období se nepoužilo: chybí nebo není platné datum/);
    }
  });
});
