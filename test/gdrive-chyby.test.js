// Chyby Google Disku pro člověka: česká hláška z odpovědi Googlu (src/gdrive.js),
// jedna hláška a odkaz do konzole na stránce importu, výběr bez dokladů Před automatikou.
//
//   node --test test/gdrive-chyby.test.js        (funkce a šablona bez serveru)
//   DATABASE_URL=… TEST_BASE_URL=… SESSION_SECRET=… node --test test/gdrive-chyby.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import postgres from 'postgres';
import puppeteer from 'puppeteer';
import { popisChybyDisku, jeChybaPristupu, citelnaChyba, listChildren, downloadFile } from '../src/gdrive.js';
import { vymazTokeny } from '../src/google-auth.js';
import { PRESKOCIT, lokalniDatabaze, prihlas, pozadavky, serverBezi } from './pomocnici/server.js';
import { vykresliStranku } from './pomocnici/render.js';

const PROJEKT = '268599556039';
const ADRESA = `https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=${PROJEKT}`;
const ZAPNUTE = (url = ADRESA) => `Google Drive API není v projektu Google Cloud zapnuté. Zapněte ji na ${url} a za pár minut to zkuste znovu.`;
const ANGLICKY = `Google Drive API has not been used in project ${PROJEKT} before or it is disabled. Enable it by visiting ${ADRESA} then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.`;

// Odpověď Googlu tak, jak přišla majiteli (projekt bez zapnutého Drive API).
const VYPNUTE_API = JSON.stringify({
  error: {
    code: 403,
    message: ANGLICKY,
    errors: [{ message: ANGLICKY, domain: 'usageLimits', reason: 'accessNotConfigured', extendedHelp: 'https://console.developers.google.com' }],
    status: 'PERMISSION_DENIED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com',
        metadata: { service: 'drive.googleapis.com', consumer: `projects/${PROJEKT}`, activationUrl: ADRESA, containerInfo: PROJEKT, serviceTitle: 'Google Drive API' } },
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Google developers console API activation', url: ADRESA }] },
    ],
  },
}, null, 2);

const bezJsonu = (text) => {
  assert.ok(!/[{}]|"error"|"code"/.test(text), `surový JSON v textu: ${text}`);
};

describe('hláška z odpovědi Googlu', () => {
  describe('vypnuté Drive API', () => {
    test('celá odpověď: český text a adresa z activationUrl', () => {
      assert.equal(popisChybyDisku(403, VYPNUTE_API), ZAPNUTE());
      assert.equal(jeChybaPristupu(popisChybyDisku(403, VYPNUTE_API)), false);
    });

    test('jen reason accessNotConfigured: adresa z textu odpovědi', () => {
      const telo = JSON.stringify({ error: { message: `Enable it by visiting ${ADRESA} then retry.`, errors: [{ reason: 'accessNotConfigured' }] } });
      assert.equal(popisChybyDisku(403, telo), ZAPNUTE());
    });

    test('jen reason SERVICE_DISABLED bez adresy: složí se z čísla projektu', () => {
      const telo = JSON.stringify({ error: { message: 'Disabled.', details: [{ reason: 'SERVICE_DISABLED', metadata: { consumer: 'projects/77' } }] } });
      assert.equal(popisChybyDisku(403, telo), ZAPNUTE('https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=77'));
    });

    test('jen text has not been used in project: číslo projektu z textu', () => {
      const telo = JSON.stringify({ error: { message: 'Google Drive API has not been used in project 123 before or it is disabled.' } });
      assert.equal(popisChybyDisku(403, telo), ZAPNUTE('https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=123'));
    });

    test('adresa bez čísla projektu je obecná stránka API', () => {
      const telo = JSON.stringify({ error: { errors: [{ reason: 'accessNotConfigured' }] } });
      assert.equal(popisChybyDisku(403, telo), ZAPNUTE('https://console.developers.google.com/apis/api/drive.googleapis.com/overview'));
    });

    test('tečka za adresou v textu do odkazu nepatří', () => {
      const telo = JSON.stringify({ error: { message: `Visit ${ADRESA}.`, errors: [{ reason: 'accessNotConfigured' }] } });
      assert.equal(popisChybyDisku(403, telo), ZAPNUTE());
    });

    test('adresa mimo konzoli Googlu se nepoužije', () => {
      for (const cizi of ['https://evil.example/x', 'javascript:alert(1)', 'https://console.developers.google.com.evil.example/x', 'http://console.developers.google.com/x']) {
        const telo = JSON.stringify({ error: { message: `Visit ${cizi} now`, details: [{ reason: 'SERVICE_DISABLED', metadata: { activationUrl: cizi, consumer: 'projects/5' } }] } });
        assert.equal(popisChybyDisku(403, telo), ZAPNUTE('https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=5'), cizi);
      }
    });

    test('jiný kód než 403 vypnuté API nehlásí', () => {
      assert.ok(!popisChybyDisku(500, VYPNUTE_API).includes('není v projektu'));
    });
  });

  describe('bez přístupu ke složce', () => {
    test('403 s důvodem přístupu, bez důvodu i s nečitelným tělem: rada o nasdílení a kód', () => {
      for (const telo of [
        JSON.stringify({ error: { code: 403, message: 'Insufficient permissions', errors: [{ reason: 'insufficientFilePermissions' }] } }),
        JSON.stringify({ error: { code: 403, message: 'The user does not have sufficient permissions for this file.', errors: [{ reason: 'forbidden' }] } }),
        '{}', '', 'Forbidden', '<html><body>403</body></html>',
      ]) {
        const text = popisChybyDisku(403, telo);
        assert.match(text, /403/);
        assert.match(text, /Nasdílejte složku účtu služby s právem Čtenář\.$/);
        assert.equal(jeChybaPristupu(text), true, telo);
        bezJsonu(text);
      }
    });

    test('404: rada o nasdílení', () => {
      for (const telo of ['', JSON.stringify({ error: { code: 404, message: 'File not found: abc.', errors: [{ reason: 'notFound' }] } })]) {
        const text = popisChybyDisku(404, telo);
        assert.match(text, /nenašel \(404\)\. Nasdílejte složku/);
        assert.equal(jeChybaPristupu(text), true);
        bezJsonu(text);
      }
    });

    test('403 kvůli limitu radu o nasdílení nedostane', () => {
      for (const [duvod, zprava] of [['userRateLimitExceeded', 'User Rate Limit Exceeded'], ['dailyLimitExceeded', 'Daily Limit Exceeded'], ['storageQuotaExceeded', 'Quota']]) {
        const text = popisChybyDisku(403, JSON.stringify({ error: { code: 403, message: zprava, errors: [{ reason: duvod }] } }));
        assert.equal(text, `Google Drive API 403: ${zprava}`);
        assert.equal(jeChybaPristupu(text), false);
      }
    });
  });

  describe('ostatní chyby', () => {
    test('kód a krátký text od Googlu, bez JSONu', () => {
      assert.equal(popisChybyDisku(500, JSON.stringify({ error: { code: 500, message: 'Internal Error', errors: [{ reason: 'internalError' }] } })), 'Google Drive API 500: Internal Error');
      assert.equal(popisChybyDisku(401, JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } })), 'Google Drive API 401: Invalid Credentials');
      assert.equal(popisChybyDisku(400, JSON.stringify({ error: 'invalid_grant', error_description: 'Bad request' })), 'Google Drive API 400: Bad request');
      assert.equal(popisChybyDisku(503, 'Service Unavailable'), 'Google Drive API 503: Service Unavailable');
    });

    test('tělo bez čitelného textu: jen kód', () => {
      for (const telo of ['', '{}', '[]', 'null', '<!DOCTYPE html><html><body>Bad gateway</body></html>', '{"error":{"code":502', '[{"x":1']) {
        assert.equal(popisChybyDisku(502, telo), 'Google Drive API 502.', telo);
      }
    });

    test('dlouhý text se zkrátí a řádky se srovnají', () => {
      const text = popisChybyDisku(500, JSON.stringify({ error: { message: `Řádek\n\n${'x'.repeat(1000)}` } }));
      assert.ok(text.length < 240, String(text.length));
      assert.ok(text.endsWith('…'));
      assert.ok(!text.includes('\n'));
    });

    test('vlastní začátek hlášky u stažení souboru', () => {
      assert.equal(popisChybyDisku(500, '', 'Stažení souboru z Google Disku selhalo (500)'), 'Stažení souboru z Google Disku selhalo (500).');
    });

    test('zvláštní tvary odpovědi nespadnou', () => {
      for (const telo of [null, undefined, 5, '{"error":null}', '{"error":{"errors":"x","details":5}}', '{"error":{"details":[null,{"metadata":{}}],"errors":[null]}}', '{"error":{"message":5}}']) {
        assert.equal(popisChybyDisku(500, telo), 'Google Drive API 500.', String(telo));
        assert.match(popisChybyDisku(403, telo), /403/);
      }
    });
  });

  describe('text uložený starší verzí', () => {
    // Přesně tak leží v gdrive_posledni_chyba: prvních 300 znaků těla odpovědi.
    const ULOZENO = `Google Drive API 403: ${VYPNUTE_API.slice(0, 300)}`;

    test('useknutý JSON je stejná hláška jako živá chyba', () => {
      assert.throws(() => JSON.parse(VYPNUTE_API.slice(0, 300)));
      assert.equal(citelnaChyba(ULOZENO), ZAPNUTE());
    });

    test('nový text zůstane, jak je, prázdný zůstane prázdný', () => {
      for (const text of [ZAPNUTE(), popisChybyDisku(404, ''), popisChybyDisku(403, '{}'), 'Google Drive API 500: Internal Error', 'Google Drive API 503.', 'Ve sdílené složce není podsložka pro rok 2026.', popisChybyDisku(500, JSON.stringify({ error: { message: 'y'.repeat(900) } }))]) {
        assert.equal(citelnaChyba(text), text);
      }
      assert.equal(citelnaChyba(''), '');
      assert.equal(citelnaChyba(null), '');
      assert.equal(citelnaChyba(undefined), '');
    });

    test('jiná stará chyba: kód a text bez JSONu', () => {
      const text = citelnaChyba('Google Drive API 500: {\n "error": {\n  "code": 500,\n  "message": "Backend Error"');
      assert.equal(text, 'Google Drive API 500: Backend Error');
    });
  });
});

describe('volání Disku', () => {
  const puvodniFetch = globalThis.fetch;
  const puvodniKlic = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let odpoved;

  before(() => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'test@test.iam.gserviceaccount.com', private_key: privateKey });
    vymazTokeny();
    globalThis.fetch = async (url) => {
      if (new URL(url).host === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      return odpoved();
    };
  });
  after(() => {
    globalThis.fetch = puvodniFetch;
    if (puvodniKlic === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = puvodniKlic;
    vymazTokeny();
  });

  test('výpis složky: hláška pro člověka, celá odpověď zůstane pro log', async () => {
    odpoved = () => new Response(VYPNUTE_API, { status: 403 });
    await assert.rejects(listChildren('slozka'), (err) => {
      assert.equal(err.message, ZAPNUTE());
      assert.equal(err.status, 403);
      assert.ok(err.detail.includes('has not been used in project'));
      return true;
    });
  });

  test('stažení souboru: stejné hlášky, jiné chyby se svým začátkem', async () => {
    odpoved = () => new Response(VYPNUTE_API, { status: 403 });
    await assert.rejects(downloadFile('soubor'), { message: ZAPNUTE() });
    odpoved = () => new Response(JSON.stringify({ error: { message: 'Backend Error' } }), { status: 500 });
    await assert.rejects(downloadFile('soubor'), { message: 'Stažení souboru z Google Disku selhalo (500): Backend Error' });
  });
});

const soubor = (id, stav, prepis = {}) => ({
  id, name: `${id}.pdf`, folderPath: '2026 / 11. Listopad / Přijaté faktury', modifiedTime: '2026-11-01T10:00:00Z',
  webViewLink: `https://drive.google.com/file/d/${id}/view`, invoiceId: null, stav, chyba: '', ...prepis,
});

const vykresli = (prepis = {}) => vykresliStranku('invoices/gdrive', {
  files: [], error: null, year: 2026, month: 11, serviceAccount: 'seil@projekt.iam.gserviceaccount.com',
  radaNasdilet: false, job: null, kontrola: null, chybaKontroly: '', ...prepis,
});
const pocet = (html, hledane) => html.split(hledane).length - 1;

describe('hláška na stránce importu', () => {
  test('živá a uložená chyba říkají totéž: jedna hláška, text jednou', async () => {
    const html = await vykresli({ error: ZAPNUTE(), chybaKontroly: ZAPNUTE() });
    assert.equal(pocet(html, 'class="hlaska hlaska-chyba"'), 1);
    assert.equal(pocet(html, 'není v projektu Google Cloud zapnuté'), 1);
    assert.ok(html.includes('Nelze načíst soubory:'));
    assert.ok(!html.includes('Poslední kontrola selhala'));
  });

  test('různé chyby: obě v jedné hlášce', async () => {
    const html = await vykresli({ error: 'Ve sdílené složce není podsložka pro rok 2020.', chybaKontroly: ZAPNUTE() });
    assert.equal(pocet(html, 'class="hlaska hlaska-chyba"'), 1);
    assert.ok(html.includes('podsložka pro rok 2020'));
    assert.ok(html.includes('Poslední kontrola selhala:'));
    assert.equal(pocet(html, 'není v projektu'), 1);
  });

  test('jen uložená chyba kontroly, soubory se načetly', async () => {
    const html = await vykresli({ chybaKontroly: ZAPNUTE(), files: [soubor('a', 'cekajici')] });
    assert.equal(pocet(html, 'class="hlaska hlaska-chyba"'), 1);
    assert.ok(!html.includes('Nelze načíst soubory'));
    assert.ok(html.includes('Poslední kontrola selhala:'));
  });

  test('bez chyby žádná hláška', async () => {
    const html = await vykresli({ kontrola: new Date('2026-11-01T10:00:00Z') });
    assert.ok(!html.includes('hlaska-chyba'));
    assert.ok(html.includes('Poslední kontrola:'));
  });

  test('adresa konzole je odkaz, zbytek věty text', async () => {
    const html = await vykresli({ error: ZAPNUTE() });
    assert.ok(html.includes(`Zapněte ji na <a href="${ADRESA}" target="_blank" rel="noopener noreferrer">${ADRESA}</a> a za pár minut to zkuste znovu.`));
  });

  test('adresa se znaky z URL se v odkazu escapuje', async () => {
    const html = await vykresli({ error: 'Viz https://console.cloud.google.com/apis?project=1&x=2 a dál' });
    assert.ok(html.includes('href="https://console.cloud.google.com/apis?project=1&amp;x=2"'));
    assert.ok(html.includes('>https://console.cloud.google.com/apis?project=1&amp;x=2</a> a dál'));
  });

  test('rada s účtem služby jen u chyb přístupu', async () => {
    const pristup = popisChybyDisku(403, '{}');
    const html = await vykresli({ error: pristup, chybaKontroly: pristup, radaNasdilet: jeChybaPristupu(pristup) });
    assert.ok(html.includes('Nasdílejte složku účtu služby'));
    assert.ok(html.includes('Účet služby: <code class="kod">seil@projekt.iam.gserviceaccount.com</code>'));

    for (const text of [ZAPNUTE(), 'Google Drive API 500: Internal Error', 'Není nastavena proměnná GOOGLE_SERVICE_ACCOUNT_JSON – doplňte ji v Coolify env vars.', 'Ve sdílené složce není podsložka pro rok 2020.']) {
      const jina = await vykresli({ error: text, radaNasdilet: jeChybaPristupu(text) });
      assert.ok(!jina.includes('Účet služby'), text);
      assert.ok(!/nasdílejte/i.test(jina), text);
    }
  });

  test('útočný text v chybě neprojde neescapovaný ani jako odkaz', async () => {
    const utoky = [
      '<img src=x onerror=alert(1)>',
      '"><script>alert(1)</script>',
      `https://console.developers.google.com/x"><script>alert(2)</script>`,
      `https://console.developers.google.com/x'onmouseover=alert(3) y=`,
      'https://console.developers.google.com/<svg/onload=alert(4)>',
      'javascript:alert(5)',
      'https://console.developers.google.com.evil.example/x',
      'https://evil.example/https://console.developers.google.com',
      'http://console.developers.google.com/x',
    ].join(' ');
    const html = await vykresli({ error: utoky, chybaKontroly: `${utoky} kontrola`, serviceAccount: '<b>x</b>', radaNasdilet: true });
    for (const nesmi of ['<img', '<script>alert', '<svg', '<b>x</b>', 'onmouseover=alert(3) y=">']) {
      assert.ok(!html.includes(nesmi), nesmi);
    }
    // Každý odkaz v hlášce vede jen do konzole Googlu a jeho adresa nic nepřidá.
    const hlaska = /class="hlaska hlaska-chyba"[^]*?<\/div>\s*<\/div>|class="hlaska hlaska-chyba"[^]*?<p class="form-hint"/.exec(html)[0];
    const odkazy = [...hlaska.matchAll(/<a href="([^"]*)"/g)].map(m => m[1]);
    assert.ok(odkazy.length >= 2);
    for (const a of odkazy) assert.match(a, /^https:\/\/console\.developers\.google\.com\/[^"<>\s]*$/, a);
    assert.ok(!odkazy.some(a => a.includes('evil')));
  });

  test('útočný název souboru ani chyba souboru neprojdou', async () => {
    const html = await vykresli({ files: [soubor('a', 'chyba', { name: '<img src=x onerror=alert(1)>.pdf', chyba: '"><script>alert(1)</script>', folderPath: '<b>x</b>' })] });
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>alert'));
    assert.ok(!html.includes('<b>x</b>'));
  });
});

describe('tabulka dokladů na stránce importu', () => {
  const soubory = [
    soubor('novy', null),
    soubor('chybny', 'chyba', { chyba: 'Nepodařilo se vytěžit' }),
    soubor('stary1', 'vychozi'),
    soubor('stary2', 'vychozi'),
    soubor('hotovy', 'cekajici', { invoiceId: 'inv1' }),
  ];

  test('odznaky přes tóny, žádné barvy natvrdo', async () => {
    const html = await vykresli({ files: soubory });
    assert.ok(html.includes('class="badge badge-info">Nové'));
    assert.ok(html.includes('class="badge badge-chyba" title="Nepodařilo se vytěžit">Chyba'));
    assert.match(html, /class="badge badge-neutral"[^>]*>Před automatikou/);
    assert.match(html, /class="badge badge-ok"[^>]*>Naimportováno/);
    assert.ok(!/#[0-9a-f]{6}/i.test(html.slice(0, html.indexOf('<script>'))), 'barva natvrdo');
  });

  test('Před automatikou: nezaškrtnuté, označené, věta nad tabulkou', async () => {
    const html = await vykresli({ files: soubory });
    assert.ok(html.includes('Doklad Před automatikou se jen připojí'));
    assert.ok(html.indexOf('Doklad Před automatikou') < html.indexOf('<table'));
    for (const m of html.matchAll(/<input type="checkbox" class="gd-cb"[^>]*>/g)) {
      assert.notEqual(m[0].includes('data-pred-automatikou'), m[0].includes(' checked'), m[0]);
    }
    assert.equal(pocet(html, 'data-pred-automatikou '), 2);
    assert.ok(html.includes('<span id="gdCount">2</span>'), 'výběr na začátku jsou jen nové a chybné');
  });

  test('bez takových řádků věta není', async () => {
    const html = await vykresli({ files: [soubor('novy', null)] });
    assert.ok(!html.includes('Doklad Před automatikou se'));
  });

  test('stránkování tu není, výběr potřebuje všechny řádky', async () => {
    const html = await vykresli({ files: Array.from({ length: 60 }, (_, i) => soubor(`s${i}`, null)) });
    assert.ok(!html.includes('strankovani'));
    assert.equal(pocet(html, 'class="gd-cb"'), 60);
  });

  test('prázdná složka a chyba: vlastní text, formulář importu není', async () => {
    const prazdno = await vykresli();
    assert.ok(prazdno.includes('V této složce nejsou žádné doklady'));
    assert.ok(!prazdno.includes('id="gdForm"'));
    assert.ok((await vykresli({ error: 'x' })).includes('Složku se nepodařilo načíst'));
  });

  describe('v prohlížeči', () => {
    let browser; let page; const jsChyby = [];

    before(async () => {
      browser = await puppeteer.launch({ headless: true });
      page = await browser.newPage();
      page.on('pageerror', e => jsChyby.push(e.message));
    });
    after(() => browser.close());

    const nacti = async (prepis) => {
      const html = await vykresli(prepis);
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { waitUntil: 'load' });
    };
    const stav = () => page.evaluate(() => ({
      vybrane: [...document.querySelectorAll('.gd-cb:checked')].map(c => c.value),
      vse: document.getElementById('gdAll').checked,
      castecne: document.getElementById('gdAll').indeterminate,
      pocet: document.getElementById('gdCount').textContent.trim(),
      odeslat: !document.getElementById('gdSubmit').disabled,
    }));

    test('Vybrat vše nezaškrtne řádky Před automatikou', async () => {
      await nacti({ files: soubory });
      assert.deepEqual(await stav(), { vybrane: ['novy', 'chybny'], vse: true, castecne: false, pocet: '2', odeslat: true });
      await page.click('#gdAll');
      assert.deepEqual(await stav(), { vybrane: [], vse: false, castecne: false, pocet: '0', odeslat: false });
      await page.click('#gdAll');
      assert.deepEqual(await stav(), { vybrane: ['novy', 'chybny'], vse: true, castecne: false, pocet: '2', odeslat: true });
    });

    test('řádek Před automatikou jde vybrat ručně, odškrtnutí všeho ho zruší', async () => {
      await nacti({ files: soubory });
      await page.click('.gd-cb[value="stary1"]');
      assert.deepEqual(await stav(), { vybrane: ['novy', 'chybny', 'stary1'], vse: true, castecne: false, pocet: '3', odeslat: true });
      await page.click('#gdAll');
      assert.deepEqual((await stav()).vybrane, []);
      await page.click('.gd-cb[value="stary2"]');
      assert.deepEqual(await stav(), { vybrane: ['stary2'], vse: false, castecne: true, pocet: '1', odeslat: true });
      await page.click('#gdAll');
      assert.deepEqual((await stav()).vybrane, ['novy', 'chybny', 'stary2'], 'ruční výběr Vybrat vše nezruší');
    });

    test('jen řádky Před automatikou: Vybrat vše je vypnuté, import čeká na ruční výběr', async () => {
      await nacti({ files: [soubor('stary1', 'vychozi')] });
      assert.equal(await page.$eval('#gdAll', el => el.disabled), true);
      assert.deepEqual(await stav(), { vybrane: [], vse: false, castecne: false, pocet: '0', odeslat: false });
      await page.click('.gd-cb');
      assert.equal((await stav()).odeslat, true);
    });

    test('prázdná složka: skript nespadne', async () => {
      await nacti({ files: [], error: ZAPNUTE() });
      assert.equal(await page.$('#gdAll'), null);
    });

    test('bez chyb JavaScriptu', () => {
      assert.deepEqual(jsChyby, []);
    });
  });
});

describe('chyba kontroly v databázi a na stránce', { skip: PRESKOCIT }, () => {
  const r = Math.random().toString(36).slice(2, 9);
  const CESTA = '/ucetnictvi/prijate-faktury/gdrive';
  const puvodniFetch = globalThis.fetch;
  const puvodniKlic = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let sql; let sid; let req; let uzivatel; let firma; let puvodni; let vlastniRadek = false;

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    [uzivatel] = await sql`INSERT INTO users (email, password_hash, is_active, is_admin) VALUES (${`gc-${r}@example.invalid`}, 'x', TRUE, TRUE) RETURNING id`;
    const prihlaseni = await prihlas(sql, uzivatel.id);
    sid = prihlaseni.sid;
    req = pozadavky(prihlaseni.cookie);
    [firma] = await sql`SELECT id FROM company_settings LIMIT 1`;
    if (!firma) {
      [firma] = await sql`INSERT INTO company_settings (name) VALUES ('Test') RETURNING id`;
      vlastniRadek = true;
    }
    [puvodni] = await sql`SELECT gdrive_root_folder_id, gdrive_vychozi_slozka, gdrive_posledni_chyba, gdrive_posledni_kontrola FROM company_settings WHERE id = ${firma.id}`;
  });

  after(async () => {
    globalThis.fetch = puvodniFetch;
    if (puvodniKlic === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = puvodniKlic;
    if (vlastniRadek) await sql`DELETE FROM company_settings WHERE id = ${firma.id}`;
    else await sql`UPDATE company_settings SET ${sql(puvodni)} WHERE id = ${firma.id}`;
    await sql`DELETE FROM session WHERE sid = ${sid}`;
    await sql`DELETE FROM users WHERE id = ${uzivatel.id}`;
    await sql.end();
  });

  test('kontrola uloží do gdrive_posledni_chyba český text', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'test@test.iam.gserviceaccount.com', private_key: privateKey });
    vymazTokeny();
    globalThis.fetch = async (url) => {
      if (new URL(url).host === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      return new Response(VYPNUTE_API, { status: 403 });
    };
    await sql`UPDATE company_settings SET gdrive_root_folder_id = 'root-test', gdrive_posledni_chyba = '' WHERE id = ${firma.id}`;
    const { tikGdrive } = await import('../src/gdrive-import.js');
    assert.equal(await tikGdrive(null, { sql, now: new Date(), extract: async () => ({}), notify: async () => ({}) }), null);
    const [radek] = await sql`SELECT gdrive_posledni_chyba FROM company_settings WHERE id = ${firma.id}`;
    assert.equal(radek.gdrive_posledni_chyba, ZAPNUTE());
    globalThis.fetch = puvodniFetch;
    vymazTokeny();
  });

  test('starý text se surovým JSONem se na stránce ukáže česky, s odkazem a bez JSONu', async () => {
    await sql`UPDATE company_settings SET gdrive_posledni_chyba = ${`Google Drive API 403: ${VYPNUTE_API.slice(0, 300)}`} WHERE id = ${firma.id}`;
    const html = await (await req.get(CESTA)).text();
    assert.ok(html.includes(`<a href="${ADRESA}" target="_blank" rel="noopener noreferrer">`));
    assert.ok(!html.includes('&#34;error&#34;'), 'surový JSON na stránce');
    assert.ok(!html.includes('has not been used'));
    assert.equal(pocet(html, 'class="hlaska hlaska-chyba"'), 1);
  });

  test('útočný text uložený v chybě se escapuje', async () => {
    await sql`UPDATE company_settings SET gdrive_posledni_chyba = ${'Chyba <img src=x onerror=alert(1)> "><script>alert(1)</script>'} WHERE id = ${firma.id}`;
    const html = await (await req.get(CESTA)).text();
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>alert(1)'));
    await sql`UPDATE company_settings SET gdrive_posledni_chyba = ${`Google Drive API 500: {"error":{"message":"<img src=x onerror=alert(1)>"}}`} WHERE id = ${firma.id}`;
    const zJsonu = await (await req.get(CESTA)).text();
    assert.ok(!zJsonu.includes('<img src=x'));
  });
});
