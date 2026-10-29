// Migrace 042 poběží při startu nad živou databází, na které visí Toneráček
// i Dílna Vlněnka. Hlídá se tu, co z ní dělá bezpečnou změnu, aby to pozdější
// úprava souboru nerozbila potichu:
//
//  - jen přidává (CREATE/ADD COLUMN … IF NOT EXISTS, indexy, komentáře
//    a CHECK v bloku DO, který spolkne duplicate_object), nic nemaže,
//    nemění typy ani výchozí hodnoty a nepřepisuje data; nové sloupce
//    existujících tabulek mají jen konstantní výchozí hodnotu (žádný
//    přepis tabulky);
//  - lock_timeout nejvýš 2 s a platí od prvního příkazu;
//  - pořadí kvůli zámkům: nové tabulky → shop_order_items → shop_orders →
//    `shops` (čte ho každý požadavek Toneráčku) úplně nakonec;
//  - sloupce odpovídají kontraktu s e-shopem (21 sloupců atribuce přesně
//    podle src/atribuce-objednavky.js, cost_price) a každá tabulka
//    i sloupec má komentář.
//
// Statická část databázi nepotřebuje. Nad lokální databází (DATABASE_URL)
// se migrace navíc pustí dvakrát v transakci, která se na konci vrátí:
// podruhé nesmí nic změnit (IF NOT EXISTS, duplicate_object) a CHECK musí
// odmítnout cizí souhlas.
//
//   node --test test/migrace-042.test.js
//   DATABASE_URL=postgresql://…@127.0.0.1/… node --test test/migrace-042.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { SLOUPCE_ATRIBUCE } from '../src/atribuce-objednavky.js';

const SOUBOR = new URL('../migrations/042_marketing.sql', import.meta.url);
const OBSAH = readFileSync(SOUBOR, 'utf8');

/**
 * Příkazy bez komentářů, každý na jednom řádku. Na rozdíl od testu 040
 * nedělí uvnitř bloku DO $$ … $$ — ten má středníky uvnitř a je to jeden
 * příkaz.
 */
function prikazy() {
  const bezKomentaru = OBSAH.split('\n').map((radek) => radek.replace(/--.*$/, '')).join('\n');
  const out = [];
  let aktualni = '';
  let vBloku = false;
  for (let i = 0; i < bezKomentaru.length; i++) {
    if (bezKomentaru.startsWith('$$', i)) { vBloku = !vBloku; aktualni += '$$'; i++; continue; }
    const z = bezKomentaru[i];
    if (z === ';' && !vBloku) { out.push(aktualni); aktualni = ''; continue; }
    aktualni += z;
  }
  out.push(aktualni);
  return out.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const POVOLENE = /^(SET LOCAL lock_timeout|CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS|COMMENT ON (TABLE|COLUMN)|DO \$\$)/i;

describe('migrace 042 jen přidává', () => {
  test('každý příkaz je z povolené množiny', () => {
    const vse = prikazy();
    assert.ok(vse.length > 50, 'migrace má desítky příkazů');
    for (const p of vse) {
      assert.match(p, POVOLENE, `nečekaný příkaz: ${p.slice(0, 80)}`);
      // „ON DELETE CASCADE / SET NULL“ u cizích klíčů nových sloupců je v pořádku.
      const bezCizichKlicu = p.replace(/ON DELETE (CASCADE|SET NULL)/gi, '');
      assert.doesNotMatch(bezCizichKlicu, /\b(DROP|TRUNCATE|UPDATE|DELETE|RENAME|INSERT)\b|ALTER COLUMN|SET DEFAULT|\bTYPE\b/i,
        `nic nemaže, nepřejmenovává, nemění existující sloupce ani nepřepisuje data: ${p.slice(0, 80)}`);
    }
  });

  test('blok DO jen přidává pojmenovaný CHECK a spolkne duplicate_object', () => {
    const bloky = prikazy().filter((p) => /^DO \$\$/i.test(p));
    assert.equal(bloky.length, 1, 'jediný blok DO: CHECK na shop_orders.attribution_consent');
    assert.match(bloky[0],
      /^DO \$\$ BEGIN ALTER TABLE shop_orders ADD CONSTRAINT shop_orders_attribution_consent_chk CHECK \(attribution_consent IN \('', 'none', 'analytics', 'marketing', 'all'\)\); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$$/);
  });

  test('nové sloupce existujících tabulek mají jen konstantní výchozí hodnotu', () => {
    for (const p of prikazy().filter((x) => /^ALTER TABLE/i.test(x))) {
      assert.match(p, /^ALTER TABLE (shop_order_items|shop_orders|shops) ADD COLUMN IF NOT EXISTS \w+ (TEXT NOT NULL DEFAULT ''|TIMESTAMPTZ|NUMERIC\(10,2\)|NUMERIC\(5,2\) NOT NULL DEFAULT 0|BOOLEAN)$/,
        `sloupec bez funkce ve výchozí hodnotě a bez vloženého CHECK: ${p}`);
    }
  });

  test('komentáře jsou celé v jedněch uvozovkách (žádný středník ani dvojitá pomlčka uvnitř)', () => {
    for (const p of prikazy().filter((x) => /^COMMENT ON/i.test(x))) {
      assert.match(p, /^COMMENT ON (TABLE \w+|COLUMN \w+\.\w+) IS '[^']+'$/, p.slice(0, 100));
    }
  });
});

test('lock_timeout nejvýš 2 s a platí od prvního příkazu', () => {
  const vse = prikazy();
  const [nastaveni] = vse.filter((p) => /^SET LOCAL lock_timeout/i.test(p));
  assert.ok(nastaveni, 'migrace nastavuje lock_timeout');
  const [, cislo, jednotka = 'ms'] = nastaveni.match(/'(\d+)\s*(ms|s)?'/i);
  const ms = Number(cislo) * (jednotka.toLowerCase() === 's' ? 1000 : 1);
  assert.ok(ms > 0 && ms <= 2000, `lock_timeout ${ms} ms`);
  assert.equal(vse[0], nastaveni, 'lock_timeout platí od prvního příkazu');
});

describe('pořadí kvůli zámkům', () => {
  const vse = prikazy();
  const prvni = (re) => vse.findIndex((p) => re.test(p));
  const posledni = (re) => vse.length - 1 - [...vse].reverse().findIndex((p) => re.test(p));

  test('nové tabulky dřív než zásah do shop_order_items a shop_orders', () => {
    const tabulky = posledni(/^CREATE (TABLE|(UNIQUE )?INDEX) IF NOT EXISTS/i);
    assert.ok(tabulky > 0);
    assert.ok(prvni(/^ALTER TABLE shop_order_items\b/i) > tabulky, 'shop_order_items až po nových tabulkách');
    assert.ok(prvni(/^ALTER TABLE shop_orders\b/i) > tabulky, 'shop_orders až po nových tabulkách');
  });

  test('shop_order_items před shop_orders', () => {
    assert.ok(posledni(/^(ALTER TABLE|COMMENT ON COLUMN) shop_order_items\b/i) < prvni(/^ALTER TABLE shop_orders\b/i));
  });

  test('výhradní zámek na shops až úplně nakonec', () => {
    const alter = prvni(/^ALTER TABLE shops\b/i);
    assert.ok(alter > 0, 'migrace přidává sloupce shops');
    const potom = vse.slice(alter + 1);
    assert.ok(potom.every((p) => /^(ALTER TABLE shops ADD COLUMN IF NOT EXISTS|COMMENT ON COLUMN shops\.)/i.test(p)),
      `po ALTER TABLE shops smí být jen další sloupec shops nebo komentář k němu, ne: ${potom.find((p) => !/^(ALTER TABLE shops|COMMENT ON COLUMN shops\.)/i.test(p))}`);
  });
});

describe('sloupce podle kontraktu s e-shopem', () => {
  const vse = prikazy();
  const sloupec = (tabulka, nazev) => vse.find((p) => new RegExp(`^ALTER TABLE ${tabulka} ADD COLUMN IF NOT EXISTS ${nazev} `, 'i').test(p));

  test('21 sloupců atribuce přesně jako v src/atribuce-objednavky.js', () => {
    const pridane = vse
      .map((p) => p.match(/^ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS (\w+) /i)?.[1])
      .filter(Boolean);
    assert.deepEqual(pridane, SLOUPCE_ATRIBUCE, 'tytéž sloupce v témže pořadí');
    assert.equal(pridane.length, 21);
    for (const s of SLOUPCE_ATRIBUCE) {
      const ocekavany = s.startsWith('touch_') ? 'TIMESTAMPTZ' : "TEXT NOT NULL DEFAULT ''";
      assert.ok(sloupec('shop_orders', s).endsWith(` ${ocekavany}`), `${s} je ${ocekavany}`);
    }
  });

  test('nákupní cena položky na haléře, příznak DPH tříhodnotový', () => {
    assert.ok(sloupec('shop_order_items', 'cost_price').endsWith(' NUMERIC(10,2)'));
    assert.ok(sloupec('shop_order_items', 'cost_price_vat_included').endsWith(' BOOLEAN'));
  });

  test('marže a práh PNO u e-shopu', () => {
    assert.ok(sloupec('shops', 'marketing_margin_pct').endsWith(' NUMERIC(5,2) NOT NULL DEFAULT 0'));
    assert.ok(sloupec('shops', 'marketing_pno_alert_pct').endsWith(' NUMERIC(5,2) NOT NULL DEFAULT 0'));
  });

  test('tabulky, jejich klíče a výčty', () => {
    const tabulka = (nazev) => vse.find((p) => new RegExp(`^CREATE TABLE IF NOT EXISTS ${nazev} `, 'i').test(p));
    const zdroje = tabulka('marketing_sources');
    assert.match(zdroje, /platform IN \('ga4', 'google_ads', 'search_console', 'merchant', 'sklik', 'heureka', 'meta', 'eshop'\)/);
    assert.match(zdroje, /UNIQUE \(shop_id, platform\)/);

    const behy = tabulka('marketing_sync_runs');
    assert.match(behy, /kind IN \('auto', 'rucni'\)/);
    assert.match(behy, /status IN \('probiha', 'hotovo', 'chyba'\)/);
    assert.ok(vse.some((p) => /^CREATE UNIQUE INDEX IF NOT EXISTS \w+ ON marketing_sync_runs \(source_id, run_date\) WHERE kind = 'auto'$/i.test(p)));
    assert.ok(vse.some((p) => /^CREATE UNIQUE INDEX IF NOT EXISTS \w+ ON marketing_sync_runs \(source_id\) WHERE status = 'probiha'$/i.test(p)));

    const statistiky = tabulka('marketing_daily_stats');
    assert.match(statistiky, /platform IN \('ga4', 'google_ads', 'search_console', 'merchant', 'sklik', 'zbozi', 'heureka', 'meta', 'eshop'\)/);
    assert.match(statistiky, /segment_kind IN \('', 'campaign', 'channel', 'query', 'page', 'country', 'product'\)/);
    assert.match(statistiky, /UNIQUE \(shop_id, platform, date, segment_kind, segment\)/);
    for (const metrika of ['cost', 'cost_with_vat', 'impressions', 'clicks', 'conversions', 'conversion_value',
      'sessions', 'total_users', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'purchase_revenue',
      'position_sum', 'approved_items', 'disapproved_items', 'searches_no_result', 'carts_abandoned', 'carts_value']) {
      assert.match(statistiky, new RegExp(` ${metrika} (INTEGER|NUMERIC\\(\\d+,2\\)) NOT NULL DEFAULT 0`), `metrika ${metrika}`);
    }

    const naklady = tabulka('marketing_manual_costs');
    assert.match(naklady, /platform IN \('google_ads', 'sklik', 'zbozi', 'heureka', 'meta', 'ostatni'\)/);
    // Typy cizích klíčů podle skutečných tabulek: accounting_invoices.id je TEXT, receipts.id SERIAL.
    assert.match(naklady, /invoice_id TEXT REFERENCES accounting_invoices\(id\) ON DELETE SET NULL/);
    assert.match(naklady, /receipt_id INTEGER REFERENCES receipts\(id\) ON DELETE SET NULL/);
  });
});

test('každá nová tabulka a každý nový sloupec má komentář', () => {
  const komentare = new Set(
    prikazy().map((p) => p.match(/^COMMENT ON (?:TABLE|COLUMN) ([\w.]+) IS/i)?.[1]).filter(Boolean)
  );
  const chybi = [];
  for (const [, tabulka, telo] of OBSAH.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    if (!komentare.has(tabulka)) chybi.push(tabulka);
    for (const radek of telo.split('\n')) {
      const nazev = radek.match(/^\s{2}([a-z_]+)\s+[A-Z]/)?.[1];
      if (nazev && !komentare.has(`${tabulka}.${nazev}`)) chybi.push(`${tabulka}.${nazev}`);
    }
  }
  for (const [, tabulka, nazev] of OBSAH.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)) {
    if (!komentare.has(`${tabulka}.${nazev}`)) chybi.push(`${tabulka}.${nazev}`);
  }
  assert.deepEqual(chybi, [], 'bez komentáře');
});

const DATABASE_URL = process.env.DATABASE_URL || '';

test('nad databází: podruhé nic nezmění a CHECK odmítne cizí souhlas', { skip: !DATABASE_URL && 'bez DATABASE_URL' }, async () => {
  const host = new URL(DATABASE_URL).hostname;
  assert.ok(['127.0.0.1', 'localhost'].includes(host), `jen lokální databáze, ne "${host}"`);
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const ZRUSIT = new Error('rollback');
  try {
    await sql.begin(async (tx) => {
      const snimek = async () => ({
        sloupce: await tx`
          SELECT table_name, column_name, data_type, column_default, is_nullable
          FROM information_schema.columns
          WHERE table_name IN ('shops', 'shop_orders', 'shop_order_items', 'marketing_sources', 'marketing_sync_runs',
                               'marketing_daily_stats', 'marketing_manual_costs')
          ORDER BY table_name, ordinal_position`,
        omezeni: await tx`
          SELECT conname FROM pg_constraint WHERE conname LIKE 'marketing_%' OR conname LIKE 'shop_orders_attribution%' ORDER BY 1`,
      });

      await tx.unsafe(OBSAH);
      const poPrvnim = await snimek();
      assert.ok(poPrvnim.sloupce.some((s) => s.table_name === 'shop_orders' && s.column_name === 'attribution_consent'));
      assert.ok(poPrvnim.sloupce.some((s) => s.table_name === 'shop_order_items' && s.column_name === 'cost_price' && s.data_type === 'numeric'));
      assert.ok(poPrvnim.omezeni.some((o) => o.conname === 'shop_orders_attribution_consent_chk'));

      // Podruhé (např. po ručním zásahu před nasazením) nic nezmění ani nespadne.
      await tx.unsafe(OBSAH);
      assert.deepEqual(await snimek(), poPrvnim);

      const [shop] = await tx`INSERT INTO shops (slug, name) VALUES ('test-042', 'Test 042') RETURNING id`;
      await tx`INSERT INTO shop_orders (id, shop_id, order_number, attribution_consent, utm_source_last, touch_last_at)
               VALUES ('test-042-ok', ${shop.id}, '1', 'all', 'google', NOW())`;
      const [vychozi] = await tx`INSERT INTO shop_orders (id, shop_id, order_number) VALUES ('test-042-vychozi', ${shop.id}, '2')
                                 RETURNING attribution_consent, utm_source_first, click_id_last, touch_first_at, touch_last_at`;
      assert.deepEqual(vychozi, { attribution_consent: '', utm_source_first: '', click_id_last: '', touch_first_at: null, touch_last_at: null });
      await assert.rejects(
        tx.savepoint((sp) => sp`INSERT INTO shop_orders (id, shop_id, order_number, attribution_consent) VALUES ('test-042-spatne', ${shop.id}, '3', 'spam')`),
        /shop_orders_attribution_consent_chk/
      );

      throw ZRUSIT;
    });
  } catch (e) {
    if (e !== ZRUSIT) throw e;
  } finally {
    await sql.end();
  }
});
