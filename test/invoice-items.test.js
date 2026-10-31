// Editor položek faktury (views/includes/invoice-items.ejs) bez serveru a databáze:
// názvy položek jdou do inline skriptu, který se spustí při každém otevření
// detailu. Bez ošetření by název s </script> skript ukončil a zbytek textu by
// prohlížeč spustil jako HTML v session toho, kdo fakturu otevře.
//
//   node --test test/invoice-items.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const sablona = fileURLToPath(new URL('../views/includes/invoice-items.ejs', import.meta.url));

test('název i jednotka položky neukončí inline skript a data zůstanou stejná', async () => {
  const name = 'AAA</script><img src=x onerror=alert(1)>BBB';
  const unit = '</script><!--';
  const html = await ejs.renderFile(sablona, { items: [{ name, quantity: 1, unit, price_per_unit: 100, vat_rate: 21 }] });
  assert.ok(!html.includes('</script><img'), 'název neukončí skript');
  assert.ok(!html.includes('</script><!--'), 'jednotka neukončí skript');
  const initial = /const initial = (\[.*?\]);/s.exec(html)?.[1];
  assert.ok(initial, 'seznam položek je ve skriptu');
  assert.deepEqual(JSON.parse(initial), [{ name, quantity: 1, unit, price: 100, vat: 21 }], 'po načtení v prohlížeči jsou hodnoty původní');
});
