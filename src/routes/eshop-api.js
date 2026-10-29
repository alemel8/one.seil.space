/**
 * API pro e-shopy napojené stejně jako Toneráček — /api/eshop/*.
 *
 * Stejných 11 endpointů, těla, stavové kódy i tvary odpovědí jako
 * /api/toneracek/*, takže kopie e-shopu Toneráčku (Dílna Vlněnka) mění jen
 * cestu a klíč. Rozdíly jsou dva a oba schválně:
 *
 *  1. **E-shop určuje klíč**, ne slug v kódu. Klíč je řádek v eshop_api_keys
 *     (migrace 040) a KAŽDÝ dotaz je omezený na jeho shop_id — včetně
 *     uživatelů a platebních údajů. Klíč Dílny tedy na objednávku, doklad ani
 *     účet Toneráčku nedosáhne a obráceně.
 *  2. **Účty jsou po e-shopech** v crm_contact_shops. Kontakt v CRM zůstává
 *     jeden na e-mail; registrace, heslo (záložní hash), souhlasy, profil
 *     a poslední přihlášení jsou zvlášť pro každý e-shop. Tenhle soubor proto
 *     NIKDY nezapisuje crm_contacts.is_registered, .notes, .marketing_consent
 *     ani .gdpr_consent_at — z nich čte své účty Toneráček (/api/toneracek
 *     i záložní přihlášení v e-shopu) — a kontakt, který je účtem Toneráčku
 *     (is_registered = TRUE), nemění vůbec. Sdílené jméno a telefon jinému
 *     kontaktu doplní jen objednávka, a to jen prázdné.
 *
 * /api/toneracek/* zůstává, jak je. Pomocné funkce (zálohovka, číslo
 * objednávky, CRM) jsou tu zkopírované, ne sdílené: routa Toneráčku je
 * v provozu a každá změna v ní je riziko pro e-shop, který jede. Až bude
 * Dílna stabilní, jde to sloučit — s regresními testy obou API.
 */

import { getDb, generateId } from '../db.js';
import { BrandIncompleteError, brandForShopId } from '../brand.js';
import { sendPushToAll } from '../push.js';
import { renderSeriesNumber } from '../series-format.js';
import { okamzikPlatbySql } from '../danovy-doklad.js';
import { ceskeDatum } from '../prazsky-cas.js';
import { eshopPodleKlice, zaznamenejPouziti } from '../eshop-klice.js';
import { atribuceZTela, nakupniCenaZPolozky } from '../atribuce-objednavky.js';

// Tytéž popisky, jaké ukládá Toneráček — admin, faktury (danovy-doklad.js),
// expedice i párování plateb podle nich rozhodují.
const PAYMENT_LABELS = {
  card: 'Platba kartou',
  transfer: 'Bankovní převod',
  cod: 'Dobírka',
};

// Bývalo kvůli veřejnému Swaggeru na /api/docs (zrušený 26. 10. 2026);
// Fastify klíč `hide` jinak ignoruje. Dokumentace je v docs/api.md.
const SKRYTO = { schema: { hide: true } };

/**
 * Objednávka tak, jak ji dostane e-shop: `invoice_number` je číslo vydané
 * faktury (`vydana_faktura` z dotazu), jinak prázdné. Kopie
 * objednavkaProEshop() z routes/toneracek.js — viz komentář tam.
 */
function objednavkaProEshop({ vydana_faktura, ...objednavka }) {
  return { ...objednavka, invoice_number: vydana_faktura ?? '' };
}

// ── Účty po e-shopech ──────────────────────────────────────────

/**
 * Účet tak, jak ho zná /api/toneracek (mapContact), jen z řádku e-shopu.
 * Profil: hodnota e-shopu, jinak sdílená z kontaktu. Poznámka (záložní
 * hash hesla) jen na vyžádání — viz mapContact() v routes/toneracek.js.
 */
function mapUser(row, { includeNote = false } = {}) {
  const user = {
    id:               row.id,
    email:            row.email,
    jmeno:            row.first_name,
    prijmeni:         row.last_name,
    telefon:          row.phone || '',
    firma:            row.company_name || '',
    ulice:            row.address || '',
    mesto:            row.city || '',
    psc:              row.zip || '',
    // Den registrace v TOMHLE e-shopu, ne den, kdy kontakt vznikl v CRM
    // (zákazník Toneráčku z roku 2024 se na Dílně registruje dnes).
    datumRegistrace:  row.registered_at,
    souhlasMarketing: !!row.marketing_consent,
    souhlasNotifikace:!!row.notifications_consent,
    souhlasGdpr:      !!row.gdpr_consent_at,
    aktivni:          row.active !== false,
  };
  if (includeNote) user.poznamka = row.password_backup || null;
  return user;
}

/** SELECT registrovaného účtu e-shopu; `kde` doplní podmínku na kontakt. */
function ucetSql(sql, shopId, kde) {
  return sql`
    SELECT c.id, c.email,
           COALESCE(cs.first_name,   c.first_name)   AS first_name,
           COALESCE(cs.last_name,    c.last_name)    AS last_name,
           COALESCE(cs.phone,        c.phone)        AS phone,
           COALESCE(cs.company_name, c.company_name) AS company_name,
           COALESCE(cs.address,      c.address)      AS address,
           COALESCE(cs.city,         c.city)         AS city,
           COALESCE(cs.zip,          c.zip)          AS zip,
           cs.registered_at, cs.marketing_consent, cs.notifications_consent,
           cs.gdpr_consent_at, cs.active, cs.password_backup
    FROM crm_contacts c
    JOIN crm_contact_shops cs ON cs.contact_id = c.id AND cs.shop_id = ${shopId}
    WHERE cs.is_registered = TRUE AND ${kde}
    LIMIT 1
  `;
}

/** Pole profilu: klíč v API → sloupec (stejný v crm_contacts i crm_contact_shops). */
const PROFIL = [
  ['jmeno', 'first_name'], ['prijmeni', 'last_name'], ['telefon', 'phone'],
  ['firma', 'company_name'], ['ulice', 'address'], ['mesto', 'city'], ['psc', 'zip'],
];

/**
 * Doplní prázdné sdílené údaje kontaktu z objednávky. Neprázdné se
 * nepřepisují: kontakt je společný všem e-shopům i obchodu SEILu.
 *
 * Kontakt, který je účtem Toneráčku (is_registered = TRUE), se nemění vůbec,
 * ani prázdné pole. Přesně tyhle sloupce vrací /api/toneracek jako účet
 * a pokladna Toneráčku z nich předvyplňuje firmu a adresu na objednávce
 * i faktuře. Objednávku na Dílně může s cizím e-mailem poslat kdokoli —
 * telefon nebo firma odsud by se jinak objevily v cizím účtu na Toneráčku.
 */
async function doplnPrazdneUdaje(sql, contactId, hodnoty) {
  const sets = Object.entries(hodnoty)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([sloupec, v]) => sql`${sql(sloupec)} = COALESCE(NULLIF(${sql(sloupec)}, ''), ${String(v)})`);
  if (!sets.length) return;
  await sql`
    UPDATE crm_contacts SET ${sets.reduce((a, b) => sql`${a}, ${b}`)}, modified_at = NOW()
    WHERE id = ${contactId} AND is_registered = FALSE
  `;
}

// ── CRM z objednávky ───────────────────────────────────────────

/**
 * Obdoba upsertCustomerToCRM() z routes/toneracek.js pro e-shop z klíče.
 * Rozdíly: zdroj je název e-shopu, jméno a telefon se jen doplňují (u účtu
 * Toneráčku vůbec — viz doplnPrazdneUdaje) a registrace se z objednávky
 * nikdy nezvedá — účet vzniká jen přes POST /users. Zákazník se k e-shopu
 * přihlásí řádkem v crm_contact_shops s výslovným is_registered = FALSE
 * (výchozí hodnota sloupce je TRUE).
 */
async function upsertCustomerToCRM(sql, shop, { email, firstName, lastName, company, phone, city, country }) {
  if (!email) return { contactId: null, companyId: null };
  const source = shop.name;

  let companyId = null;
  if (company?.trim()) {
    const existing = await sql`SELECT id FROM crm_companies WHERE name = ${company.trim()} LIMIT 1`;
    if (existing[0]) {
      companyId = existing[0].id;
    } else {
      companyId = generateId();
      await sql`
        INSERT INTO crm_companies (id, name, company_type, city, country, source)
        VALUES (${companyId}, ${company.trim()}, 'Zákazník', ${city||''}, ${country||''}, ${source})
      `;
    }
  }

  const existing = await sql`SELECT id FROM crm_contacts WHERE LOWER(email) = LOWER(${email}) ORDER BY created_at LIMIT 1`;

  let contactId;
  if (existing[0]) {
    contactId = existing[0].id;
    // Účtu Toneráčku se nesahá ani na firmu a zdroj; objednávka na něj
    // i na firmu odkazuje sama (shop_orders.crm_contact_id, crm_company_id).
    await doplnPrazdneUdaje(sql, contactId, { first_name: firstName, last_name: lastName, phone });
    await sql`
      UPDATE crm_contacts SET
        company_id  = COALESCE(company_id, ${companyId}),
        source      = COALESCE(source, ${source}),
        modified_at = NOW()
      WHERE id = ${contactId} AND is_registered = FALSE
    `;
  } else {
    contactId = generateId();
    await sql`
      INSERT INTO crm_contacts
        (id, first_name, last_name, email, phone, company_id, is_registered, source)
      VALUES
        (${contactId}, ${firstName||''}, ${lastName||''}, ${email},
         ${phone||''}, ${companyId}, FALSE, ${source})
    `;
  }

  await sql`
    INSERT INTO crm_contact_shops
      (contact_id, shop_id, is_registered, marketing_consent, notifications_consent,
       active, registered_at, modified_at)
    VALUES (${contactId}, ${shop.id}, FALSE, FALSE, FALSE, TRUE, NOW(), NOW())
    ON CONFLICT (contact_id, shop_id) DO NOTHING
  `;

  return { contactId, companyId };
}

// ── Zálohová faktura (kopie z routes/toneracek.js) ─────────────

/** Vystaví zálohovou fakturu, pokud k objednávce ještě není. Nic neposílá. */
async function ensureProformaForOrder(sql, order) {
  const [existing] = await sql`
    SELECT * FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'proforma' LIMIT 1
  `;
  if (existing) return existing;

  const { generateProformaForOrder } = await import('./invoices.js');
  return generateProformaForOrder(sql, order);
}

/** PDF zálohové faktury i s rozpisem DPH, se značkou e-shopu objednávky. */
async function renderProformaPdf(sql, proforma) {
  const { renderInvoicePdf } = await import('../pdf.js');
  const { paymentVs } = await import('../series-format.js');
  const { calcVatSummary } = await import('./invoices.js');
  const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${proforma.id}`;
  const [issuer] = await sql`SELECT * FROM company_settings LIMIT 1`;
  const [ord] = await sql`SELECT order_number FROM shop_orders WHERE id = ${proforma.order_id} LIMIT 1`;

  return renderInvoicePdf({
    invoice: proforma, items, issuer: issuer || {}, vatSummary: calcVatSummary(items),
    brand: await brandForShopId(proforma.shop_id),
    vs: paymentVs(proforma, ord?.order_number),
  });
}

/**
 * Vystaví zálohovou fakturu a — dokud SHOP_SENDS_PAYMENT_EMAIL není zapnuté —
 * ji i odešle. Přepínač je globální a platí pro všechny e-shopy stejně
 * (viz issueProformaForOrder v routes/toneracek.js).
 */
async function issueProformaForOrder(sql, log, orderId) {
  try {
    const [order] = await sql`SELECT * FROM shop_orders WHERE id = ${orderId}`;
    if (!order) return;

    const alreadyIssued = await sql`
      SELECT id FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'proforma' LIMIT 1
    `;
    const proforma = await ensureProformaForOrder(sql, order);
    if (alreadyIssued.length) return;

    if (process.env.SHOP_SENDS_PAYMENT_EMAIL === '1') return;
    if (!order.email) return;

    const { sendInvoiceEmail } = await import('../email.js');
    const { paymentVs } = await import('../series-format.js');
    const [issuer] = await sql`SELECT * FROM company_settings LIMIT 1`;
    const brand = await brandForShopId(order.shop_id);
    const pdfBuffer = await renderProformaPdf(sql, proforma);

    await sendInvoiceEmail({
      invoice: proforma, issuer: issuer || {}, brand, email: order.email, pdfBuffer,
      subject: `Zálohová faktura ${proforma.number} k objednávce #${order.order_number}`,
      intro: `děkujeme za objednávku č. <strong>${order.order_number}</strong>. V příloze naleznete zálohovou fakturu. Po jejím uhrazení vám vystavíme a zašleme běžnou fakturu.`,
      paymentDetails: {
        bankAccount: issuer?.bank_account || '',
        iban: issuer?.iban || '',
        amount: Number(proforma.total_amount),
        variableSymbol: paymentVs(proforma, order.order_number),
        dueDate: ceskeDatum(proforma.due_date),
      },
    });
  } catch (err) {
    log.error({ err }, 'Chyba při vystavení/odeslání zálohové faktury');
  }
}

// ── Číslo objednávky (kopie z routes/toneracek.js) ─────────────

async function prideleneCisloObjednavky(sql, shopId) {
  const [orderSeries] = await sql`
    SELECT * FROM invoice_number_series
    WHERE shop_id = ${shopId} AND entity_type = 'objednavka' AND active = TRUE
    ORDER BY id LIMIT 1
  `;
  if (orderSeries) {
    const [updated] = await sql`UPDATE invoice_number_series SET current_number = current_number + 1 WHERE id = ${orderSeries.id} RETURNING *`;
    // Formát s náhodnými číslicemi (X) nenese pořadí — při shodě se losuje
    // znovu, ať UNIQUE (shop_id, order_number) nespadne až u zákazníka.
    const random = /X/.test(updated.format || '');
    for (let attempt = 0; attempt < (random ? 10 : 1); attempt++) {
      const candidate = renderSeriesNumber(updated);
      const [clash] = await sql`
        SELECT 1 FROM shop_orders WHERE shop_id = ${shopId} AND order_number = ${candidate} LIMIT 1
      `;
      if (!clash) return candidate;
    }
    throw new Error(`Nepodařilo se vylosovat volné číslo objednávky v řadě "${updated.name}" (formát ${updated.format}); rozsah je nejspíš vyčerpaný`);
  }

  // Bez řady jako Toneráček: poslední + 1. Nový e-shop má mít řadu založenou
  // dřív, než přijde první objednávka (docs/druhy-eshop.md).
  const [last] = await sql`
    SELECT order_number FROM shop_orders WHERE shop_id = ${shopId}
    ORDER BY CAST(order_number AS INTEGER) DESC LIMIT 1
  `;
  return last ? String(parseInt(last.order_number, 10) + 1) : '10001';
}

// ── Routy ──────────────────────────────────────────────────────

export default async function eshopApiRoutes(fastify) {
  const sql = getDb();

  // Ověření dřív, než se čte tělo: cizí požadavek se ani neparsuje. Hook
  // platí jen pro routy tohoto pluginu (Fastify zapouzdřuje).
  fastify.addHook('onRequest', async (request, reply) => {
    const shop = await eshopPodleKlice(sql, request.headers['authorization']);
    if (!shop) return reply.code(401).send({ error: 'Unauthorized' });
    zaznamenejPouziti(sql, shop.api_key_id, request.log);
    request.eshop = shop;
  });

  // ── Uživatelé ────────────────────────────────────────────────

  fastify.get('/api/eshop/users', SKRYTO, async (request, reply) => {
    const shop = request.eshop;
    const email = (request.query.email || '').trim().toLowerCase();
    if (!email) return reply.code(400).send({ error: 'email required' });

    const [row] = await ucetSql(sql, shop.id, sql`LOWER(c.email) = ${email}`);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    // Záložní hash hesla jen pro toho, kdo si o něj řekne (přihlášení).
    const includeNote = request.query.withNote === '1';
    return reply.send(mapUser(row, { includeNote }));
  });

  fastify.get('/api/eshop/users/:id', SKRYTO, async (request, reply) => {
    const [row] = await ucetSql(sql, request.eshop.id, sql`c.id = ${request.params.id}`);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    return reply.send(mapUser(row));
  });

  fastify.post('/api/eshop/users', SKRYTO, async (request, reply) => {
    const shop = request.eshop;
    const b = request.body;
    if (!b?.email) return reply.code(400).send({ error: 'email required' });

    const email = b.email.toLowerCase();
    const profil = Object.fromEntries(PROFIL.map(([klic, sloupec]) => [sloupec, b[klic] || '']));

    /*
     * Registrace v TOMHLE e-shopu. Kontakt se stejným e-mailem v CRM být
     * může — zákazník Toneráčku, host z objednávky, obchodní partner — a to
     * registraci nebrání. 409 znamená jen „už má účet tady“.
     *
     * Profil z registrace jde jen do účtu e-shopu (crm_contact_shops), do
     * existujícího kontaktu ne. E-shop účet zakládá dřív, než zákazník
     * potvrdí e-mail, takže kdokoli může zkusit registraci s cizí adresou —
     * a firma či adresa odtud by jinak doplnila účet Toneráčku a jeho pokladna
     * by je předvyplnila na další objednávku a fakturu.
     *
     * V transakci a se zámkem kontaktu: dvě souběžné registrace téhož
     * e-mailu nesmí obě projít a založit dva účty.
     */
    const vysledek = await sql.begin(async (tx) => {
      let [contact] = await tx`
        SELECT id FROM crm_contacts WHERE LOWER(email) = ${email}
        ORDER BY created_at LIMIT 1 FOR UPDATE
      `;
      let novy = false;

      if (!contact) {
        // Sdílené příznaky (is_registered, marketing_consent, gdpr_consent_at,
        // notes) zůstávají na výchozích hodnotách — patří účtu Toneráčku.
        [contact] = await tx`
          INSERT INTO crm_contacts
            (id, first_name, last_name, email, phone, company_name, address, city, zip,
             is_registered, active, source)
          VALUES (${generateId()}, ${profil.first_name}, ${profil.last_name}, ${email},
                  ${profil.phone}, ${profil.company_name}, ${profil.address}, ${profil.city},
                  ${profil.zip}, FALSE, TRUE, ${shop.name})
          ON CONFLICT (email) DO NOTHING
          RETURNING id
        `;
        if (contact) novy = true;
        else [contact] = await tx`SELECT id FROM crm_contacts WHERE email = ${email} FOR UPDATE`;
      } else {
        // Jen zdroj kontaktu, který ho nemá — a nikdy u účtu Toneráčku.
        await tx`
          UPDATE crm_contacts SET source = ${shop.name}
          WHERE id = ${contact.id} AND source IS NULL AND is_registered = FALSE
        `;
      }

      // Upsert, který projde jen u hosta nebo nového řádku. Registrovaný
      // účet podmínku WHERE nesplní a RETURNING vrátí nic → 409.
      // Záložní hash se maže: nová registrace = nové heslo a starý hash by
      // jinak dál otevíral záložní přihlášení v e-shopu.
      const souhlasGdpr = Boolean(b.souhlasGdpr);
      const [ucet] = await tx`
        INSERT INTO crm_contact_shops
          (contact_id, shop_id, is_registered, registered_at, marketing_consent,
           notifications_consent, gdpr_consent_at, active, password_backup,
           first_name, last_name, phone, company_name, address, city, zip, modified_at)
        VALUES (${contact.id}, ${shop.id}, TRUE, NOW(), ${Boolean(b.souhlasMarketing)},
                FALSE, ${souhlasGdpr ? tx`NOW()` : null}, TRUE, '',
                ${profil.first_name}, ${profil.last_name}, ${profil.phone}, ${profil.company_name},
                ${profil.address}, ${profil.city}, ${profil.zip}, NOW())
        ON CONFLICT (contact_id, shop_id) DO UPDATE SET
          is_registered     = TRUE,
          registered_at     = NOW(),
          marketing_consent = EXCLUDED.marketing_consent,
          gdpr_consent_at   = ${souhlasGdpr
            ? tx`COALESCE(crm_contact_shops.gdpr_consent_at, NOW())`
            : tx`crm_contact_shops.gdpr_consent_at`},
          active            = TRUE,
          password_backup   = '',
          first_name   = EXCLUDED.first_name,   last_name = EXCLUDED.last_name,
          phone        = EXCLUDED.phone,        company_name = EXCLUDED.company_name,
          address      = EXCLUDED.address,      city = EXCLUDED.city,
          zip          = EXCLUDED.zip,
          modified_at  = NOW()
        WHERE crm_contact_shops.is_registered = FALSE
        RETURNING contact_id
      `;
      if (!ucet) throw new UzRegistrovan();
      return { contactId: contact.id, novy };
    }).catch((err) => {
      if (err instanceof UzRegistrovan) return null;
      throw err;
    });

    if (!vysledek) return reply.code(409).send({ error: 'Účet s tímto e-mailem již existuje' });

    const [row] = await ucetSql(sql, shop.id, sql`c.id = ${vysledek.contactId}`);
    return reply.code(vysledek.novy ? 201 : 200).send(mapUser(row));
  });

  fastify.patch('/api/eshop/users/:id', SKRYTO, async (request, reply) => {
    const shop = request.eshop;
    const b = request.body || {};
    const id = request.params.id;

    // Profil se mění jen v účtu e-shopu — sdílený kontakt v CRM (a s ním
    // účet Toneráčku) zůstává, jak je. Viz POST /api/eshop/users.
    const sets = [];
    for (const [klic, sloupec] of PROFIL) {
      if (b[klic] === undefined) continue;
      sets.push(sql`${sql(sloupec)} = ${b[klic] ?? ''}`);
    }
    if (b.souhlasMarketing  !== undefined) sets.push(sql`marketing_consent = ${!!b.souhlasMarketing}`);
    if (b.souhlasNotifikace !== undefined) sets.push(sql`notifications_consent = ${!!b.souhlasNotifikace}`);
    if (b.posledniPrihlaseni !== undefined) sets.push(sql`last_login = ${b.posledniPrihlaseni}`);
    if (b.poznamka    !== undefined) sets.push(sql`password_backup = ${b.poznamka ?? ''}`);

    if (sets.length) {
      sets.push(sql`modified_at = NOW()`);
      const result = await sql`
        UPDATE crm_contact_shops SET ${sets.reduce((a, c) => sql`${a}, ${c}`)}
        WHERE contact_id = ${id} AND shop_id = ${shop.id} AND is_registered = TRUE
      `;
      if (result.count === 0) return reply.code(404).send({ error: 'Not found' });
    }

    const [row] = await ucetSql(sql, shop.id, sql`c.id = ${id}`);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    return reply.send(mapUser(row));
  });

  // ── Objednávky: dotazy ───────────────────────────────────────

  const vydanaFakturaSql = () => sql`(
    SELECT number FROM accounting_invoices
    WHERE order_id = o.id AND type = 'issued'
    ORDER BY created_at LIMIT 1
  )`;

  fastify.get('/api/eshop/orders', SKRYTO, async (request, reply) => {
    const email = (request.query.email || '').trim().toLowerCase();
    if (!email) return reply.code(400).send({ error: 'email required' });

    const orders = await sql`
      SELECT o.*, ${vydanaFakturaSql()} AS vydana_faktura
      FROM shop_orders o
      WHERE o.shop_id = ${request.eshop.id} AND LOWER(o.email) = ${email}
      ORDER BY o.created_at DESC LIMIT 50
    `;
    const result = await Promise.all(orders.map(async row => {
      const items = await sql`SELECT name, quantity FROM shop_order_items WHERE order_id = ${row.id}`;
      return { ...objednavkaProEshop(row), items };
    }));
    return reply.send({ orders: result });
  });

  fastify.get('/api/eshop/orders/by-number/:orderNumber', SKRYTO, async (request, reply) => {
    const orderNumber = request.params.orderNumber;
    const email = (request.query.email || '').trim().toLowerCase();

    const [row] = await sql`
      SELECT o.*, ${vydanaFakturaSql()} AS vydana_faktura
      FROM shop_orders o
      WHERE o.shop_id = ${request.eshop.id} AND o.order_number = ${orderNumber} LIMIT 1
    `;
    if (!row) return reply.code(404).send({ error: 'Not found' });
    const order = objednavkaProEshop(row);
    if (email && order.email.toLowerCase() !== email) return reply.code(403).send({ error: 'Forbidden' });
    // Výslovné sloupce, ne SELECT *: nákupní cena položky (cost_price,
    // migrace 042) e-shopu nepatří a ven jít nesmí.
    const items = await sql`
      SELECT id, order_id, sku, name, quantity, price, product_id, multipack_id, supplier_code
      FROM shop_order_items WHERE order_id = ${order.id}
    `;
    return reply.send({ order: { ...order, items } });
  });

  fastify.patch('/api/eshop/orders/:id/payment-status', SKRYTO, async (request, reply) => {
    const { status } = request.body || {};
    if (!status) return reply.code(400).send({ error: 'status required' });

    // Okamžik platby jen při prvním potvrzení — viz okamzikPlatbySql().
    const result = await sql`
      UPDATE shop_orders
      SET status = ${status}, paid_at = ${okamzikPlatbySql(sql, status)}, modified_at = NOW()
      WHERE id = ${request.params.id} AND shop_id = ${request.eshop.id}
    `;
    if (result.count === 0) return reply.code(404).send({ error: 'Not found' });
    return reply.send({ ok: true });
  });

  // ── Objednávky: příjem nové ──────────────────────────────────

  fastify.post('/api/eshop/orders', SKRYTO, async (request, reply) => {
    const shop = request.eshop;
    const b = request.body;
    if (!b?.customer || !b?.items || !b?.totalPrice) {
      return reply.code(400).send({ error: 'Chybí povinná data objednávky' });
    }

    /*
     * Bez vyplněné identity e-shopu (Nastavení → Eshopy) by objednávka sice
     * vznikla, ale zálohovka by se nevyrenderovala (payment-details → 503,
     * potvrzení zákazníkovi bez variabilního symbolu), „Vyřízena“ by spadla
     * na 500 a ranní expedice by balíky jen držela. Lepší chyba v pokladně
     * hned teď. Toneráček má identitu od migrace 030, jeho se to netýká.
     */
    try {
      await brandForShopId(shop.id);
    } catch (err) {
      if (!(err instanceof BrandIncompleteError)) throw err;
      request.log.error({ err, shop: shop.slug }, 'Objednávka odmítnuta: e-shop nemá vyplněnou identitu');
      return reply.code(503).send({ error: 'E-shop nemá v One SEIL vyplněnou identitu (Nastavení → Eshopy)' });
    }

    const { customer, shipping, paymentMethod, ipAddress, status } = b;

    // Celé koruny po celé soustavě — viz POST /api/toneracek/orders.
    const totalPrice = Math.round(Number(b.totalPrice));
    const items = (b.items || []).map((i) => ({ ...i, price: Math.round(Number(i.price)) }));

    // Zdroj objednávky (UTM, click-id, referrer, vstupní stránka) a nákupní
    // cena položek — volitelné; bez nich dosadí výchozí hodnoty sloupců,
    // viz src/atribuce-objednavky.js a kontrakt v docs/api.md.
    const atribuce = atribuceZTela(b.marketing);

    const orderNumber = await prideleneCisloObjednavky(sql, shop.id);

    // Číslo faktury vzniká až při vyřízení — viz POST /api/toneracek/orders.
    const invoiceNumber = '';
    const orderId = generateId();
    const initialStatus = status || 'Přijata';
    const paidAt = initialStatus === 'Zaplaceno' ? new Date() : null;

    await sql`
      INSERT INTO shop_orders (
        id, shop_id, order_number, status, payment_method, shipping_method,
        first_name, last_name, company, ic, dic,
        email, phone, address, city, zip, country,
        shipping_first_name, shipping_last_name, shipping_company,
        shipping_phone, shipping_address, shipping_city, shipping_zip,
        pickup_point_id, pickup_point_name,
        total_price, invoice_number, ip_address, paid_at,
        utm_source_first, utm_medium_first, utm_campaign_first, utm_term_first, utm_content_first,
        click_id_kind_first, click_id_first, referrer_host_first, landing_page_first, touch_first_at,
        utm_source_last, utm_medium_last, utm_campaign_last, utm_term_last, utm_content_last,
        click_id_kind_last, click_id_last, referrer_host_last, landing_page_last, touch_last_at,
        attribution_consent
      ) VALUES (
        ${orderId}, ${shop.id}, ${orderNumber}, ${initialStatus},
        ${PAYMENT_LABELS[paymentMethod] ?? paymentMethod ?? ''},
        ${shipping?.method ?? 'Zásilkovna'},
        ${customer.firstName??''}, ${customer.lastName??''},
        ${customer.company??''}, ${customer.ic??''}, ${customer.dic??''},
        ${customer.email??''}, ${customer.phone??''},
        ${customer.address??''}, ${customer.city??''}, ${customer.zip??''},
        ${customer.stat??'Česká republika'},
        ${customer.shippingFirstName??customer.firstName??''},
        ${customer.shippingLastName ??customer.lastName ??''},
        ${customer.shippingCompany  ??customer.company  ??''},
        ${customer.shippingPhone    ??customer.phone    ??''},
        ${customer.shippingAddress  ??customer.address  ??''},
        ${customer.shippingCity     ??customer.city     ??''},
        ${customer.shippingZip      ??customer.zip      ??''},
        ${shipping?.pickupPointId   ??''},
        ${shipping?.pickupPointName ??''},
        ${totalPrice}, ${invoiceNumber}, ${ipAddress??''}, ${paidAt},
        ${atribuce.utm_source_first}, ${atribuce.utm_medium_first}, ${atribuce.utm_campaign_first},
        ${atribuce.utm_term_first}, ${atribuce.utm_content_first},
        ${atribuce.click_id_kind_first}, ${atribuce.click_id_first}, ${atribuce.referrer_host_first},
        ${atribuce.landing_page_first}, ${atribuce.touch_first_at},
        ${atribuce.utm_source_last}, ${atribuce.utm_medium_last}, ${atribuce.utm_campaign_last},
        ${atribuce.utm_term_last}, ${atribuce.utm_content_last},
        ${atribuce.click_id_kind_last}, ${atribuce.click_id_last}, ${atribuce.referrer_host_last},
        ${atribuce.landing_page_last}, ${atribuce.touch_last_at},
        ${atribuce.attribution_consent}
      )
    `;

    for (const item of items) {
      const nakup = nakupniCenaZPolozky(item);
      await sql`
        INSERT INTO shop_order_items (order_id, sku, supplier_code, name, quantity, price, product_id,
                                      cost_price, cost_price_vat_included)
        VALUES (${orderId}, ${item.sku??''}, ${String(item.supplierCode ?? '').trim()},
                ${item.name}, ${item.quantity}, ${item.price}, ${item.productId??null},
                ${nakup.cost_price}, ${nakup.cost_price_vat_included})
      `;
    }

    try {
      const { contactId, companyId } = await upsertCustomerToCRM(sql, shop, {
        email: customer.email, firstName: customer.firstName, lastName: customer.lastName,
        company: customer.company, phone: customer.phone, city: customer.city,
        country: customer.stat || 'Česká republika',
      });
      if (contactId || companyId) {
        await sql`
          UPDATE shop_orders SET crm_contact_id = ${contactId}, crm_company_id = ${companyId}
          WHERE id = ${orderId}
        `;
      }
    } catch (err) {
      request.log.warn({ err }, 'CRM upsert selhal (nekritické)');
    }

    if (PAYMENT_LABELS[paymentMethod] === 'Bankovní převod') {
      await issueProformaForOrder(sql, request.log, orderId);
    }

    sendPushToAll({
      title: `Nová objednávka — ${shop.name}`,
      body: `#${orderNumber} · ${customer.firstName} ${customer.lastName} · ${totalPrice} CZK`,
      url: `/ucetnictvi/objednavky/${orderId}`,
    })
      .then(({ odeslano, selhalo, duvod }) => {
        if (!odeslano) request.log.warn({ orderNumber, selhalo, duvod }, 'Push o nové objednávce neodešel');
      })
      .catch(err => request.log.error({ err, orderNumber }, 'Push o nové objednávce selhal'));

    return reply.send({ orderId, orderNumber, invoiceNumber });
  });

  // ── Objednávky: změny ────────────────────────────────────────

  fastify.patch('/api/eshop/orders/:id/payment-method', SKRYTO, async (request, reply) => {
    const shopId = request.eshop.id;
    const { paymentMethod, status } = request.body || {};
    const totalPrice =
      request.body?.totalPrice == null ? null : Math.round(Number(request.body.totalPrice));
    const label = PAYMENT_LABELS[paymentMethod];
    if (!label) return reply.code(400).send({ error: 'paymentMethod musí být card, transfer nebo cod' });

    const [order] = await sql`
      SELECT * FROM shop_orders WHERE id = ${request.params.id} AND shop_id = ${shopId}
    `;
    if (!order) return reply.code(404).send({ error: 'Not found' });

    await sql`
      UPDATE shop_orders SET
        payment_method = ${label},
        total_price    = ${totalPrice ?? order.total_price},
        status         = ${status || order.status},
        paid_at        = ${okamzikPlatbySql(sql, status)},
        modified_at    = NOW()
      WHERE id = ${order.id} AND shop_id = ${shopId}
    `;

    if (label === 'Bankovní převod' && order.payment_method !== label) {
      await issueProformaForOrder(sql, request.log, order.id);
    }

    return reply.send({ ok: true });
  });

  fastify.patch('/api/eshop/orders/:id/tracking', SKRYTO, async (request, reply) => {
    const { trackingNumber, labelUrl } = request.body ?? {};
    const result = await sql`
      UPDATE shop_orders
      SET tracking_number = ${trackingNumber??''}, label_url = ${labelUrl??''}, modified_at = NOW()
      WHERE id = ${request.params.id} AND shop_id = ${request.eshop.id}
    `;
    if (result.count === 0) return reply.code(404).send({ error: 'Objednávka nenalezena' });
    return reply.send({ ok: true });
  });

  // ── Platební údaje ───────────────────────────────────────────
  //
  // Omezené na e-shop klíče: jinak by klíč jednoho e-shopu přečetl jméno
  // a adresu z cizí zálohovky a ještě ji nechal vystavit.

  fastify.get('/api/eshop/orders/:id/payment-details', SKRYTO, async (request, reply) => {
    const [order] = await sql`
      SELECT * FROM shop_orders WHERE id = ${request.params.id} AND shop_id = ${request.eshop.id} LIMIT 1
    `;
    if (!order) return reply.code(404).send({ error: 'Objednávka nenalezena' });
    if (order.payment_method !== 'Bankovní převod') {
      return reply.code(409).send({ error: 'not-transfer' });
    }

    try {
      const { paymentVs } = await import('../series-format.js');
      const proforma = await ensureProformaForOrder(sql, order);
      const [issuer] = await sql`SELECT * FROM company_settings LIMIT 1`;

      let pdf = null;
      if (request.query.pdf === '1') {
        const buffer = await renderProformaPdf(sql, proforma);
        pdf = {
          filename: `zalohova-faktura-${proforma.number}.pdf`,
          contentBase64: Buffer.from(buffer).toString('base64'),
        };
      }

      return reply.send({
        variableSymbol: paymentVs(proforma, order.order_number),
        amount: Number(proforma.total_amount),
        currency: proforma.currency || 'CZK',
        dueDate: proforma.due_date,
        bankAccount: issuer?.bank_account || '',
        iban: issuer?.iban || '',
        swift: issuer?.swift || '',
        bankName: issuer?.bank_name || '',
        proformaNumber: proforma.number,
        pdf,
      });
    } catch (err) {
      request.log.error({ err }, 'Platební údaje k objednávce se nepodařilo sestavit');
      return reply.code(503).send({ error: 'Platební údaje nejsou k dispozici' });
    }
  });
}

/** Registrace narazila na existující účet v tomtéž e-shopu — jen pro rollback transakce. */
class UzRegistrovan extends Error {}
