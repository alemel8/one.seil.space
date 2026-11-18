// Stav zásilky ze Zásilkovny a pravidlo „převzala balík“ – bez databáze
// a bez sítě:
//
//   node --test test/sledovani-zasilek.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAVY_PREVZATO, fetchPacketStatus, jePrevzataDopravcem, okamzikZasilkovny,
  popisStavuZasilky, prectiStavZasilky,
} from '../src/packeta.js';

/** Odpověď packetStatus v tvaru, v jakém ji vrací SOAP server Zásilkovny. */
function odpoved({ codeText = 'arrived', statusCode = 2, statusText = 'Zásilka byla přijata.', dateTime = '2026-11-18T14:02:11', isReturning = 'false' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.zasilkovna.cz/api/soap.wsdl" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><SOAP-ENV:Body><ns1:packetStatusResponse><packetStatusResult><dateTime>${dateTime}</dateTime><statusCode>${statusCode}</statusCode><codeText>${codeText}</codeText><statusText>${statusText}</statusText><branchId>0</branchId><destinationBranchId>12345</destinationBranchId><externalTrackingCode xsi:nil="true"/><isReturning>${isReturning}</isReturning><storedUntil xsi:nil="true"/><carrierId xsi:nil="true"/><carrierName xsi:nil="true"/></packetStatusResult></ns1:packetStatusResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

describe('odpověď packetStatus', () => {
  const puvodniHeslo = process.env.PACKETA_API_PASSWORD;
  before(() => { process.env.PACKETA_API_PASSWORD = 'test-heslo'; });
  after(() => {
    if (puvodniHeslo === undefined) delete process.env.PACKETA_API_PASSWORD;
    else process.env.PACKETA_API_PASSWORD = puvodniHeslo;
  });

  test('přečte kód, popis, čas a příznak vracení', () => {
    const stav = prectiStavZasilky(odpoved({ statusText: 'Z&amp;B &quot;depo&quot;' }));
    assert.equal(stav.codeText, 'arrived');
    assert.equal(stav.statusCode, 2);
    assert.equal(stav.statusText, 'Z&B "depo"');
    assert.equal(stav.isReturning, false);
    // Pražský čas bez pásma: 14:02 v listopadu je 13:02 UTC.
    assert.equal(stav.dateTime.toISOString(), '2026-11-18T13:02:11.000Z');
  });

  test('kód se porovnává malými písmeny', () => {
    assert.equal(prectiStavZasilky(odpoved({ codeText: 'Ready For Pickup' })).codeText, 'ready for pickup');
  });

  test('odpověď bez výsledku je chyba, ne prázdný stav', () => {
    assert.throws(() => prectiStavZasilky('<html>502</html>'), /neočekávaná odpověď/);
    assert.throws(() => prectiStavZasilky(odpoved({ codeText: '' })), /neobsahuje stav/);
  });

  test('chyba Zásilkovny (fault) projde až k volajícímu', async () => {
    const fault = '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>SOAP-ENV:Client</faultcode><faultstring>Packet ID is not valid.</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>';
    let telo = '';
    const fetchImpl = async (_url, opts) => { telo = opts.body; return { text: async () => fault }; };
    await assert.rejects(fetchPacketStatus('Z 123 456 7890', { fetchImpl }), /Packet ID is not valid/);
    // packetId jsou jen číslice, jako u štítku.
    assert.match(telo, /<packetId>1234567890<\/packetId>/);
    assert.match(telo, /<tns:packetStatus>/);
  });

  test('úspěšné volání vrátí přečtený stav', async () => {
    const fetchImpl = async () => ({ text: async () => odpoved({ codeText: 'delivered', statusCode: 7 }) });
    const stav = await fetchPacketStatus('Z1234567890', { fetchImpl });
    assert.equal(stav.codeText, 'delivered');
  });
});

describe('čas ze Zásilkovny', () => {
  test('bez pásma je to pražský čas v zimě i v létě', () => {
    assert.equal(okamzikZasilkovny('2026-01-10T08:00:00').toISOString(), '2026-01-10T07:00:00.000Z');
    assert.equal(okamzikZasilkovny('2026-07-10T08:00:00').toISOString(), '2026-07-10T06:00:00.000Z');
  });

  test('s pásmem se bere doslova', () => {
    assert.equal(okamzikZasilkovny('2026-07-10T08:00:00+02:00').toISOString(), '2026-07-10T06:00:00.000Z');
    assert.equal(okamzikZasilkovny('2026-07-10T08:00:00Z').toISOString(), '2026-07-10T08:00:00.000Z');
  });

  test('prázdný nebo nesmyslný čas je null', () => {
    assert.equal(okamzikZasilkovny(''), null);
    assert.equal(okamzikZasilkovny('včera'), null);
  });
});

describe('kdy Zásilkovna balík převzala', () => {
  test('jen data od e-shopu převzetí není', () => {
    assert.equal(jePrevzataDopravcem({ codeText: 'received data' }), false);
  });

  test('přijetí na podacím místě i svoz u odesílatele převzetí jsou', () => {
    assert.equal(jePrevzataDopravcem({ codeText: 'arrived' }), true);
    assert.equal(jePrevzataDopravcem({ codeText: 'collected' }), true);
  });

  test('každý další stav cesty k zákazníkovi taky – stav se může přeskočit mezi dvěma dotazy', () => {
    for (const kod of ['prepared for departure', 'departed', 'handed to carrier', 'ready for pickup', 'delivered']) {
      assert.equal(jePrevzataDopravcem({ codeText: kod }), true, kod);
    }
  });

  test('zrušená, neznámá a vracející se zásilka se nevyřizuje', () => {
    for (const kod of ['cancelled', 'unknown', 'posted back', 'returned', 'rejected by recipient', 'reverse packet arrived', '']) {
      assert.equal(jePrevzataDopravcem({ codeText: kod }), false, kod);
    }
    assert.equal(jePrevzataDopravcem({ codeText: 'ready for pickup', isReturning: true }), false);
    assert.equal(jePrevzataDopravcem(null), false);
  });

  test('každý stav převzetí má český popis', () => {
    for (const kod of STAVY_PREVZATO) {
      assert.notEqual(popisStavuZasilky(kod), kod, kod);
    }
    assert.equal(popisStavuZasilky('neco nového', 'Nový stav'), 'Nový stav');
  });
});
