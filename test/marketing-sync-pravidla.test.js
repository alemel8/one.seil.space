// Jednotkový test rozhodovacích pravidel nočního marketingového syncu —
// běží bez databáze i serveru:
//
//   node --test test/marketing-sync-pravidla.test.js
//
// Hlídá matici obnovy po pádu (hotovo → nic, zaseklý běh → chyba, trvalá
// chyba → čeká na obsluhu, backoff 10/20/30 min od zápisu chyby, nejvýš
// 6 pokusů), okno dat (14 dní zpět po včerejšek, první běh 400 dní zpět nebo
// od `since`, nikdy před `since`), dělení okna po kusech i na neplatnou mez
// a práh upozornění na PNO. Když je v repozitáři migrace 042, ověřuje se,
// že sloupce, ze kterých se rozhoduje (`started_at`, `finished_at`, `since`,
// `last_ok_at`), opravdu existují; bez ní se ten test přeskočí.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  KONSTANTY, TRVALE_HTTP, jeTrvalaChyba, jeVOkneSyncu, oknoSyncu, rozdelOkno,
  rozhodniAlertPno, rozhodniBehSyncu,
} from '../src/marketing/sync-pravidla.js';
import { blokTabulky, nactiMigraci042, sloupceTabulky } from './fixtures/marketing/migrace-042.js';

const NYNI = new Date('2026-10-29T05:30:00Z');
const minutZpet = (min) => new Date(NYNI.getTime() - min * 60_000);

describe('konstanty a okno času', () => {
  test('konstanty podle plánu D5', () => {
    assert.deepEqual({ ...KONSTANTY }, { prvniHodina: 5, zaseknutyMin: 30, maxPokusu: 6, krokBackoffMin: 10, prepisDni: 14, prvniBehMaxDni: 400 });
    assert.ok(Object.isFrozen(KONSTANTY));
    assert.deepEqual(TRVALE_HTTP, [400, 401, 403]);
  });

  test('sync smí od páté ráno, každý den v týdnu', () => {
    assert.equal(jeVOkneSyncu({ hodina: 4 }), false);
    assert.equal(jeVOkneSyncu({ hodina: 5 }), true);
    assert.equal(jeVOkneSyncu({ hodina: 23 }), true);
    assert.equal(jeVOkneSyncu({ hodina: 0 }), false);
  });

  test('trvalá chyba: příznak adaptéru nebo HTTP 400/401/403', () => {
    assert.equal(jeTrvalaChyba({ status: 401 }), true);
    assert.equal(jeTrvalaChyba({ status: 403 }), true);
    assert.equal(jeTrvalaChyba({ status: 400 }), true);
    assert.equal(jeTrvalaChyba({ status: 429 }), false);
    assert.equal(jeTrvalaChyba({ status: 500 }), false);
    assert.equal(jeTrvalaChyba({ status: 0 }), false);
    assert.equal(jeTrvalaChyba({ permanent: true }), true);
    assert.equal(jeTrvalaChyba(new Error('x')), false);
    assert.equal(jeTrvalaChyba(null), false);
  });

  test('sloupce, ze kterých se rozhoduje, jsou v migraci 042 (když už je v repozitáři)', (t) => {
    const migrace = nactiMigraci042();
    if (!migrace) { t.skip('migrations/042_marketing.sql tu ještě není — píše ji jiný krok'); return; }
    const behy = sloupceTabulky(blokTabulky(migrace, 'marketing_sync_runs'));
    for (const s of ['status', 'attempt', 'permanent', 'started_at', 'finished_at', 'run_date', 'kind']) assert.ok(behy[s], `marketing_sync_runs.${s}`);
    const zdroje = sloupceTabulky(blokTabulky(migrace, 'marketing_sources'));
    for (const s of ['active', 'since', 'last_ok_at', 'last_run_at', 'last_error']) assert.ok(zdroje[s], `marketing_sources.${s}`);
  });
});

describe('rozhodniBehSyncu', () => {
  test('bez dnešního běhu se zakládá', () => {
    assert.deepEqual(rozhodniBehSyncu({ dnesni: null, now: NYNI }), { akce: 'zalozit', duvod: 'dnes ještě neběželo' });
    assert.equal(rozhodniBehSyncu({ dnesni: undefined, now: NYNI }).akce, 'zalozit');
  });

  test('hotovo → nic', () => {
    assert.deepEqual(rozhodniBehSyncu({ dnesni: { status: 'hotovo', started_at: minutZpet(120) }, now: NYNI }),
      { akce: 'nic', duvod: 'dnes už doběhlo' });
  });

  test('probíhá mladší než 30 minut → nic; v tomhle procesu → nic bez ohledu na stáří', () => {
    assert.deepEqual(rozhodniBehSyncu({ dnesni: { status: 'probiha', started_at: minutZpet(29) }, now: NYNI }),
      { akce: 'nic', duvod: 'běh probíhá' });
    assert.deepEqual(rozhodniBehSyncu({ dnesni: { status: 'probiha', started_at: minutZpet(90) }, now: NYNI, bezi: true }),
      { akce: 'nic', duvod: 'běh právě probíhá v tomhle procesu' });
  });

  test('probíhá 30 minut a déle bez živého procesu → přerušen restartem', () => {
    assert.deepEqual(rozhodniBehSyncu({ dnesni: { status: 'probiha', started_at: minutZpet(30) }, now: NYNI }),
      { akce: 'oznacit-chybu', duvod: 'Běh přerušen restartem serveru' });
    // started_at chodí z DB i jako ISO řetězec
    assert.equal(rozhodniBehSyncu({ dnesni: { status: 'probiha', started_at: minutZpet(45).toISOString() }, now: NYNI }).akce, 'oznacit-chybu');
  });

  test('trvalá chyba čeká na obsluhu, i kdyby backoff dávno uplynul', () => {
    const r = rozhodniBehSyncu({ dnesni: { status: 'chyba', permanent: true, attempt: 1, started_at: minutZpet(600), finished_at: minutZpet(599) }, now: NYNI });
    assert.deepEqual(r, { akce: 'nic', duvod: 'trvalá chyba (token, oprávnění), čeká se na obsluhu' });
  });

  test('po šestém pokusu se čeká na obsluhu', () => {
    const r = rozhodniBehSyncu({ dnesni: { status: 'chyba', permanent: false, attempt: 6, started_at: minutZpet(600), finished_at: minutZpet(599) }, now: NYNI });
    assert.deepEqual(r, { akce: 'nic', duvod: 'vyčerpané pokusy, čeká se na obsluhu' });
    assert.equal(rozhodniBehSyncu({ dnesni: { status: 'chyba', attempt: 7, started_at: minutZpet(600) }, now: NYNI }).akce, 'nic');
  });

  test('backoff je pokus × 10 minut od zápisu chyby: 9 min → čeká, 10 min → opakovat', () => {
    const chyba = (attempt, predMin) => ({ status: 'chyba', permanent: false, attempt, started_at: minutZpet(predMin + 1), finished_at: minutZpet(predMin) });
    assert.deepEqual(rozhodniBehSyncu({ dnesni: chyba(1, 9), now: NYNI }), { akce: 'nic', duvod: 'čeká se na další pokus' });
    assert.deepEqual(rozhodniBehSyncu({ dnesni: chyba(1, 10), now: NYNI }), { akce: 'opakovat', duvod: 'pokus 2' });
    assert.equal(rozhodniBehSyncu({ dnesni: chyba(3, 29), now: NYNI }).akce, 'nic');
    assert.deepEqual(rozhodniBehSyncu({ dnesni: chyba(3, 30), now: NYNI }), { akce: 'opakovat', duvod: 'pokus 4' });
    assert.deepEqual(rozhodniBehSyncu({ dnesni: chyba(5, 50), now: NYNI }), { akce: 'opakovat', duvod: 'pokus 6' });
  });

  test('bez finished_at se backoff počítá od startu; attempt chybějící se bere jako 1', () => {
    assert.equal(rozhodniBehSyncu({ dnesni: { status: 'chyba', started_at: minutZpet(5) }, now: NYNI }).akce, 'nic');
    assert.deepEqual(rozhodniBehSyncu({ dnesni: { status: 'chyba', started_at: minutZpet(10) }, now: NYNI }), { akce: 'opakovat', duvod: 'pokus 2' });
  });

  test('dlouhý běh po kusech: chyba zapsaná před chvílí se neopakuje jen proto, že start byl dávno', () => {
    const r = rozhodniBehSyncu({ dnesni: { status: 'chyba', attempt: 1, started_at: minutZpet(25), finished_at: minutZpet(2) }, now: NYNI });
    assert.equal(r.akce, 'nic');
  });

  test('neznámý stav → nic s pojmenováním stavu', () => {
    assert.deepEqual(rozhodniBehSyncu({ dnesni: { status: 'cokoli', started_at: NYNI }, now: NYNI }), { akce: 'nic', duvod: 'neznámý stav cokoli' });
  });
});

describe('oknoSyncu', () => {
  const DNES = '2026-10-29';

  test('běžný běh: 14 dní zpět po včerejšek', () => {
    assert.deepEqual(oknoSyncu({ zdroj: { since: '2025-01-01', last_ok_at: new Date('2026-10-28T04:00:00Z') }, dnes: DNES }),
      { od: '2026-10-15', do: '2026-10-28' });
    assert.deepEqual(oknoSyncu({ zdroj: { since: null, last_ok_at: '2026-10-28T04:00:00Z' }, dnes: DNES, prepisDni: 30 }),
      { od: '2026-09-29', do: '2026-10-28' });
  });

  test('první běh (bez last_ok_at) jde od since, nejvýš 400 dní zpět', () => {
    assert.deepEqual(oknoSyncu({ zdroj: { since: '2026-06-01', last_ok_at: null }, dnes: DNES }), { od: '2026-06-01', do: '2026-10-28' });
    // since jako Date (sloupec DATE z postgres.js = půlnoc UTC)
    assert.deepEqual(oknoSyncu({ zdroj: { since: new Date('2026-06-01T00:00:00Z'), last_ok_at: null }, dnes: DNES }), { od: '2026-06-01', do: '2026-10-28' });
    // since dávno → strop 400 dní
    assert.deepEqual(oknoSyncu({ zdroj: { since: '2020-01-01', last_ok_at: null }, dnes: DNES }), { od: '2025-09-24', do: '2026-10-28' });
    assert.equal(oknoSyncu({ zdroj: { since: '2020-01-01', last_ok_at: undefined }, dnes: DNES }).od, '2025-09-24');
  });

  test('první běh bez since bere celých 400 dní (plán D5) — historie se netahá jen po prvním úspěchu', () => {
    assert.deepEqual(oknoSyncu({ zdroj: { since: null, last_ok_at: null }, dnes: DNES }), { od: '2025-09-24', do: '2026-10-28' });
    assert.deepEqual(oknoSyncu({ zdroj: {}, dnes: DNES }), { od: '2025-09-24', do: '2026-10-28' });
    // po prvním úspěšném běhu už jen běžné okno, i bez since
    assert.deepEqual(oknoSyncu({ zdroj: { since: null, last_ok_at: '2026-10-28T04:00:00Z' }, dnes: DNES }), { od: '2026-10-15', do: '2026-10-28' });
  });

  test('since nikdy nepodleze ani běžné okno; since dnes dá prázdné okno', () => {
    assert.deepEqual(oknoSyncu({ zdroj: { since: '2026-10-25', last_ok_at: '2026-10-28T04:00:00Z' }, dnes: DNES }), { od: '2026-10-25', do: '2026-10-28' });
    const prazdne = oknoSyncu({ zdroj: { since: DNES, last_ok_at: null }, dnes: DNES });
    assert.deepEqual(prazdne, { od: '2026-10-29', do: '2026-10-28' });
    assert.deepEqual(rozdelOkno(prazdne.od, prazdne.do, 31), []);
  });
});

describe('rozdelOkno', () => {
  test('kusy nejvýš maxDni dní včetně krajů, poslední kratší', () => {
    assert.deepEqual(rozdelOkno('2026-10-01', '2026-10-10', 4), [
      { od: '2026-10-01', do: '2026-10-04' },
      { od: '2026-10-05', do: '2026-10-08' },
      { od: '2026-10-09', do: '2026-10-10' },
    ]);
  });

  test('okno kratší než kus je jeden kus; jednodenní kusy pro Heureku', () => {
    assert.deepEqual(rozdelOkno('2026-10-15', '2026-10-28', 31), [{ od: '2026-10-15', do: '2026-10-28' }]);
    assert.deepEqual(rozdelOkno('2026-10-27', '2026-10-28', 1), [{ od: '2026-10-27', do: '2026-10-27' }, { od: '2026-10-28', do: '2026-10-28' }]);
    assert.deepEqual(rozdelOkno('2026-10-28', '2026-10-28', 31), [{ od: '2026-10-28', do: '2026-10-28' }]);
  });

  test('400 dní po 31 je 13 kusů a dohromady přesně celé okno', () => {
    const kusy = rozdelOkno('2025-09-24', '2026-10-28', 31);
    assert.equal(kusy.length, 13);
    assert.equal(kusy[0].od, '2025-09-24');
    assert.equal(kusy.at(-1).do, '2026-10-28');
    for (let i = 1; i < kusy.length; i++) {
      assert.ok(kusy[i - 1].do < kusy[i].od, `kus ${i} navazuje`);
    }
  });

  test('nesmyslné maxDni se bere jako 1, prázdné okno jako []', () => {
    assert.equal(rozdelOkno('2026-10-01', '2026-10-03', 0).length, 3);
    assert.equal(rozdelOkno('2026-10-01', '2026-10-03', undefined).length, 3);
    assert.deepEqual(rozdelOkno('2026-10-03', '2026-10-01', 31), []);
  });

  test('neplatná mez dá [], ne smyčku do přetečení Date', () => {
    assert.deepEqual(rozdelOkno('2026-10-01', '9999-99-99', 31), []);
    assert.deepEqual(rozdelOkno('2026-13-01', '2026-13-05', 31), []);
    assert.deepEqual(rozdelOkno(null, '2026-10-05', 31), []);
    assert.deepEqual(rozdelOkno('2026-10-01', undefined, 31), []);
  });
});

describe('rozhodniAlertPno', () => {
  test('alert jen při nastaveném prahu, spočítaném PNO a útratě aspoň 500 Kč', () => {
    assert.equal(rozhodniAlertPno({ pno: 35, prah: 28, naklady: 1200 }), true);
    assert.equal(rozhodniAlertPno({ pno: 28, prah: 28, naklady: 1200 }), false);   // rovnost není překročení
    assert.equal(rozhodniAlertPno({ pno: 35, prah: 28, naklady: 499 }), false);
    assert.equal(rozhodniAlertPno({ pno: 35, prah: 28, naklady: 500 }), true);
    assert.equal(rozhodniAlertPno({ pno: 35, prah: 0, naklady: 1200 }), false);     // práh 0 = vypnuto
    assert.equal(rozhodniAlertPno({ pno: 35, prah: null, naklady: 1200 }), false);
    assert.equal(rozhodniAlertPno({ pno: null, prah: 28, naklady: 1200 }), false);  // bez tržeb není PNO
    assert.equal(rozhodniAlertPno({ pno: 35, prah: '28', naklady: '1200' }), true); // NUMERIC z DB jako řetězec
    assert.equal(rozhodniAlertPno({ pno: 35, prah: 28, naklady: 300, minNaklady: 100 }), true);
  });
});
