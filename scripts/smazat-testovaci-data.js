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
 *   --cisla 1,2,3    jen vyjmenovaná čísla objednávek — a jen zákazníci
 *                    těchto objednávek, nikdo jiný
 *   --smazat         provede mazání (jinak jen výpis)
 *   --rady           vrátí čítače číselných řad e-shopu na nulu
 *
 * Kterých zákazníků se úklid týká — jen zákazníků TOHOTO e-shopu:
 *   • kontaktů z mazaných objednávek,
 *   • bez --cisla navíc účtů a zákazníků e-shopu: řádek v crm_contact_shops
 *     (účty /api/eshop), zdroj = název e-shopu a u Toneráčku i registrace
 *     v crm_contacts (jeho účty z /api/toneracek tam žijí odjakživa).
 *
 * Co skript NEDĚLÁ schválně:
 *   • nemaže bankovní transakce — ty jsou skutečná data z výpisu; jen u nich
 *     zruší napárování na mazanou fakturu,
 *   • nemaže kontakt, který má i CRM historii (smlouvu, projekt, fakturu mimo
 *     e-shop), objednávku nebo účet v jiném e-shopu, ani objednávku v tomhle
 *     e-shopu, která se nemaže. Takovému kontaktu zruší nanejvýš účet v tomhle
 *     e-shopu, a to jen když mu tu po úklidu žádná objednávka nezůstane —
 *     skutečnému zákazníkovi úklid jedné testovací objednávky účet nevezme,
 *   • nesahá na účty jiných e-shopů: příznak crm_contacts.is_registered patří
 *     Toneráčku a při úklidu jiného e-shopu se nemění.
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
   * Zákazníci e-shopu — registrovaní i hosté, ale jen TOHOTO e-shopu.
   *
   * Dřív tu bylo `WHERE c.is_registered = TRUE OR c.source = <e-shop>`.
   * `is_registered` ale na e-shop vázané není, takže výběr bral registrované
   * zákazníky všech e-shopů a `--cisla` omezovalo jen objednávky. Ostré
   * spuštění by smazalo zákazníky Toneráčku bez objednávek a těm
   * s objednávkami zrušilo registraci — i při úklidu jediné objednávky
   * samotného Toneráčku.
   *
   * Kde má e-shop účty: Toneráček v crm_contacts (/api/toneracek, příznak
   * is_registered), ostatní e-shopy v crm_contact_shops (/api/eshop).
   */
  const uctyVKontaktech = shop.slug === 'toneracek';
  const vybraneObjednavky = orderIds.length ? orderIds : [''];

  const rozsah = numbers
    ? sql`c.id IN (SELECT crm_contact_id FROM shop_orders WHERE id = ANY(${vybraneObjednavky}))`
    : sql`(
        c.id IN (SELECT crm_contact_id FROM shop_orders WHERE id = ANY(${vybraneObjednavky}))
        OR (cs.contact_id IS NOT NULL ${before ? sql`AND cs.registered_at < ${before}` : sql``})
        OR (c.source = ${shop.name} ${before ? sql`AND c.created_at < ${before}` : sql``})
        ${uctyVKontaktech
          ? sql`OR (c.is_registered = TRUE ${before ? sql`AND c.created_at < ${before}` : sql``})`
          : sql``}
      )`;

  const contacts = await sql`
    SELECT c.id, c.email, c.first_name, c.last_name, c.created_at,
           ${uctyVKontaktech ? sql`c.is_registered` : sql`COALESCE(cs.is_registered, FALSE)`} AS registrovany,
           (cs.contact_id IS NOT NULL) AS ma_radek_eshopu,
           cs.registered_at AS registrovany_od,
           (SELECT COUNT(*)::int FROM crm_contracts    x WHERE x.contact_id = c.id) AS smlouvy,
           (SELECT COUNT(*)::int FROM projects         x WHERE x.primary_contact_id = c.id) AS projekty,
           (SELECT COUNT(*)::int FROM accounting_invoices x
              WHERE x.crm_contact_id = c.id AND (x.order_id IS NULL OR NOT (x.order_id = ANY(${vybraneObjednavky})))) AS faktury_mimo,
           (SELECT COUNT(*)::int FROM shop_orders x
              WHERE x.crm_contact_id = c.id AND x.shop_id = ${shop.id} AND NOT (x.id = ANY(${vybraneObjednavky}))) AS objednavky_tady,
           (SELECT COUNT(*)::int FROM shop_orders x
              WHERE x.crm_contact_id = c.id AND x.shop_id <> ${shop.id}) AS objednavky_jinde,
           ((SELECT COUNT(*)::int FROM crm_contact_shops x
               WHERE x.contact_id = c.id AND x.shop_id <> ${shop.id} AND x.is_registered = TRUE)
            + ${uctyVKontaktech ? sql`0` : sql`(CASE WHEN c.is_registered THEN 1 ELSE 0 END)`}) AS ucty_jinde
    FROM crm_contacts c
    LEFT JOIN crm_contact_shops cs ON cs.contact_id = c.id AND cs.shop_id = ${shop.id}
    WHERE ${rozsah}
    ORDER BY c.created_at
  `;

  // Smazat celý kontakt jde jen tehdy, když po úklidu nezůstane nic jiného:
  // CRM historie, jiná objednávka tady, objednávka nebo účet v jiném e-shopu.
  const jeCista = (c) => !c.smlouvy && !c.projekty && !c.faktury_mimo
    && !c.objednavky_tady && !c.objednavky_jinde && !c.ucty_jinde;
  // Účet v tomhle e-shopu se ruší, jen když tu po úklidu žádná objednávka
  // nezůstane. U --do jen účet založený před tím dnem (Toneráček čas
  // registrace nezná, tam rozhoduje vznik kontaktu, podle kterého se vybíral).
  const uctemPredDnem = (c) => !before || uctyVKontaktech
    || (c.registrovany_od && new Date(c.registrovany_od) < new Date(before));
  const kSmazani = contacts.filter(jeCista);
  const kOdregistrovani = contacts.filter((c) => !jeCista(c) && !c.objednavky_tady
    && (uctyVKontaktech ? c.registrovany : c.ma_radek_eshopu) && uctemPredDnem(c));
  const kPonechani = contacts.filter((c) => !kSmazani.includes(c) && !kOdregistrovani.includes(c));

  const proc = (c) => [
    c.smlouvy && `${c.smlouvy}× smlouva`, c.projekty && `${c.projekty}× projekt`,
    c.faktury_mimo && `${c.faktury_mimo}× faktura mimo e-shop`,
    c.objednavky_tady && `${c.objednavky_tady}× jiná objednávka tady`,
    c.objednavky_jinde && `${c.objednavky_jinde}× objednávka v jiném e-shopu`,
    c.ucty_jinde && `${c.ucty_jinde}× účet v jiném e-shopu`,
  ].filter(Boolean).join(', ');

  console.log(`\nZákazníci e-shopu (${contacts.length}):`);
  for (const c of kSmazani) {
    console.log(`   smazat        ${den(c.created_at)}  ${(c.registrovany ? 'registrovaný' : 'host').padEnd(12)} ${c.email}`);
  }
  for (const c of kOdregistrovani) {
    console.log(`   ${uctyVKontaktech ? 'odregistrovat' : 'odpojit      '} ${den(c.created_at)}  ${c.email}  (kontakt zůstane, má ${proc(c)})`);
  }
  for (const c of kPonechani) {
    console.log(`   ponechat      ${den(c.created_at)}  ${c.email}  (má ${proc(c) || 'účet založený po --do'})`);
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
      if (uctyVKontaktech) {
        await tx`UPDATE crm_contacts SET is_registered = FALSE WHERE id = ${c.id}`;
      } else {
        // Účet (nebo jen vazba hosta) i se záložním hashem hesla a souhlasy —
        // jen v tomhle e-shopu; účty jiných e-shopů a Toneráčku zůstávají.
        await tx`DELETE FROM crm_contact_shops WHERE contact_id = ${c.id} AND shop_id = ${shop.id}`;
      }
    }
    if (resetSeries) {
      await tx`UPDATE invoice_number_series SET current_number = 0 WHERE shop_id = ${shop.id}`;
    }
  });

  console.log(`\n✓ Smazáno: ${orders.length} objednávek, ${invoices.length} dokladů, ${kSmazani.length} zákazníků (z toho ${kSmazani.filter((c) => !c.registrovany).length} hostů).`);
  if (kOdregistrovani.length) {
    console.log(`  ${uctyVKontaktech ? 'Odregistrováno' : 'Odpojeno od e-shopu (účet i souhlasy)'} — kontakt zůstal: ${kOdregistrovani.length}`);
  }
  if (kPonechani.length) console.log(`  Ponecháno beze změny: ${kPonechani.length}`);
  if (resetSeries) console.log('  Čítače číselných řad e-shopu vynulovány.');
  console.log('\nNa straně e-shopu ještě smaž hesla a tokeny:');
  console.log('  (v kontejneru e-shopu) node scripts/smazat-testovaci-uzivatele.mjs '
    + [...kSmazani, ...kOdregistrovani].map((c) => c.email).join(' '));
} finally {
  await sql.end();
}
