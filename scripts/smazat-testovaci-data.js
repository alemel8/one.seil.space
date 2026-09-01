/**
 * Smaže testovací objednávky e-shopu a registrace zákazníků.
 *
 * Bez `--smazat` jen vypíše, co by zmizelo — spouštěj vždycky nejdřív takhle.
 *
 * V produkčním kontejneru bez --env-file: Dockerfile .env maže a proměnné
 * vkládá Coolify rovnou do prostředí procesu.
 *
 *   node scripts/smazat-testovaci-data.js --eshop toneracek
 *   node scripts/smazat-testovaci-data.js --eshop toneracek --do 2026-08-27 --smazat
 *
 * Lokálně, kde .env existuje:
 *
 *   node --env-file=.env scripts/smazat-testovaci-data.js --eshop toneracek
 *
 * Volby:
 *   --eshop <slug>   povinné, aby nešlo omylem sáhnout na cizí e-shop
 *   --do <YYYY-MM-DD>  jen objednávky vytvořené PŘED tímhle dnem
 *   --cisla 1,2,3    jen vyjmenovaná čísla objednávek
 *   --smazat         provede mazání (jinak jen výpis)
 *   --rady           vrátí čítače číselných řad e-shopu na nulu
 *
 * Co skript NEDĚLÁ schválně:
 *   • nemaže bankovní transakce — ty jsou skutečná data z výpisu; jen u nich
 *     zruší napárování na mazanou fakturu,
 *   • nemaže kontakt, který má i CRM historii (smlouvu, projekt, fakturu mimo
 *     e-shop). U takového jen zhasne příznak registrace, protože smazat
 *     obchodního partnera kvůli testovací registraci by byla větší škoda.
 */

import postgres from 'postgres';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const shopSlug = value('--eshop');
const before   = value('--do');
const numbers  = value('--cisla')?.split(',').map((s) => s.trim()).filter(Boolean);
const apply    = flag('--smazat');
const resetSeries = flag('--rady');

if (!shopSlug) {
  console.error('Chybí --eshop <slug>. Například: --eshop toneracek');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL není v prostředí. V kontejneru ji vkládá Coolify,');
  console.error('lokálně přidej --env-file=.env před jméno skriptu.');
  process.exit(1);
}
if (before && Number.isNaN(Date.parse(before))) {
  console.error(`--do "${before}" není datum ve tvaru YYYY-MM-DD`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 1, onnotice: () => {},
});

const money = (v) => `${Number(v || 0).toLocaleString('cs-CZ')} Kč`;
const den = (v) => (v ? new Date(v).toLocaleDateString('cs-CZ') : '?');

try {
  const [shop] = await sql`SELECT id, slug, name FROM shops WHERE slug = ${shopSlug} LIMIT 1`;
  if (!shop) {
    console.error(`E-shop "${shopSlug}" v tabulce shops není.`);
    process.exit(1);
  }

  console.log(`E-shop: ${shop.name} (id ${shop.id})`);
  console.log(`Režim:  ${apply ? '⚠  OSTRÉ MAZÁNÍ' : 'nanečisto, nic se nesmaže'}`);
  if (before)  console.log(`Rozsah: objednávky vytvořené před ${den(before)}`);
  if (numbers) console.log(`Rozsah: objednávky ${numbers.join(', ')}`);
  if (!before && !numbers) console.log('Rozsah: VŠECHNY objednávky e-shopu');
  console.log();

  const orders = await sql`
    SELECT id, order_number, status, email, total_price, created_at
    FROM shop_orders
    WHERE shop_id = ${shop.id}
      ${before  ? sql`AND created_at < ${before}` : sql``}
      ${numbers ? sql`AND order_number = ANY(${numbers})` : sql``}
    ORDER BY created_at
  `;

  const orderIds = orders.map((o) => o.id);
  const invoices = orderIds.length ? await sql`
    SELECT id, number, type, status, total_amount FROM accounting_invoices WHERE order_id = ANY(${orderIds})
  ` : [];
  const invoiceIds = invoices.map((i) => i.id);

  console.log(`Objednávky (${orders.length}):`);
  for (const o of orders) {
    console.log(`   #${o.order_number}  ${den(o.created_at)}  ${o.status.padEnd(12)} ${String(money(o.total_price)).padStart(12)}  ${o.email}`);
  }
  console.log(`\nDoklady k nim (${invoices.length}):`);
  for (const i of invoices) {
    console.log(`   ${i.number.padEnd(16)} ${i.type.padEnd(9)} ${i.status}`);
  }

  /*
   * Zákazníci e-shopu — registrovaní i hosté.
   *
   * Dřív tu bylo `WHERE c.is_registered = TRUE`, takže hosté ze skriptu
   * propadli. Objednávka bez účtu kontakt v CRM zakládá s
   * `is_registered = FALSE` a úklid je pak neviděl: po smazání testovacích
   * objednávek zůstaly osiřelé profily v CRM a nešlo je odsud dostat pryč.
   *
   * Rozlišit hosta konkrétního e-shopu jde teprve od migrace 035, která
   * kontaktům dala sloupec `source`. Bere se tedy podle zdroje, ne podle
   * příznaku registrace — a `--do` platí pro obojí stejně.
   */
  const contacts = await sql`
    SELECT c.id, c.email, c.first_name, c.last_name, c.created_at, c.is_registered,
           (SELECT COUNT(*)::int FROM crm_contracts    x WHERE x.contact_id = c.id) AS smlouvy,
           (SELECT COUNT(*)::int FROM projects         x WHERE x.primary_contact_id = c.id) AS projekty,
           (SELECT COUNT(*)::int FROM accounting_invoices x
              WHERE x.crm_contact_id = c.id AND (x.order_id IS NULL OR NOT (x.order_id = ANY(${orderIds.length ? orderIds : ['']})))) AS faktury_mimo,
           (SELECT COUNT(*)::int FROM shop_orders x
              WHERE x.crm_contact_id = c.id AND NOT (x.id = ANY(${orderIds.length ? orderIds : ['']}))) AS objednavky_mimo
    FROM crm_contacts c
    WHERE (c.is_registered = TRUE OR c.source = ${shop.name})
      ${before ? sql`AND c.created_at < ${before}` : sql``}
    ORDER BY c.created_at
  `;

  // Objednávka, která se teď nemaže, je taky důvod kontakt nechat být —
  // jinak by úklid jedné testovací objednávky smazal zákazníka, který má
  // ještě jinou, skutečnou.
  const jeCista = (c) => !c.smlouvy && !c.projekty && !c.faktury_mimo && !c.objednavky_mimo;
  const kSmazani = contacts.filter(jeCista);
  const kOdregistrovani = contacts.filter((c) => !jeCista(c) && c.is_registered);

  console.log(`\nZákazníci e-shopu (${contacts.length}):`);
  for (const c of kSmazani) {
    console.log(`   smazat        ${den(c.created_at)}  ${(c.is_registered ? 'registrovaný' : 'host').padEnd(12)} ${c.email}`);
  }
  for (const c of kOdregistrovani) {
    const proc = [c.smlouvy && `${c.smlouvy}× smlouva`, c.projekty && `${c.projekty}× projekt`, c.faktury_mimo && `${c.faktury_mimo}× faktura mimo e-shop`, c.objednavky_mimo && `${c.objednavky_mimo}× jiná objednávka`].filter(Boolean).join(', ');
    console.log(`   odregistrovat ${den(c.created_at)}  ${c.email}  (má ${proc})`);
  }

  if (!apply) {
    console.log('\nNanečisto — nic se nesmazalo. Ostré spuštění: přidej --smazat');
    console.log('E-shop si drží hesla a tokeny zvlášť, ty smaž skriptem na jeho straně.');
    process.exit(0);
  }

  await sql.begin(async (tx) => {
    if (invoiceIds.length) {
      // Bankovní pohyby jsou skutečná data z výpisu, jen je odpárujeme
      await tx`UPDATE accounting_bank_transactions SET matched_invoice_id = NULL WHERE matched_invoice_id = ANY(${invoiceIds})`;
      await tx`UPDATE hr_work_reports SET invoice_id = NULL WHERE invoice_id = ANY(${invoiceIds})`;
      await tx`DELETE FROM invoice_emails       WHERE invoice_id = ANY(${invoiceIds})`;
      await tx`DELETE FROM invoice_reminders    WHERE invoice_id = ANY(${invoiceIds})`;
      await tx`DELETE FROM accounting_invoice_items WHERE invoice_id = ANY(${invoiceIds})`;
      // Faktura odkazuje na svou zálohovku, tohle pořadí drží samo
      await tx`UPDATE accounting_invoices SET proforma_invoice_id = NULL WHERE id = ANY(${invoiceIds})`;
      await tx`DELETE FROM accounting_invoices WHERE id = ANY(${invoiceIds})`;
    }
    if (orderIds.length) {
      await tx`DELETE FROM shop_order_items WHERE order_id = ANY(${orderIds})`;
      await tx`DELETE FROM shop_orders      WHERE id = ANY(${orderIds})`;
    }
    for (const c of kSmazani) {
      await tx`DELETE FROM crm_contact_shops WHERE contact_id = ${c.id}`;
      await tx`DELETE FROM crm_contacts      WHERE id = ${c.id}`;
    }
    for (const c of kOdregistrovani) {
      await tx`UPDATE crm_contacts SET is_registered = FALSE WHERE id = ${c.id}`;
    }
    if (resetSeries) {
      await tx`UPDATE invoice_number_series SET current_number = 0 WHERE shop_id = ${shop.id}`;
    }
  });

  console.log(`\n✓ Smazáno: ${orders.length} objednávek, ${invoices.length} dokladů, ${kSmazani.length} zákazníků (z toho ${kSmazani.filter((c) => !c.is_registered).length} hostů).`);
  if (kOdregistrovani.length) console.log(`  Odregistrováno (kontakt zůstal): ${kOdregistrovani.length}`);
  if (resetSeries) console.log('  Čítače číselných řad e-shopu vynulovány.');
  console.log('\nNa straně e-shopu ještě smaž hesla a tokeny:');
  console.log('  (v kontejneru e-shopu) node scripts/smazat-testovaci-uzivatele.mjs ' + kSmazani.map((c) => c.email).join(' '));
} finally {
  await sql.end();
}
