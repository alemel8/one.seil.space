// Stránka Healthchecky a notifikace (views/pages/monitoring/settings.ejs) po záložkách
// a návratové adresy v src/routes/monitoring.js. Serverová část jede proti běžícímu
// serveru a lokální databázi.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… TEST_BASE_URL=http://127.0.0.1:3999 \
//   SESSION_SECRET=<stejný jako server> node --test test/render-healthchecky.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { vykresliStranku } from './pomocnici/render.js';
import { PRESKOCIT, lokalniDatabaze, serverBezi, prihlas, pozadavky } from './pomocnici/server.js';

const ZALOZKY = [['aplikace', 'Sledované aplikace'], ['notifikace', 'Notifikace']];
const vykresli = (prepis = {}) => vykresliStranku('monitoring/settings', {
  pageTitle: 'Monitoring', currentPath: '/nastaveni/healthchecky', checks: [], channels: [], rules: [], tab: 'aplikace', zalozky: ZALOZKY, ...prepis,
});

test('aplikace: tabulka, + Přidat URL, nápověda a jen modal aplikace', async () => {
  const html = await vykresli({ checks: [{ id: 1, name: '<b>Web</b>', url: 'https://x.example.invalid', interval_s: 300, active: true }] });
  assert.ok(html.includes('&lt;b&gt;Web&lt;/b&gt;'), 'název se escapuje');
  assert.ok(html.includes('data-modal-open="modalAddCheck"'));
  assert.ok(html.includes('Jak to funguje'));
  assert.ok(html.includes('id="modalAddCheck"'));
  assert.ok(!html.includes('id="modalAddChannel"') && !html.includes('id="modalAddRule"'));
  assert.ok(!html.includes('Notifikační pravidla'));
  assert.match(html, /href="\/nastaveni\/healthchecky\?tab=aplikace" class="tab active" aria-current="page"/);
});

test('notifikace: pravidla a kanály vedle sebe, modaly kanálu a pravidla, bez + Přidat URL', async () => {
  const html = await vykresli({ tab: 'notifikace', channels: [{ id: 5, name: 'Mail', type: 'email' }],
    rules: [{ id: 2, event_type: 'app_down', threshold: null, channel_name: 'Mail' }] });
  assert.ok(html.includes('Notifikační pravidla'));
  assert.ok(html.includes('Notifikační kanály'));
  assert.ok(html.includes('id="modalAddChannel"') && html.includes('id="modalAddRule"'));
  assert.ok(!html.includes('modalAddCheck'));
  assert.ok(!html.includes('Žádné sledované URL'), 'tabulka aplikací je na své záložce');
  assert.match(html, /<option value="5">Mail \(email\)<\/option>/, 'modal pravidla nabízí kanály');
});

describe('proti serveru', { skip: PRESKOCIT }, () => {
  const r = crypto.randomBytes(4).toString('hex');
  let sql, req, reqBezny, sids = [], users = [], kontrola, kanal, pravidlo;

  before(async () => {
    sql = postgres(lokalniDatabaze(), { max: 2, onnotice: () => {} });
    await serverBezi();
    const [a] = await sql`INSERT INTO users (email, password_hash, is_admin) VALUES (${`hc-${r}@example.invalid`}, 'x', TRUE) RETURNING id`;
    const [b] = await sql`INSERT INTO users (email, password_hash, is_admin) VALUES (${`hc2-${r}@example.invalid`}, 'x', FALSE) RETURNING id`;
    users = [a.id, b.id];
    const s1 = await prihlas(sql, a.id); const s2 = await prihlas(sql, b.id);
    sids = [s1.sid, s2.sid];
    req = pozadavky(s1.cookie); reqBezny = pozadavky(s2.cookie);
    [kontrola] = await sql`INSERT INTO healthchecks (name, url, active) VALUES (${`hc ${r}`}, 'https://h.example.invalid', FALSE) RETURNING id`;
    [kanal] = await sql`INSERT INTO notification_channels (type, name, target) VALUES ('email', ${`k ${r}`}, 'x@example.invalid') RETURNING id`;
    [pravidlo] = await sql`INSERT INTO notification_rules (event_type, channel_id) VALUES ('app_down', ${kanal.id}) RETURNING id`;
  });

  after(async () => {
    if (!sql) return;
    await sql`DELETE FROM notification_rules WHERE channel_id IN (SELECT id FROM notification_channels WHERE name LIKE ${`%${r}%`})`;
    await sql`DELETE FROM notification_channels WHERE name LIKE ${`%${r}%`}`;
    await sql`DELETE FROM healthchecks WHERE name LIKE ${`%${r}%`}`;
    await sql`DELETE FROM session WHERE sid = ANY(${sids})`;
    await sql`DELETE FROM users WHERE id = ANY(${users})`;
    await sql.end();
  });

  test('GET: záložky, neznámý tab a pole padají na první, běžný uživatel 403', async () => {
    assert.ok((await (await req.get('/nastaveni/healthchecky')).text()).includes(`hc ${r}`));
    for (const q of ['?tab=xyz', '?tab=notifikace&tab=aplikace', '?tab=__proto__']) {
      const res = await req.get(`/nastaveni/healthchecky${q}`);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes('id="modalAddCheck"'), q);
    }
    const n = await (await req.get('/nastaveni/healthchecky?tab=notifikace')).text();
    assert.ok(n.includes(`k ${r}`));
    assert.ok(!n.includes(`hc ${r}`));
    assert.equal((await reqBezny.get('/nastaveni/healthchecky')).status, 403);
  });

  test('výchozí návrat: aplikace na první záložku, kanály a pravidla na Notifikace', async () => {
    let res = await req.post(`/nastaveni/healthchecky/${kontrola.id}/toggle`, {});
    assert.equal(res.headers.get('location'), '/nastaveni/healthchecky?tab=aplikace');
    res = await req.post('/nastaveni/notifikace/kanal/vytvorit', { type: 'email', name: `k2 ${r}`, target: 'y@example.invalid' });
    assert.equal(res.headers.get('location'), '/nastaveni/healthchecky?tab=notifikace');
    res = await req.post('/nastaveni/notifikace/pravidlo/vytvorit', { event_type: 'disk_high', threshold: '90', channel_id: String(kanal.id) });
    assert.equal(res.headers.get('location'), '/nastaveni/healthchecky?tab=notifikace');
    res = await req.post(`/nastaveni/notifikace/pravidlo/${pravidlo.id}/smazat`, {});
    assert.equal(res.headers.get('location'), '/nastaveni/healthchecky?tab=notifikace');
  });

  test('returnTo z detailu e-shopu platí, cizí web ne', async () => {
    let res = await req.post(`/nastaveni/healthchecky/${kontrola.id}/toggle`, { returnTo: '/nastaveni/eshopy/1?tab=healthchecky' });
    assert.equal(res.headers.get('location'), '/nastaveni/eshopy/1?tab=healthchecky');
    for (const cil of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      res = await req.post(`/nastaveni/healthchecky/${kontrola.id}/toggle`, { returnTo: cil });
      assert.equal(res.headers.get('location'), '/nastaveni/healthchecky?tab=aplikace', cil);
    }
  });
});
