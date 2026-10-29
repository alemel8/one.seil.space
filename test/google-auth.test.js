// Jednotkový test přihlášení service accountu Googlu — bez sítě: fetch je
// nahrazený a klíč je čerstvě vygenerovaný RSA pár.
//
//   node --test test/google-auth.test.js
//
// Hlídá: JWT nese seřazené scope a správného vydavatele a je podepsaný
// klíčem z env (včetně escapovaných \n), token se drží zvlášť pro každou
// sadu scope (Disk vs. GA4), googleJson posílá Bearer token, query parametry
// a JSON tělo, a chyby mapuje na GoogleApiError se správným retryable
// (429, 5xx a síť ano; 400, 401, 403, 404 ne). 403 radí přidat e-mail
// service accountu jako čtenáře, 401 zahodí token z cache, 2xx s nečitelným
// tělem (HTML místo JSON) je GoogleApiError k opakování, ne SyntaxError.

import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  GoogleApiError, accessToken, googleJson, isConfigured, serviceAccountEmail, vymazTokeny,
} from '../src/google-auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const EMAIL = 'one-seil@test-project.iam.gserviceaccount.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const puvodniFetch = globalThis.fetch;
const puvodniEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
let volani = [];

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function odpoved(status, telo, { json = true } = {}) {
  return new Response(json ? JSON.stringify(telo) : telo, {
    status, headers: { 'content-type': json ? 'application/json' : 'text/plain' },
  });
}

/** Nahradí fetch: zaznamená volání a odpoví podle `handler`. */
function nastavFetch(handler) {
  globalThis.fetch = async (url, init = {}) => {
    const zaznam = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body, signal: init.signal };
    volani.push(zaznam);
    return handler(zaznam);
  };
}

/** Token endpoint: ověří podpis JWT a vrátí token odvozený ze scope. */
function tokenEndpoint(z) {
  const params = new URLSearchParams(z.body.toString());
  assert.equal(z.method, 'POST');
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, p, s] = params.get('assertion').split('.');
  assert.deepEqual(JSON.parse(b64urlDecode(h)), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(b64urlDecode(p));
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, b64urlDecode(s)), 'podpis JWT sedí na klíč z env');
  assert.equal(claims.iss, EMAIL);
  assert.equal(claims.aud, TOKEN_URL);
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(z.signal instanceof AbortSignal, 'i token endpoint má timeout');
  return odpoved(200, { access_token: `token-pro:${claims.scope}`, expires_in: 3600, token_type: 'Bearer' });
}

const pocetTokenu = () => volani.filter((z) => z.url === TOKEN_URL).length;

before(() => {
  // Klíč s escapovanými \n, jak ho lidé vkládají do Coolify.
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: EMAIL, private_key: privateKey.replace(/\n/g, '\\n') });
});

beforeEach(() => { volani = []; vymazTokeny(); });

afterEach(() => { globalThis.fetch = puvodniFetch; });

test('bez env proměnné není nakonfigurováno', () => {
  const ulozeny = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  try {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    assert.equal(isConfigured(), false);
    assert.equal(serviceAccountEmail(), null);
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{nesmysl';
    assert.equal(isConfigured(), true, 'isConfigured říká jen, že proměnná existuje');
    assert.equal(serviceAccountEmail(), null, 'rozbitý JSON nespadne, jen nedá e-mail');
  } finally {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = ulozeny;
  }
  assert.equal(serviceAccountEmail(), EMAIL);
});

describe('accessToken', () => {
  test('JWT podepsaný klíčem z env, scope seřazené, token v cache na sadu scope', async () => {
    nastavFetch(tokenEndpoint);
    const DISK = 'https://www.googleapis.com/auth/drive.readonly';
    const t1 = await accessToken([DISK]);
    assert.equal(t1, `token-pro:${DISK}`);
    assert.equal(await accessToken(DISK), t1, 'řetězec i pole dávají tutéž sadu');
    assert.equal(pocetTokenu(), 1, 'druhé volání bere token z cache');

    const t2 = await accessToken(['b-scope', 'a-scope', 'a-scope']);
    assert.equal(t2, 'token-pro:a-scope b-scope', 'scope seřazené, bez duplicit, oddělené mezerou');
    assert.equal(pocetTokenu(), 2, 'jiná sada scope = jiný token');
    assert.equal(await accessToken(['a-scope', 'b-scope']), t2);
    assert.equal(pocetTokenu(), 2, 'pořadí scope v cache nehraje roli');
    assert.equal(await accessToken([DISK]), t1, 'token Disku zůstal vedle tokenu GA4');
    assert.equal(pocetTokenu(), 2);
  });

  test('bez scope je to chyba programátora, ne nastavení', async () => {
    nastavFetch(tokenEndpoint);
    await assert.rejects(accessToken([]), /chybí scope/);
    await assert.rejects(accessToken(['']), /chybí scope/);
    assert.equal(volani.length, 0);
  });

  test('odmítnuté přihlášení: text jako dřív v gdrive.js, 400 neopakovat, 503 opakovat', async () => {
    nastavFetch(() => odpoved(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }));
    await assert.rejects(accessToken(['s']), (err) => {
      assert.ok(err instanceof GoogleApiError);
      assert.equal(err.message, 'Google odmítl přihlášení service accountu: Invalid JWT Signature.');
      assert.equal(err.status, 400);
      assert.equal(err.retryable, false);
      return true;
    });

    nastavFetch(() => odpoved(503, 'Service Unavailable', { json: false }));
    await assert.rejects(accessToken(['s']), (err) => {
      assert.equal(err.message, 'Google odmítl přihlášení service accountu: 503');
      assert.equal(err.retryable, true);
      return true;
    });

    nastavFetch(() => { throw new TypeError('fetch failed'); });
    await assert.rejects(accessToken(['s']), (err) => {
      assert.ok(err instanceof GoogleApiError);
      assert.match(err.message, /^Přihlášení service accountu Googlu neproběhlo: fetch failed/);
      assert.equal(err.status, 0);
      assert.equal(err.retryable, true);
      return true;
    });
  });

  test('chybějící nebo rozbitý klíč hlásí totéž, co dřív gdrive.js', async () => {
    const ulozeny = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    nastavFetch(tokenEndpoint);
    try {
      delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      await assert.rejects(accessToken(['s']), { message: 'GOOGLE_SERVICE_ACCOUNT_JSON není nastavena.' });
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{';
      await assert.rejects(accessToken(['s']), { message: 'GOOGLE_SERVICE_ACCOUNT_JSON není platný JSON.' });
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: EMAIL });
      await assert.rejects(accessToken(['s']), { message: 'V GOOGLE_SERVICE_ACCOUNT_JSON chybí client_email nebo private_key.' });
    } finally {
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON = ulozeny;
    }
    assert.equal(volani.length, 0, 'bez klíče se na síť nesahá');
  });
});

describe('googleJson', () => {
  test('Bearer token, parametry v URL, JSON tělo, odpověď rozparsovaná', async () => {
    nastavFetch((z) => z.url === TOKEN_URL ? tokenEndpoint(z) : odpoved(200, { rows: [{ a: 1 }] }));
    const data = await googleJson('https://analyticsdata.googleapis.com/v1beta/properties/1:runReport', {
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
      method: 'POST', body: { dateRanges: [] }, params: { alt: 'json', prazdne: null, nic: undefined, limit: 5 },
    });
    assert.deepEqual(data, { rows: [{ a: 1 }] });
    const z = volani.at(-1);
    assert.equal(z.url, 'https://analyticsdata.googleapis.com/v1beta/properties/1:runReport?alt=json&limit=5');
    assert.equal(z.method, 'POST');
    assert.equal(z.headers.Authorization, 'Bearer token-pro:https://www.googleapis.com/auth/analytics.readonly');
    assert.equal(z.headers['Content-Type'], 'application/json');
    assert.equal(z.body, '{"dateRanges":[]}');
    assert.ok(z.signal instanceof AbortSignal, 'volání má timeout');
  });

  test('GET bez těla, 204 dává null, vlastní hlavičky projdou', async () => {
    nastavFetch((z) => z.url === TOKEN_URL ? tokenEndpoint(z) : new Response(null, { status: 204 }));
    const data = await googleJson('https://www.googleapis.com/webmasters/v3/sites', { scopes: ['s'], headers: { 'x-test': '1' } });
    assert.equal(data, null);
    const z = volani.at(-1);
    assert.equal(z.method, 'GET');
    assert.equal(z.body, undefined);
    assert.equal(z.headers['Content-Type'], undefined);
    assert.equal(z.headers['x-test'], '1');
  });

  test('200 s HTML místo JSON (proxy, captive portal) je GoogleApiError k opakování, ne SyntaxError', async () => {
    const html = `<html><body>Sign in to the network</body></html>${'x'.repeat(600)}`;
    nastavFetch((z) => z.url === TOKEN_URL ? tokenEndpoint(z) : new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
    await assert.rejects(googleJson('https://example.googleapis.com/v1/x', { scopes: ['s'] }), (err) => {
      assert.ok(err instanceof GoogleApiError, 'ne holý SyntaxError');
      assert.equal(err.status, 200);
      assert.equal(err.retryable, true);
      assert.match(err.message, /^Google API \(example\.googleapis\.com\) vrátilo nečitelnou odpověď \(200\): /);
      assert.ok(err.detail.startsWith('<html>'), 'detail nese začátek těla pro log');
      assert.equal(err.detail.length, 500);
      return true;
    });
  });

  test('HTTP chyby: 429 a 5xx opakovat, 400/401/403/404 ne, detail do 500 znaků', async () => {
    for (const [status, retryable] of [[400, false], [401, false], [403, false], [404, false], [429, true], [500, true], [502, true], [503, true]]) {
      vymazTokeny();
      nastavFetch((z) => z.url === TOKEN_URL ? tokenEndpoint(z) : odpoved(status, 'x'.repeat(700), { json: false }));
      await assert.rejects(googleJson('https://example.googleapis.com/v1/x', { scopes: ['s'] }), (err) => {
        assert.ok(err instanceof GoogleApiError, `${status} je GoogleApiError`);
        assert.equal(err.name, 'GoogleApiError');
        assert.equal(err.status, status);
        assert.equal(err.retryable, retryable, `${status} retryable=${retryable}`);
        assert.equal(err.detail.length, 500);
        assert.match(err.message, /example\.googleapis\.com/);
        return true;
      });
    }
  });

  test('403 radí přidat e-mail service accountu jako čtenáře', async () => {
    nastavFetch((z) => z.url === TOKEN_URL ? tokenEndpoint(z) : odpoved(403, { error: { message: 'User does not have sufficient permissions' } }));
    await assert.rejects(googleJson('https://analyticsdata.googleapis.com/v1beta/properties/1:runReport', { scopes: ['s'] }), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.retryable, false);
      assert.ok(err.message.includes(EMAIL), 'zpráva nese e-mail service accountu');
      assert.match(err.message, /čtenáře/);
      assert.match(err.message, /GA4|Search Console|Merchant/);
      assert.match(err.message, /sufficient permissions/);
      return true;
    });
  });

  test('401 zahodí token dané sady scope, ostatní zůstanou', async () => {
    nastavFetch((z) => z.url === TOKEN_URL ? tokenEndpoint(z) : odpoved(401, 'Invalid Credentials', { json: false }));
    await accessToken(['jiny']);
    await assert.rejects(googleJson('https://example.googleapis.com/v1/x', { scopes: ['s'] }), { status: 401, retryable: false });
    assert.equal(pocetTokenu(), 2);
    await assert.rejects(googleJson('https://example.googleapis.com/v1/x', { scopes: ['s'] }), { status: 401 });
    assert.equal(pocetTokenu(), 3, 'po 401 si další volání vzalo nový token');
    await accessToken(['jiny']);
    assert.equal(pocetTokenu(), 3, 'token jiné sady scope zůstal v cache');
  });

  test('síťová chyba a timeout jsou opakovatelné, status 0', async () => {
    nastavFetch((z) => { if (z.url === TOKEN_URL) return tokenEndpoint(z); throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') }); });
    await assert.rejects(googleJson('https://example.googleapis.com/v1/x', { scopes: ['s'] }), (err) => {
      assert.ok(err instanceof GoogleApiError);
      assert.equal(err.status, 0);
      assert.equal(err.retryable, true);
      assert.equal(err.message, 'Google API (example.googleapis.com) neodpovědělo: ECONNRESET');
      return true;
    });

    nastavFetch((z) => { if (z.url === TOKEN_URL) return tokenEndpoint(z); throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    await assert.rejects(googleJson('https://example.googleapis.com/v1/x', { scopes: ['s'], timeoutMs: 5_000 }), (err) => {
      assert.equal(err.retryable, true);
      assert.equal(err.message, 'Google API (example.googleapis.com) neodpovědělo: vypršel čas (5 s)');
      return true;
    });
  });
});
