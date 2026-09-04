/**
 * Jednorázové doplnění kódů dodavatele k položkám objednávek.
 *
 * Spuštění (.env si skript načte sám):
 *   node scripts/doplnit-kody-dodavatele.js --dry-run
 *   node scripts/doplnit-kody-dodavatele.js
 *
 * Přepínače:
 *   --dry-run   nic neukládá, jen vypíše, co by se změnilo
 *
 * Proč to existuje: kód dodavatele posílá e-shop až od nasazení expedice do
 * skladu (migrace 037). Objednávky přijaté dřív ho v `shop_order_items` nemají
 * a ranní e-mail by u nich vytiskl interní SKU s poznámkou „chybí kód
 * dodavatele" — sklad podle něj nic nenajde. Skript kódy dohledá v Airtable
 * a doplní; potom už je zbytečný.
 *
 * Přepisuje jen prázdné hodnoty. Co e-shop poslal, je pravda z doby
 * objednávky a nemá se přepisovat dnešním katalogem.
 *
 * Multipack vlastní kód nemá — vychystávají se jeho jednotlivé náplně, takže
 * se doplní jejich kódy oddělené „+", stejně jako to nově dělá e-shop.
 *
 * Potřebuje `AIRTABLE_API_KEY` s přístupem ke katalogu Toneráčku
 * (`AIRTABLE_BASE_TONERACEK`, výchozí appCbWGm1qExXCRqQ). Seil ho ve svém .env
 * běžně nemá, takže se předává na příkazové řádce:
 *   AIRTABLE_API_KEY=pat… node scripts/doplnit-kody-dodavatele.js
 */

import process from 'node:process';
import postgres from 'postgres';

const DRY_RUN = process.argv.includes('--dry-run');

const BASE = process.env.AIRTABLE_BASE_TONERACEK || 'appCbWGm1qExXCRqQ';
const KEY = process.env.AIRTABLE_API_KEY;

const TABULKA_PRODUKTY = 'tbl79vovxHhBA7pmw';
const TABULKA_MULTIPAKY = 'tblgCHtz6xflIK1TN';

// Field ID přežije přejmenování pole, ne jeho smazání a založení znovu.
const POLE = {
  sku: 'fldWwTW6XQqbCwH8j',
  kod: 'fldCmLHPL30bq7pvO',          // ID Dodavatele
  multipackSku: 'fld5Z51awGoVK9jFA',
  multipackProdukty: 'fldK1rvkjBO66urKI',
};

async function airtable(tabulka, formula, pole) {
  const params = new URLSearchParams();
  params.set('filterByFormula', formula);
  params.set('returnFieldsByFieldId', 'true');
  params.set('pageSize', '100');
  for (const f of pole) params.append('fields[]', f);

  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${tabulka}?${params}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(`Airtable: ${JSON.stringify(data.error)}`);
  return data.records ?? [];
}

const jeSku = (pole, skus) => `OR(${skus.map(s => `{${pole}}="${s}"`).join(',')})`;

/** Mapa SKU → kód dodavatele. U multipacků kódy jejich náplní spojené „+". */
async function kodyProSku(skus) {
  const kody = new Map();
  if (!skus.length) return kody;

  for (const rec of await airtable(TABULKA_PRODUKTY, jeSku(POLE.sku, skus), [POLE.sku, POLE.kod])) {
    const kod = rec.fields[POLE.kod];
    if (kod) kody.set(rec.fields[POLE.sku], String(kod).trim());
  }

  const multipacky = await airtable(
    TABULKA_MULTIPAKY, jeSku(POLE.multipackSku, skus), [POLE.multipackSku, POLE.multipackProdukty]);
  const idNaplni = multipacky.flatMap(r => r.fields[POLE.multipackProdukty] ?? []);

  if (idNaplni.length) {
    const naplne = new Map();
    const formula = `OR(${idNaplni.map(id => `RECORD_ID()="${id}"`).join(',')})`;
    for (const rec of await airtable(TABULKA_PRODUKTY, formula, [POLE.kod])) {
      const kod = rec.fields[POLE.kod];
      if (kod) naplne.set(rec.id, String(kod).trim());
    }
    for (const rec of multipacky) {
      const slozeni = (rec.fields[POLE.multipackProdukty] ?? [])
        .map(id => naplne.get(id)).filter(Boolean);
      if (slozeni.length) kody.set(rec.fields[POLE.multipackSku], slozeni.join(' + '));
    }
  }

  return kody;
}

async function main() {
  if (!KEY) {
    console.error('Chybí AIRTABLE_API_KEY — bez něj se kódy nemají kde vzít.');
    process.exit(1);
  }

  const sql = postgres(process.env.DATABASE_URL, {
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 2, onnotice: () => {},
  });

  const polozky = await sql`
    SELECT i.id, i.sku, i.name, o.order_number
    FROM shop_order_items i
    JOIN shop_orders o ON o.id = i.order_id
    WHERE i.supplier_code = '' AND i.sku <> ''
    ORDER BY o.order_number, i.id
  `;

  if (!polozky.length) {
    console.log('Není co doplnit — všechny položky se SKU už kód dodavatele mají.');
    await sql.end();
    return;
  }

  const skus = [...new Set(polozky.map(p => p.sku))];
  console.log(`Položek bez kódu: ${polozky.length}, různých SKU: ${skus.length}`);

  const kody = await kodyProSku(skus);
  let doplneno = 0;
  const chybi = [];

  for (const polozka of polozky) {
    const kod = kody.get(polozka.sku);
    if (!kod) {
      chybi.push(`#${polozka.order_number} ${polozka.sku} (${polozka.name})`);
      continue;
    }
    console.log(`  #${polozka.order_number}  ${polozka.sku.padEnd(10)} → ${kod}`);
    if (!DRY_RUN) {
      // Podmínka na prázdno platí i tady: mezitím mohl kód doplnit e-shop.
      await sql`
        UPDATE shop_order_items SET supplier_code = ${kod}
        WHERE id = ${polozka.id} AND supplier_code = ''
      `;
    }
    doplneno++;
  }

  console.log(DRY_RUN
    ? `\n[dry-run] Doplnilo by se ${doplneno} položek.`
    : `\nDoplněno ${doplneno} položek.`);

  if (chybi.length) {
    console.log(`\nBez kódu zůstává ${chybi.length} položek (v katalogu nejsou):`);
    for (const radek of chybi) console.log('  ' + radek);
  }

  await sql.end();
}

main().catch(err => {
  console.error('Doplnění kódů selhalo:', err.message);
  process.exit(1);
});
