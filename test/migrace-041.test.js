// Migrace 041 poběží při startu nad živou databází, na které visí Toneráček.
// Hlídá se tu, že mění jen Dílnu Vlněnku:
//
//  - jen UPDATE, každý vázaný na slug 'dilnavlnenka', a lock_timeout nejvýš 2 s;
//  - nad testovací databází: řada faktur Dílny dostane YYMMNNN (2610001),
//    identita barvy a loga, ahoj@ se nahradí a jiné vyplněné hodnoty
//    zůstanou; řady a identita Toneráčku se nezmění ani o znak.
//
// Databázová část jede v transakci, která se na konci vrátí — nic po sobě
// nenechá. Bez DATABASE_URL se přeskočí.
//
//   DATABASE_URL=postgresql://…@127.0.0.1/… node --test test/migrace-041.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { renderSeriesNumber } from '../src/series-format.js';

const SOUBOR = new URL('../migrations/041_dilna_cislo_faktury_a_identita.sql', import.meta.url);
const OBSAH = readFileSync(SOUBOR, 'utf8');

/** Příkazy bez komentářů, každý na jednom řádku. */
function prikazy() {
  return OBSAH
    .split('\n').map((radek) => radek.replace(/--.*$/, '')).join('\n')
    .split(';').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

test('migrace 041 jen upravuje řádky Dílny', () => {
  const [prvni, ...zbytek] = prikazy();
  assert.match(prvni, /^SET LOCAL lock_timeout = '(\d+)(ms|s)'$/i);
  const [, cislo, jednotka] = prvni.match(/'(\d+)(ms|s)'/i);
  assert.ok(Number(cislo) * (jednotka.toLowerCase() === 's' ? 1000 : 1) <= 2000, 'lock_timeout nejvýš 2 s');
  assert.ok(zbytek.length > 0);
  for (const p of zbytek) {
    assert.match(p, /^UPDATE (invoice_number_series|shops)\b/i, `jen UPDATE: ${p.slice(0, 80)}`);
    assert.match(p, /\bslug = 'dilnavlnenka'/, `vázané na slug Dílny: ${p.slice(0, 80)}`);
    assert.doesNotMatch(p, /toneracek/i);
  }
});

const DATABASE_URL = process.env.DATABASE_URL || '';

test('nad databází: Dílna dostane YYMMNNN a vzhled, Toneráček zůstane', { skip: !DATABASE_URL && 'bez DATABASE_URL' }, async () => {
  const host = new URL(DATABASE_URL).hostname;
  assert.ok(['127.0.0.1', 'localhost'].includes(host), `jen lokální databáze, ne "${host}"`);
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const ZRUSIT = new Error('rollback');
  try {
    await sql.begin(async (tx) => {
      const snimekToneracku = async () => ({
        shop: await tx`SELECT * FROM shops WHERE slug = 'toneracek'`,
        rady: await tx`SELECT s.* FROM invoice_number_series s JOIN shops sh ON sh.id = s.shop_id
                       WHERE sh.slug = 'toneracek' ORDER BY s.id`,
      });

      await tx`INSERT INTO shops (slug, name, url) VALUES ('toneracek', 'Toneráček.cz', 'https://toneracek.cz')
               ON CONFLICT (slug) DO NOTHING`;
      // Návnada: hodnoty, které by migrace bez podmínky na slug přepsala.
      // Server při startu migraci už pustil, takže bez nich by Toneráček
      // vypadal „beze změny“, i kdyby mu ji migrace mezitím přepsala.
      const [tonerShop] = await tx`
        UPDATE shops SET color_primary = '#0891b2', logo_mark_url = '', email_reply_to = 'ahoj@dilnavlnenka.cz',
               support_email = 'ahoj@dilnavlnenka.cz', email_from_address = 'ahoj@dilnavlnenka.cz'
        WHERE slug = 'toneracek' RETURNING id`;
      await tx`INSERT INTO invoice_number_series (name, prefix, format, current_number, shop_id, entity_type, active)
               VALUES ('Vydané faktury Toneráček (test 041)', '', 'YYMMXXX', 5, ${tonerShop.id}, 'faktura', TRUE)`;

      await tx`DELETE FROM shops WHERE slug = 'dilnavlnenka'`;
      const [dilna] = await tx`
        INSERT INTO shops (slug, name, url, email_from_address, email_reply_to, support_email, tagline)
        VALUES ('dilnavlnenka', 'Dílna Vlněnka', 'https://dilnavlnenka.cz',
                'noreply@dilnavlnenka.cz', 'Ahoj@dilnavlnenka.cz', 'jinde@example.invalid', 'Místo, kde vznikají krásné věci')
        RETURNING id`;
      const [faktura] = await tx`
        INSERT INTO invoice_number_series (name, prefix, format, current_number, shop_id, entity_type, active)
        VALUES ('Dílna Vlněnka - Faktura', '', 'YYMMXXX', 0, ${dilna.id}, 'faktura', TRUE) RETURNING id`;
      const [stara] = await tx`
        INSERT INTO invoice_number_series (name, prefix, format, current_number, shop_id, entity_type, active)
        VALUES ('Dílna Vlněnka - stará', '', 'YYYYNNNN', 0, ${dilna.id}, 'faktura', FALSE) RETURNING id`;
      const [zalohova] = await tx`
        INSERT INTO invoice_number_series (name, prefix, format, current_number, shop_id, entity_type, active)
        VALUES ('Dílna Vlněnka - Zálohová', 'ZF', 'ZF-YYYYNNNN', 0, ${dilna.id}, 'zalohova_faktura', TRUE) RETURNING id`;

      const predtim = await snimekToneracku();
      await tx.unsafe(OBSAH);
      assert.deepEqual(await snimekToneracku(), predtim, 'Toneráček beze změny');

      const rady = Object.fromEntries(
        (await tx`SELECT id, format, current_number FROM invoice_number_series WHERE shop_id = ${dilna.id}`).map((r) => [r.id, r])
      );
      assert.equal(rady[faktura.id].format, 'YYMMNNN');
      assert.equal(rady[stara.id].format, 'YYYYNNNN', 'neaktivní řada zůstane');
      assert.equal(rady[zalohova.id].format, 'ZF-YYYYNNNN', 'zálohové faktury zůstanou');
      assert.equal(
        renderSeriesNumber({ ...rady[faktura.id], current_number: 1 }, new Date('2026-10-29T10:00:00Z')),
        '2610001'
      );

      const [shop] = await tx`SELECT * FROM shops WHERE id = ${dilna.id}`;
      assert.equal(shop.color_primary, '#A85E56');
      assert.equal(shop.color_primary_dark, '#8E4C45');
      assert.equal(shop.color_primary_light, '#C4756B');
      assert.equal(shop.color_on_primary_soft, '#FCF3F1');
      assert.equal(shop.logo_mark_url, 'https://dilnavlnenka.cz/images/brand/znak-email.png');
      assert.equal(shop.logo_wordmark_url, 'https://dilnavlnenka.cz/images/brand/logo-email.png');
      assert.equal(shop.email_reply_to, 'info@dilnavlnenka.cz', 'ahoj@ → info@');
      assert.equal(shop.support_email, 'jinde@example.invalid', 'jiná vyplněná adresa zůstane');
      assert.equal(shop.email_from_address, 'noreply@dilnavlnenka.cz');
      assert.equal(shop.tagline, 'Místo, kde vznikají krásné věci');

      // Podruhé už nic nezmění.
      const [pred] = await tx`SELECT * FROM shops WHERE id = ${dilna.id}`;
      await tx.unsafe(OBSAH);
      assert.deepEqual((await tx`SELECT * FROM shops WHERE id = ${dilna.id}`)[0], pred);

      throw ZRUSIT;
    });
  } catch (e) {
    if (e !== ZRUSIT) throw e;
  } finally {
    await sql.end();
  }
});
