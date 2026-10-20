import { getDb, generateId } from '../db.js';
import { sendOrderCancelledEmail } from '../email.js';
import { brandForShopId } from '../brand.js';
import { sendPushToAll } from '../push.js';
import { renderSeriesNumber } from '../series-format.js';
import { fetchPacketLabelPdf } from '../packeta.js';
import {
  DUVODY_POZASTAVENI, ExpediceBeziError, objednavkySeStavemSkladu,
  pozadejEshopOPodaniBaliku, prazskyCas, spustExpedici, zalozBeh,
} from '../expedice.js';
import { okamzikPlatbySql, zobrazeniUhrady } from '../danovy-doklad.js';
import { ceskeDatum } from '../prazsky-cas.js';

/** Hodnoty sloupce „Sklad" v seznamu objednávek — filtr bere jen tyhle. */
const SKLAD_STAVY = ['odeslano', 'ceka', 'blokovano', 'neplati'];

const ORDER_STATUSES = ['Přijata', 'Vyřízena', 'Stornována'];

/**
 * Zdroj kontaktu a firmy pro CRM. Až přibude druhý e-shop, dostane vlastní
 * hodnotu — filtr v `/crm/kontakty` a `/crm/firmy` je na ni postavený.
 *
 * Dřív se zdroj psal do `notes` jako „Zákazník Toneráček.cz". Nešlo se na to
 * spolehnout: do téhož sloupce si e-shop ukládá záložní hash hesla
 * (`PWDHASH:…`), takže u registrovaného zákazníka poznámka o zdroji zanikla.
 */
const SOURCE = 'Toneráček.cz';

const PAYMENT_LABELS = {
  card: 'Platba kartou',
  transfer: 'Bankovní převod',
  cod: 'Dobírka',
};

// ── CRM upsert zákazníka ──────────────────────────────────────

async function upsertCustomerToCRM(sql, { email, firstName, lastName, company, phone, city, country, isRegistered, source = SOURCE }) {
  if (!email) return { contactId: null, companyId: null };

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

  const isReg = isRegistered ? true : false;
  const existing = await sql`SELECT id, is_registered FROM crm_contacts WHERE LOWER(email) = LOWER(${email}) LIMIT 1`;

  let contactId;
  if (existing[0]) {
    const newIsReg = existing[0].is_registered || isReg;
    await sql`
      UPDATE crm_contacts SET
        first_name   = ${firstName || ''},
        last_name    = ${lastName  || ''},
        phone        = ${phone     || ''},
        company_id   = COALESCE(company_id, ${companyId}),
        is_registered = ${newIsReg},
        source       = COALESCE(source, ${source}),
        modified_at  = NOW()
      WHERE id = ${existing[0].id}
    `;
    contactId = existing[0].id;
  } else {
    contactId = generateId();
    await sql`
      INSERT INTO crm_contacts
        (id, first_name, last_name, email, phone, company_id, is_registered, source)
      VALUES
        (${contactId}, ${firstName||''}, ${lastName||''}, ${email},
         ${phone||''}, ${companyId}, ${isReg}, ${source})
    `;
  }

  return { contactId, companyId };
}

// ── Ověření API klíče (Toneráček — env var Bearer) ───────────

function verifyApiKey(request) {
  const auth = request.headers['authorization'] || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const expected = process.env.TONERACEK_API_KEY;
  return expected && key === expected;
}

// ── Helper: toneráček shop ────────────────────────────────────
//
// Podání balíku u Zásilkovny se přestěhovalo do src/expedice.js — potřebuje ho
// i ranní expedice, protože u převodu vzniká zásilka až přepnutím na
// „Vyřízena", takže zaplacená objednávka ráno štítek nemá.

async function getToneracekShopId(sql) {
  const rows = await sql`SELECT id FROM shops WHERE slug = 'toneracek' LIMIT 1`;
  return rows[0]?.id ?? null;
}

/** Celý řádek e-shopu — nastavení expedice i stav skladu ho potřebují. */
async function getToneracekShop(sql) {
  const [shop] = await sql`SELECT * FROM shops WHERE slug = 'toneracek' LIMIT 1`;
  return shop ?? null;
}

/**
 * Objednávka tak, jak ji dostane e-shop: `invoice_number` je číslo vydané
 * faktury (`vydana_faktura` z dotazu), jinak prázdné.
 *
 * `shop_orders.invoice_number` se zákazníkovi neposílá. Objednávky z doby
 * před migrací 039 v něm nesou vymyšlené „FV-<rok>-<objednávka>“ — i ty, ke
 * kterým mezitím vznikla faktura s číslem z řady (2026NNNN), takže e-shop
 * ukazoval jiné číslo, než nese PDF. Data se kvůli tomu nepřepisují.
 */
export function objednavkaProEshop({ vydana_faktura, ...objednavka }) {
  return { ...objednavka, invoice_number: vydana_faktura ?? '' };
}

export default async function toneracekRoutes(fastify) {
  const sql = getDb();

  // ── Helpers ────────────────────────────────────────────────

  /**
   * Poznámka zákazníka se **nevydává**, dokud si o ni volající neřekne.
   *
   * E-shop si do ní ukládá záložní kopii bcrypt hashe hesla (`PWDHASH:…`,
   * zapisuje ji registrace a reset hesla). Dokud ji mapContact() vracel
   * plošně, chodila v každé odpovědi o uživateli, e-shop celý objekt posílal
   * klientovi a hash hesla každého zákazníka pak trvale ležel v localStorage
   * jeho prohlížeče.
   *
   * Potřebuje ji jedině přihlášení, a to si ji vyžádá přes `?withNote=1`.
   */
  function mapContact(row, { includeNote = false } = {}) {
    const contact = {
      id:               row.id,
      email:            row.email,
      jmeno:            row.first_name,
      prijmeni:         row.last_name,
      telefon:          row.phone || '',
      firma:            row.company_name || '',
      ulice:            row.address || '',
      mesto:            row.city || '',
      psc:              row.zip || '',
      datumRegistrace:  row.created_at,
      souhlasMarketing: !!row.marketing_consent,
      souhlasNotifikace:!!row.notifications_consent,
      souhlasGdpr:      !!row.gdpr_consent_at,
      aktivni:          row.active !== false,
    };
    if (includeNote) contact.poznamka = row.notes || null;
    return contact;
  }

  // ── API: Uživatelé (zákazníci Toneráček) ───────────────────

  fastify.get('/api/toneracek/users', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const email = (request.query.email || '').trim().toLowerCase();
    if (!email) return reply.code(400).send({ error: 'email required' });

    const rows = await sql`
      SELECT * FROM crm_contacts
      WHERE LOWER(email) = ${email} AND is_registered = TRUE
      LIMIT 1
    `;
    if (!rows[0]) return reply.code(404).send({ error: 'Not found' });
    // Poznámku se záložním hashem hesla dostane jen ten, kdo si o ni řekne —
    // v praxi přihlášení v e-shopu, které si jinak hash nemá kde vzít.
    const includeNote = request.query.withNote === '1';
    return reply.send(mapContact(rows[0], { includeNote }));
  });

  fastify.get('/api/toneracek/users/:id', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const rows = await sql`
      SELECT * FROM crm_contacts WHERE id = ${request.params.id} AND is_registered = TRUE LIMIT 1
    `;
    if (!rows[0]) return reply.code(404).send({ error: 'Not found' });
    return reply.send(mapContact(rows[0]));
  });

  fastify.post('/api/toneracek/users', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const b = request.body;
    if (!b?.email) return reply.code(400).send({ error: 'email required' });

    const email = b.email.toLowerCase();

    /*
     * Kontakt se stejným e-mailem už v CRM být může, aniž by měl účet —
     * objednávka hosta ho založí s `is_registered = FALSE`.
     *
     * Dřív to tady skončilo tvrdým 409 pro obojí. GET výš přitom filtruje na
     * `is_registered = TRUE`, takže e-shop hosta neviděl, usoudil „účet
     * neexistuje" a poslal POST — a 409 neuměl odlišit od chyby, takže
     * zákazník dostal „Chyba serveru". Kdo si u nás jednou objednal jako
     * host, se pak nemohl zaregistrovat.
     *
     * Existující host se proto povyšuje na registrovaného. Historie
     * objednávek mu tím zůstane navázaná na tentýž kontakt.
     */
    const [existing] = await sql`
      SELECT id, is_registered FROM crm_contacts WHERE LOWER(email) = ${email} LIMIT 1
    `;

    if (existing?.is_registered) {
      return reply.code(409).send({ error: 'Účet s tímto e-mailem již existuje' });
    }

    if (existing) {
      await sql`
        UPDATE crm_contacts SET
          first_name = ${b.jmeno||''}, last_name = ${b.prijmeni||''},
          phone = ${b.telefon||''}, company_name = ${b.firma||''},
          address = ${b.ulice||''}, city = ${b.mesto||''}, zip = ${b.psc||''},
          marketing_consent = ${b.souhlasMarketing ? true : false},
          is_registered = TRUE, active = TRUE,
          source = COALESCE(source, ${SOURCE}),
          gdpr_consent_at = ${b.souhlasGdpr ? sql`COALESCE(gdpr_consent_at, NOW())` : sql`gdpr_consent_at`},
          modified_at = NOW()
        WHERE id = ${existing.id}
      `;
      const [row] = await sql`SELECT * FROM crm_contacts WHERE id = ${existing.id}`;
      return reply.code(200).send(mapContact(row));
    }

    const id = generateId();
    await sql`
      INSERT INTO crm_contacts
        (id, first_name, last_name, email, phone, company_name, address, city, zip,
         marketing_consent, is_registered, active, source, gdpr_consent_at)
      VALUES (${id}, ${b.jmeno||''}, ${b.prijmeni||''}, ${email}, ${b.telefon||''},
              ${b.firma||''}, ${b.ulice||''}, ${b.mesto||''}, ${b.psc||''},
              ${b.souhlasMarketing ? true : false}, TRUE, TRUE, ${SOURCE},
              ${b.souhlasGdpr ? new Date() : null})
    `;
    const [row] = await sql`SELECT * FROM crm_contacts WHERE id = ${id}`;
    return reply.code(201).send(mapContact(row));
  });

  fastify.patch('/api/toneracek/users/:id', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const b = request.body || {};

    const sets = [];
    if (b.jmeno       !== undefined) sets.push(sql`first_name = ${b.jmeno}`);
    if (b.prijmeni    !== undefined) sets.push(sql`last_name = ${b.prijmeni}`);
    if (b.telefon     !== undefined) sets.push(sql`phone = ${b.telefon}`);
    if (b.firma       !== undefined) sets.push(sql`company_name = ${b.firma}`);
    if (b.ulice       !== undefined) sets.push(sql`address = ${b.ulice}`);
    if (b.mesto       !== undefined) sets.push(sql`city = ${b.mesto}`);
    if (b.psc         !== undefined) sets.push(sql`zip = ${b.psc}`);
    if (b.souhlasMarketing  !== undefined) sets.push(sql`marketing_consent = ${!!b.souhlasMarketing}`);
    if (b.souhlasNotifikace !== undefined) sets.push(sql`notifications_consent = ${!!b.souhlasNotifikace}`);
    if (b.posledniPrihlaseni !== undefined) sets.push(sql`last_login = ${b.posledniPrihlaseni}`);
    if (b.poznamka    !== undefined) sets.push(sql`notes = ${b.poznamka}`);

    if (sets.length === 0) {
      const [row] = await sql`SELECT * FROM crm_contacts WHERE id = ${request.params.id}`;
      return reply.send(mapContact(row));
    }

    sets.push(sql`modified_at = NOW()`);
    const setClause = sets.reduce((a, b) => sql`${a}, ${b}`);
    const result = await sql`
      UPDATE crm_contacts SET ${setClause}
      WHERE id = ${request.params.id} AND is_registered = TRUE
    `;
    if (result.count === 0) return reply.code(404).send({ error: 'Not found' });
    const [row] = await sql`SELECT * FROM crm_contacts WHERE id = ${request.params.id}`;
    return reply.send(mapContact(row));
  });

  // ── API: Dotazy na objednávky ──────────────────────────────

  // Číslo vydané faktury k objednávce `o`. E-shop ho ukazuje zákazníkovi,
  // proto jde z faktury, ne z `o.invoice_number` — viz objednavkaProEshop().
  const vydanaFakturaSql = () => sql`(
    SELECT number FROM accounting_invoices
    WHERE order_id = o.id AND type = 'issued'
    ORDER BY created_at LIMIT 1
  )`;

  fastify.get('/api/toneracek/orders', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const email = (request.query.email || '').trim().toLowerCase();
    if (!email) return reply.code(400).send({ error: 'email required' });

    const shopId = await getToneracekShopId(sql);
    const orders = await sql`
      SELECT o.*, ${vydanaFakturaSql()} AS vydana_faktura
      FROM shop_orders o
      WHERE o.shop_id = ${shopId} AND LOWER(o.email) = ${email}
      ORDER BY o.created_at DESC LIMIT 50
    `;
    const result = await Promise.all(orders.map(async row => {
      const items = await sql`SELECT name, quantity FROM shop_order_items WHERE order_id = ${row.id}`;
      return { ...objednavkaProEshop(row), items };
    }));
    return reply.send({ orders: result });
  });

  fastify.get('/api/toneracek/orders/by-number/:orderNumber', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const orderNumber = request.params.orderNumber;
    const email = (request.query.email || '').trim().toLowerCase();

    const shopId = await getToneracekShopId(sql);
    const [row] = await sql`
      SELECT o.*, ${vydanaFakturaSql()} AS vydana_faktura
      FROM shop_orders o
      WHERE o.shop_id = ${shopId} AND o.order_number = ${orderNumber} LIMIT 1
    `;
    if (!row) return reply.code(404).send({ error: 'Not found' });
    const order = objednavkaProEshop(row);
    if (email && order.email.toLowerCase() !== email) return reply.code(403).send({ error: 'Forbidden' });
    const items = await sql`SELECT * FROM shop_order_items WHERE order_id = ${order.id}`;
    return reply.send({ order: { ...order, items } });
  });

  fastify.patch('/api/toneracek/orders/:id/payment-status', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });
    const { status } = request.body || {};
    if (!status) return reply.code(400).send({ error: 'status required' });

    const shopId = await getToneracekShopId(sql);
    // Okamžik platby si Seil musí uložit sám: faktura vzniká až při vyřízení
    // a den přijetí úplaty se z ní tiskne jako DUZP. Jen první potvrzení —
    // viz okamzikPlatbySql().
    const result = await sql`
      UPDATE shop_orders
      SET status = ${status}, paid_at = ${okamzikPlatbySql(sql, status)}, modified_at = NOW()
      WHERE id = ${request.params.id} AND shop_id = ${shopId}
    `;
    if (result.count === 0) return reply.code(404).send({ error: 'Not found' });
    return reply.send({ ok: true });
  });

  // ── Zálohová faktura k objednávce placené převodem ─────────
  //
  // Rozdělené na „vystav" a „odešli" schválně: platební údaje si od migrace
  // na jeden variabilní symbol tahá e-shop přes /payment-details a posílá je
  // zákazníkovi v jednom e-mailu spolu s potvrzením objednávky. Vystavení
  // proformy ale musí proběhnout tak jako tak — účetnictví na ni čeká.

  /** Vystaví zálohovou fakturu, pokud k objednávce ještě není. Nic neposílá. */
  async function ensureProformaForOrder(order) {
    const [existing] = await sql`
      SELECT * FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'proforma' LIMIT 1
    `;
    if (existing) return existing;

    const { generateProformaForOrder } = await import('./invoices.js');
    return generateProformaForOrder(sql, order);
  }

  /** Vyrenderuje PDF zálohové faktury i s rozpisem DPH. */
  async function renderProformaPdf(proforma) {
    const { renderInvoicePdf } = await import('../pdf.js');
    const { paymentVs } = await import('../series-format.js');
    const { calcVatSummary } = await import('./invoices.js');
    const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${proforma.id}`;
    const [issuer] = await sql`SELECT * FROM company_settings LIMIT 1`;
    const [ord] = await sql`SELECT order_number FROM shop_orders WHERE id = ${proforma.order_id} LIMIT 1`;

    // Dřív se tu rekapitulace DPH skládala ručně a chyběl jí klíč `total`,
    // takže šablona tiskla "NaN Kč" — na každém dokladu, který odešel
    // zákazníkovi. Kopie otevřená adminem šla jinudy a byla v pořádku, proto
    // si toho nikdo nevšiml. calcVatSummary() ten klíč má.
    // Zálohovka je pořád k úhradě, takže platební instrukce zůstávají —
    // mění se jen značka v záhlaví, aby doklad zákazník poznal.
    return renderInvoicePdf({
      invoice: proforma, items, issuer: issuer || {}, vatSummary: calcVatSummary(items),
      brand: await brandForShopId(proforma.shop_id),
      vs: paymentVs(proforma, ord?.order_number),
    });
  }

  /**
   * Vystaví zálohovou fakturu a — dokud SHOP_SENDS_PAYMENT_EMAIL není zapnuté —
   * ji i odešle.
   *
   * Přepínač existuje kvůli pořadí nasazení. Kdyby Seil přestal posílat dřív,
   * než e-shop umí platební údaje vykreslit, dostal by zákazník u převodu jen
   * starý e-mail s variabilním symbolem = číslem objednávky a bez faktury —
   * tedy platbu, kterou banka nespáruje. Opačné pořadí znamená jen jednu
   * duplicitu navíc, což je výrazně levnější. Po nasazení obou stran se
   * přepínač i tahle větev smažou.
   */
  async function issueProformaForOrder(orderId) {
    try {
      const [order] = await sql`SELECT * FROM shop_orders WHERE id = ${orderId}`;
      if (!order) return;

      const alreadyIssued = await sql`
        SELECT id FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'proforma' LIMIT 1
      `;
      const proforma = await ensureProformaForOrder(order);
      if (alreadyIssued.length) return;

      if (process.env.SHOP_SENDS_PAYMENT_EMAIL === '1') return;
      if (!order.email) return;

      const { sendInvoiceEmail } = await import('../email.js');
      const { paymentVs } = await import('../series-format.js');
      const [issuer] = await sql`SELECT * FROM company_settings LIMIT 1`;
      const brand = await brandForShopId(order.shop_id);
      const pdfBuffer = await renderProformaPdf(proforma);

      await sendInvoiceEmail({
        invoice: proforma, issuer: issuer || {}, brand, email: order.email, pdfBuffer,
        subject: `Zálohová faktura ${proforma.number} k objednávce #${order.order_number}`,
        intro: `děkujeme za objednávku č. <strong>${order.order_number}</strong>. V příloze naleznete zálohovou fakturu. Po jejím uhrazení vám vystavíme a zašleme běžnou fakturu.`,
        paymentDetails: {
          bankAccount: issuer?.bank_account || '',
          iban: issuer?.iban || '',
          // Číslo objednávky, ne číslo faktury: zákazník ho zná z děkovné
          // stránky i z potvrzení. Tentýž symbol tiskne PDF v příloze a nese
          // QR kód, a podle něj se platba páruje s výpisem.
          amount: Number(proforma.total_amount),
          variableSymbol: paymentVs(proforma, order.order_number),
          // Tentýž den jako PDF v příloze, nezávisle na pásmu procesu
          dueDate: ceskeDatum(proforma.due_date),
        },
      });
    } catch (err) {
      fastify.log.error({ err }, 'Chyba při vystavení/odeslání zálohové faktury');
    }
  }

  // ── API: Příjem nové objednávky z e-shopu ──────────────────

  fastify.post('/api/toneracek/orders', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });

    const b = request.body;
    if (!b?.customer || !b?.items || !b?.totalPrice) {
      return reply.code(400).send({ error: 'Chybí povinná data objednávky' });
    }

    const shopId = await getToneracekShopId(sql);
    if (!shopId) return reply.code(500).send({ error: 'Toneráček shop není nakonfigurován' });

    const { customer, shipping, paymentMethod, ipAddress, status } = b;

    // Ceny se drží v celých korunách po celé soustavě: co e-shop ukáže
    // zákazníkovi, to strhne Stripe a to je i na dokladu. E-shop od té doby
    // zaokrouhluje sám hned při čtení katalogu; tohle je pojistka, aby se
    // haléře nedostaly dovnitř jinou cestou a doklad pak neukazoval jiné
    // číslo než web.
    const totalPrice = Math.round(Number(b.totalPrice));
    const items = (b.items || []).map((i) => ({ ...i, price: Math.round(Number(i.price)) }));

    // Číslo objednávky — výchozí číselná řada eshopu (pokud nastavena), jinak per-shop sekvence
    const [orderSeries] = await sql`
      SELECT * FROM invoice_number_series
      WHERE shop_id = ${shopId} AND entity_type = 'objednavka' AND active = TRUE
      ORDER BY id LIMIT 1
    `;
    let orderNumber;
    if (orderSeries) {
      const [updated] = await sql`UPDATE invoice_number_series SET current_number = current_number + 1 WHERE id = ${orderSeries.id} RETURNING *`;
      // Formát s náhodnými číslicemi (token X, např. YYMMXXXX) nenese pořadí,
      // takže si dvě objednávky ve stejném měsíci mohou vylosovat totéž číslo.
      // UNIQUE (shop_id, order_number) by to zachytil až výjimkou v INSERTu,
      // tedy chybou u zákazníka v pokladně — levnější je přelosovat.
      const random = /X/.test(updated.format || '');
      for (let attempt = 0; attempt < (random ? 10 : 1); attempt++) {
        const candidate = renderSeriesNumber(updated);
        const [clash] = await sql`
          SELECT 1 FROM shop_orders WHERE shop_id = ${shopId} AND order_number = ${candidate} LIMIT 1
        `;
        if (!clash) { orderNumber = candidate; break; }
      }
      if (!orderNumber) {
        throw new Error(`Nepodařilo se vylosovat volné číslo objednávky v řadě "${updated.name}" (formát ${updated.format}); rozsah je nejspíš vyčerpaný`);
      }
    } else {
      const [last] = await sql`
        SELECT order_number FROM shop_orders WHERE shop_id = ${shopId}
        ORDER BY CAST(order_number AS INTEGER) DESC LIMIT 1
      `;
      orderNumber = last ? String(parseInt(last.order_number, 10) + 1) : '10001';
    }

    // Číslo faktury tu ještě neexistuje — faktura vzniká až při vyřízení
    // objednávky a číslo dostane z řady. Dřív se sem skládalo „FV-<rok>-<číslo
    // objednávky>“ a e-shop ho zákazníkovi ukazoval jako „Faktura: …“, ačkoli
    // žádný takový doklad nikdy nevznikl. Skutečné číslo do objednávky zapíše
    // generateInvoiceForOrder().
    const invoiceNumber = '';
    const orderId = generateId();
    const initialStatus = status || 'Přijata';
    // Objednávka, která přijde rovnou zaplacená, nese okamžik platby od
    // založení; ostatním ho zapíše až PATCH payment-status.
    const paidAt = initialStatus === 'Zaplaceno' ? new Date() : null;

    await sql`
      INSERT INTO shop_orders (
        id, shop_id, order_number, status, payment_method, shipping_method,
        first_name, last_name, company, ic, dic,
        email, phone, address, city, zip, country,
        shipping_first_name, shipping_last_name, shipping_company,
        shipping_phone, shipping_address, shipping_city, shipping_zip,
        pickup_point_id, pickup_point_name,
        total_price, invoice_number, ip_address, paid_at
      ) VALUES (
        ${orderId}, ${shopId}, ${orderNumber}, ${initialStatus},
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
        ${totalPrice}, ${invoiceNumber}, ${ipAddress??''}, ${paidAt}
      )
    `;

    for (const item of items) {
      await sql`
        INSERT INTO shop_order_items (order_id, sku, supplier_code, name, quantity, price, product_id)
        VALUES (${orderId}, ${item.sku??''}, ${String(item.supplierCode ?? '').trim()},
                ${item.name}, ${item.quantity}, ${item.price}, ${item.productId??null})
      `;
    }

    try {
      const { contactId, companyId } = await upsertCustomerToCRM(sql, {
        email: customer.email, firstName: customer.firstName, lastName: customer.lastName,
        company: customer.company, phone: customer.phone, city: customer.city,
        country: customer.stat || 'Česká republika', isRegistered: b.isRegistered ?? false,
      });
      if (contactId || companyId) {
        await sql`
          UPDATE shop_orders SET crm_contact_id = ${contactId}, crm_company_id = ${companyId}
          WHERE id = ${orderId}
        `;
      }
    } catch (err) {
      fastify.log.warn({ err }, 'CRM upsert selhal (nekritické)');
    }

    // Platba převodem: rovnou vystavit a odeslat zálohovou fakturu s platebními údaji
    if (PAYMENT_LABELS[paymentMethod] === 'Bankovní převod') {
      await issueProformaForOrder(orderId);
    }

    // Objednávku push nesmí shodit, ale mlčet taky nesmí: „notifikace nepřišla"
    // se jinak nedá odlišit od „notifikace se ani nepokusila odejít".
    sendPushToAll({
      title: 'Nová objednávka — Toneráček',
      body: `#${orderNumber} · ${customer.firstName} ${customer.lastName} · ${totalPrice} CZK`,
      url: `/ucetnictvi/objednavky/${orderId}`,
    })
      .then(({ odeslano, selhalo, duvod }) => {
        if (!odeslano) fastify.log.warn({ orderNumber, selhalo, duvod }, 'Push o nové objednávce neodešel');
      })
      .catch(err => fastify.log.error({ err, orderNumber }, 'Push o nové objednávce selhal'));

    return reply.send({ orderId, orderNumber, invoiceNumber });
  });

  // ── API: Změna způsobu platby ──────────────────────────────
  //
  // Volá e-shop, když zákazník po neúspěšné platbě kartou přepne na QR /
  // převod / dobírku. Mění stávající objednávku schválně: každá nová
  // objednávka spotřebuje číslo v účetní řadě a DELETE endpoint neexistuje,
  // takže „objednej znovu jinou platbou“ by po každé odmítnuté kartě nechalo
  // v účetnictví mrtvou duplicitu.
  fastify.patch('/api/toneracek/orders/:id/payment-method', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });

    const { paymentMethod, status } = request.body || {};
    // Přepočet po změně způsobu platby (dobírka +40 Kč) musí zůstat v celých
    // korunách stejně jako původní objednávka.
    const totalPrice =
      request.body?.totalPrice == null ? null : Math.round(Number(request.body.totalPrice));
    const label = PAYMENT_LABELS[paymentMethod];
    if (!label) return reply.code(400).send({ error: 'paymentMethod musí být card, transfer nebo cod' });

    const shopId = await getToneracekShopId(sql);
    const [order] = await sql`
      SELECT * FROM shop_orders WHERE id = ${request.params.id} AND shop_id = ${shopId}
    `;
    if (!order) return reply.code(404).send({ error: 'Not found' });

    // Stav sem může přijít i jako „Zaplaceno“ (přepnutí na kartu, která rovnou
    // projde) — pak se okamžik platby zapíše stejně jako v payment-status,
    // jinak by faktura dostala DUZP až v den vyřízení.
    await sql`
      UPDATE shop_orders SET
        payment_method = ${label},
        total_price    = ${totalPrice ?? order.total_price},
        status         = ${status || order.status},
        paid_at        = ${okamzikPlatbySql(sql, status)},
        modified_at    = NOW()
      WHERE id = ${order.id} AND shop_id = ${shopId}
    `;

    // Převod má nárok na zálohovou fakturu stejně jako objednávka, která
    // s převodem přišla rovnou z pokladny.
    if (label === 'Bankovní převod' && order.payment_method !== label) {
      await issueProformaForOrder(order.id);
    }

    return reply.send({ ok: true });
  });

  // ── API: Aktualizace trackingu ─────────────────────────────

  fastify.patch('/api/toneracek/orders/:id/tracking', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });

    const { trackingNumber, labelUrl } = request.body ?? {};
    const shopId = await getToneracekShopId(sql);
    const result = await sql`
      UPDATE shop_orders
      SET tracking_number = ${trackingNumber??''}, label_url = ${labelUrl??''}, modified_at = NOW()
      WHERE id = ${request.params.id} AND shop_id = ${shopId}
    `;
    if (result.count === 0) return reply.code(404).send({ error: 'Objednávka nenalezena' });
    return reply.send({ ok: true });
  });

  // ── API: Platební údaje k objednávce ───────────────────────
  //
  // Jediný zdroj pravdy o tom, jak má zákazník zaplatit. Dřív si e-shop
  // variabilní symbol i číslo účtu držel sám (číslo objednávky + env
  // proměnná), zatímco Seil posílal zálohovou fakturu s jiným VS a účtem
  // z company_settings — takže k jedné platbě chodily dva různé symboly
  // a platba se nespárovala. Teď oboje odsud.

  fastify.get('/api/toneracek/orders/:id/payment-details', async (request, reply) => {
    if (!verifyApiKey(request)) return reply.code(401).send({ error: 'Unauthorized' });

    const [order] = await sql`SELECT * FROM shop_orders WHERE id = ${request.params.id} LIMIT 1`;
    if (!order) return reply.code(404).send({ error: 'Objednávka nenalezena' });
    if (order.payment_method !== 'Bankovní převod') {
      return reply.code(409).send({ error: 'not-transfer' });
    }

    try {
      const { paymentVs } = await import('../series-format.js');
      // ensure, ne fetch: když eager vystavení při přijetí objednávky spolkl
      // catch, endpoint se zhojí sám místo aby vrátil prázdno.
      const proforma = await ensureProformaForOrder(order);
      const [issuer] = await sql`SELECT * FROM company_settings LIMIT 1`;

      // PDF jen na vyžádání — děkovná stránka ho nepotřebuje a puppeteer
      // render při každém načtení stránky by byl zbytečně drahý.
      let pdf = null;
      if (request.query.pdf === '1') {
        const buffer = await renderProformaPdf(proforma);
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
      fastify.log.error({ err }, 'Platební údaje k objednávce se nepodařilo sestavit');
      return reply.code(503).send({ error: 'Platební údaje nejsou k dispozici' });
    }
  });

  // ── Admin: Seznam objednávek ───────────────────────────────

  fastify.get('/ucetnictvi/objednavky', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');

    const q            = (request.query.q      || '').trim();
    const statusFilter = (request.query.status || '').trim();
    const skladFilter  = (request.query.sklad  || '').trim();
    const page    = Math.max(1, parseInt(request.query.page || '1', 10));
    const perPage = 25;
    const offset  = (page - 1) * perPage;

    const shop = await getToneracekShop(sql);
    if (!shop) return reply.code(500).send('Toneráček shop není nakonfigurován');

    const conditions = [sql`o.shop_id = ${shop.id}`];
    if (q) conditions.push(sql`(
      o.order_number ILIKE ${'%'+q+'%'} OR
      o.first_name ILIKE ${'%'+q+'%'} OR o.last_name ILIKE ${'%'+q+'%'} OR
      o.email ILIKE ${'%'+q+'%'} OR o.phone ILIKE ${'%'+q+'%'} OR
      o.invoice_number ILIKE ${'%'+q+'%'}
    )`);
    if (statusFilter) conditions.push(sql`o.status = ${statusFilter}`);

    const where  = sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`;
    const zaklad = objednavkySeStavemSkladu(sql, shop, where);
    const skladWhere = SKLAD_STAVY.includes(skladFilter)
      ? sql`WHERE x.sklad_stav = ${skladFilter}`
      : sql``;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM (${zaklad}) x ${skladWhere}`;
    const orders      = await sql`
      SELECT * FROM (${zaklad}) x ${skladWhere}
      ORDER BY x.created_at DESC LIMIT ${perPage} OFFSET ${offset}
    `;
    const statusCounts = await sql`
      SELECT status, COUNT(*)::int AS n FROM shop_orders WHERE shop_id = ${shop.id} GROUP BY status
    `;
    // Počty pro chipy se počítají nad celým e-shopem, ne nad vyfiltrovaným
    // výběrem — jinak by po kliknutí na „nešlo do skladu" ostatní chipy zmizely.
    const skladCounts = await sql`
      SELECT x.sklad_stav, COUNT(*)::int AS n
      FROM (${objednavkySeStavemSkladu(sql, shop, sql`WHERE o.shop_id = ${shop.id}`)}) x
      GROUP BY x.sklad_stav
    `;

    // Výsledek ručního běhu se čte z databáze, ne z query parametru — takhle
    // banner sedí, i když požadavek spadl uprostřed expedice.
    const [expedice] = request.query.expedice
      ? await sql`
          SELECT * FROM warehouse_dispatches
          WHERE id = ${parseInt(request.query.expedice, 10) || 0} AND shop_id = ${shop.id}`
      : [];

    return reply.view('pages/toneracek/orders.ejs', {
      pageTitle: 'Objednávky Toneráček', currentPath: '/ucetnictvi/objednavky',
      user: request.user, orders, total: count, shop,
      currentPage: page, totalPages: Math.ceil(count / perPage),
      q, statusFilter, skladFilter, statusCounts, ORDER_STATUSES,
      skladCounts: Object.fromEntries(skladCounts.map(r => [r.sklad_stav, r.n])),
      duvody: DUVODY_POZASTAVENI,
      expedice: expedice || null, error: request.query.error || null,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Admin: Detail objednávky ───────────────────────────────

  fastify.get('/ucetnictvi/objednavky/:id', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const shop = await getToneracekShop(sql);
    if (!shop) return reply.code(500).send('Toneráček shop není nakonfigurován');

    const [order] = await sql`
      SELECT * FROM (${objednavkySeStavemSkladu(sql, shop,
        sql`WHERE o.id = ${request.params.id} AND o.shop_id = ${shop.id}`)}) x
    `;
    if (!order) return reply.code(404).send('Objednávka nenalezena');
    const items        = await sql`SELECT * FROM shop_order_items WHERE order_id = ${order.id}`;
    const [invoice]    = await sql`SELECT id, number FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'issued' LIMIT 1`;
    const [proforma]   = await sql`SELECT id, number, status FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'proforma' LIMIT 1`;
    const [sentBy]     = order.warehouse_sent_by
      ? await sql`SELECT first_name, last_name FROM users WHERE id = ${order.warehouse_sent_by}`
      : [];

    return reply.view('pages/toneracek/order-detail.ejs', {
      pageTitle: `Objednávka #${order.order_number}`,
      currentPath: '/ucetnictvi/objednavky', user: request.user,
      order, items, ORDER_STATUSES, invoice: invoice || null, proforma: proforma || null,
      error: request.query.error || null, saved: request.query.saved === '1',
      duvody: DUVODY_POZASTAVENI,
      sentBy: sentBy ? `${sentBy.first_name} ${sentBy.last_name}`.trim() : null,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Admin: Stažení PDF štítku přímo z Packeta API ──────────

  fastify.get('/ucetnictvi/objednavky/:id/stitek', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const shopId = await getToneracekShopId(sql);
    const [order] = await sql`
      SELECT tracking_number FROM shop_orders WHERE id = ${request.params.id} AND shop_id = ${shopId}
    `;
    if (!order?.tracking_number) return reply.code(404).send('Zásilka nenalezena');

    try {
      const pdf = await fetchPacketLabelPdf(order.tracking_number);
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `inline; filename="stitek-${order.tracking_number}.pdf"`);
      return reply.send(pdf);
    } catch (err) {
      fastify.log.error({ err }, 'Chyba při stažení štítku z Packeta API');
      return reply.code(502).send(`Nepodařilo se stáhnout štítek: ${err.message}`);
    }
  });

  // ── Admin: Změna stavu ─────────────────────────────────────

  fastify.post('/ucetnictvi/objednavky/:id/stav', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const { status, send_email } = request.body ?? {};
    if (!ORDER_STATUSES.includes(status)) return reply.code(400).send('Neplatný stav');

    const shopId = await getToneracekShopId(sql);
    const [order] = await sql`
      SELECT o.*, s.name AS shop_name
      FROM shop_orders o
      LEFT JOIN shops s ON o.shop_id = s.id
      WHERE o.id = ${request.params.id} AND o.shop_id = ${shopId}
    `;
    if (!order) return reply.code(404).send('Objednávka nenalezena');

    // ── Automatické vystavení faktury při přepnutí na "Vyřízena" ──
    if (status === 'Vyřízena') {
      const [existingInvoice] = await sql`SELECT id FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'issued' LIMIT 1`;
      if (!existingInvoice) {
        const isTransfer = order.payment_method === 'Bankovní převod';
        const [proforma] = await sql`SELECT * FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'proforma' LIMIT 1`;
        if (isTransfer && (!proforma || proforma.status !== 'Zaplacena')) {
          return reply.redirect(`/ucetnictvi/objednavky/${order.id}?error=proforma-nezaplacena`);
        }

        /*
         * Teprve tady je jisté, že jsou peníze na účtu — u převodu to hlídá
         * kontrola zálohovky o pár řádků výš, u karty Stripe webhook, který
         * balík podal už dřív. Proto se zásilka zakládá až v tuhle chvíli.
         *
         * Musí to být PŘED sestavením e-mailu s fakturou: ten nese sledovací
         * číslo, a to do téhle chvíle u převodu neexistovalo.
         */
        if (!order.tracking_number) {
          await pozadejEshopOPodaniBaliku(fastify.log, await brandForShopId(order.shop_id), order);
          const [cerstva] = await sql`SELECT tracking_number FROM shop_orders WHERE id = ${order.id}`;
          if (cerstva?.tracking_number) order.tracking_number = cerstva.tracking_number;
        }

        try {
          const { generateInvoiceForOrder, calcVatSummary } = await import('./invoices.js');
          const { renderInvoicePdf } = await import('../pdf.js');
          const { sendInvoiceEmail } = await import('../email.js');

          const invoice = await generateInvoiceForOrder(sql, order, { fromProforma: isTransfer ? proforma : null });
          fastify.log.info({ invoiceId: invoice.id, number: invoice.number }, 'Auto-faktura vygenerována');

          if (order.email) {
            const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${invoice.id}`;
            const [company] = await sql`SELECT * FROM company_settings LIMIT 1`;
            const issuer = company || {};

            // Táž chyba jako u zálohovky: bez klíče `total` tiskla šablona
            // v rekapitulaci DPH "NaN Kč".
            const vatSummary = calcVatSummary(items);

            // Tracking je k dispozici: u karty ho zapsal Stripe webhook,
            // u dobírky založení objednávky a u převodu ho pár řádků výš
            // dožádal pozadejEshopOPodaniBaliku(). Jde ven jedním e-mailem
            // spolu s fakturou.
            // Bez brandu by tenhle e-mail — nejdůležitější zpráva celé
            // objednávky — odešel jako SEIL s.r.o. <noreply@seil.cz>, tedy
            // od firmy, o které zákazník e-shopu nikdy neslyšel.
            const brand = await brandForShopId(order.shop_id);
            // Karta a převod jsou v tuhle chvíli zaplacené a doklad nevyzývá
            // k další platbě. Dobírka ne: zákazník platí až při převzetí,
            // takže razítko ZAPLACENO by u nevyzvednuté zásilky lhalo — PDF
            // místo něj i místo čísla účtu napíše, že se platí dobírkou.
            const uhrada = zobrazeniUhrady({ invoice, paymentMethod: order.payment_method });
            const pdfBuffer = await renderInvoicePdf({
              invoice, items, issuer, vatSummary, brand,
              paid: uhrada.zaplaceno, paymentMethod: order.payment_method,
            });
            // Vyřízená objednávka je vždycky zároveň předaná dopravci, takže
            // je to jedna zpráva, ne dvě varianty. Sledovací číslo tu bývá
            // (e-shop ho pošle hned po podání zásilky), ale když chybí,
            // zbytek e-mailu dává smysl i bez něj.
            await sendInvoiceEmail({
              invoice, issuer, brand, email: order.email, pdfBuffer,
              paid: uhrada.zaplaceno, paymentMethod: order.payment_method,
              trackingNumber: order.tracking_number || undefined,
              subject: `Objednávka #${order.order_number} vyřízena a předána dopravci`,
              intro: `Vaše objednávka č. <strong>${order.order_number}</strong> byla vyřízena a předána dopravci.<br>V příloze naleznete fakturu${order.tracking_number ? ', níže sledovací číslo zásilky' : ''}.${uhrada.dobirka ? '<br>Částku zaplatíte při převzetí zásilky.' : ''}`,
            });
            fastify.log.info({ email: order.email, tracking: order.tracking_number || null }, 'Email s fakturou odeslán');
          }
        } catch (err) {
          fastify.log.error({ err }, 'Chyba auto-generace faktury/emailu při vyřízení objednávky');
        }
      }
    }

    await sql`UPDATE shop_orders SET status = ${status}, modified_at = NOW() WHERE id = ${order.id}`;

    // Zákazníka o stavu vyrozumí e-mail jen u storna.
    //
    // "Vyřízena" hlásí e-mail s fakturou a sledovacím číslem výš. "Přijata"
    // by duplikovala děkovný e-mail z e-shopu — a přišla by z druhé identity
    // o pár minut později, což byla ta nejviditelnější stopa "dva systémy".
    if ((send_email === 'on' || send_email === '1') && status === 'Stornována' && order.email) {
      try {
        const [company] = await sql`SELECT * FROM company_settings LIMIT 1`;
        await sendOrderCancelledEmail({
          brand: await brandForShopId(order.shop_id),
          issuer: company || {},
          orderNumber: order.order_number,
          email: order.email,
          customerName: `${order.first_name} ${order.last_name}`.trim(),
        });
      } catch (err) {
        fastify.log.error({ err }, 'Chyba při odesílání e-mailu o stornu objednávky');
      }
    }

    return reply.redirect(`/ucetnictvi/objednavky/${order.id}`);
  });

  // ── Admin: Ruční odeslání expedice do skladu ───────────────
  //
  // Automat jede ráno sám. Tohle je cesta zpátky: ranní běh selhal, nebo se
  // objednávka zaplatila přes den a sklad na ni nemá čekat do zítřka.

  fastify.post('/ucetnictvi/objednavky/expedice', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');

    const shop = await getToneracekShop(sql);
    if (!shop) return reply.code(500).send('Toneráček shop není nakonfigurován');
    if (!shop.warehouse_email) return reply.redirect('/ucetnictvi/objednavky?error=sklad-email');

    let beh;
    try {
      beh = await zalozBeh(sql, {
        shop, kind: 'rucni', runDate: prazskyCas().datum, userId: request.user.id,
      });
    } catch (err) {
      // Zámek drží automat nebo druhý operátor — ať se sklad nedozví totéž dvakrát.
      if (err instanceof ExpediceBeziError) {
        return reply.redirect('/ucetnictvi/objednavky?error=expedice-bezi');
      }
      throw err;
    }

    await spustExpedici(sql, fastify.log, { shop, dispatch: beh });
    return reply.redirect(`/ucetnictvi/objednavky?expedice=${beh.id}`);
  });

  // ── Admin: Ruční značka „sklad to má" ──────────────────────
  //
  // Pro objednávky předané skladu jinou cestou (telefon, osobní předání)
  // a pro ty, které automat zadržel a obsluha je vyřídila sama.

  fastify.post('/ucetnictvi/objednavky/:id/sklad', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const shopId = await getToneracekShopId(sql);

    if ((request.body?.akce ?? '') === 'zrusit') {
      await sql`
        UPDATE shop_orders
        SET warehouse_sent_at = NULL, warehouse_sent_by = NULL, warehouse_dispatch_id = NULL,
            modified_at = NOW()
        WHERE id = ${request.params.id} AND shop_id = ${shopId}
      `;
    } else {
      // Podmínka na NULL drží čas skutečného odeslání — opakovaný klik ho nepřepíše.
      await sql`
        UPDATE shop_orders
        SET warehouse_sent_at = NOW(), warehouse_sent_by = ${request.user.id},
            warehouse_dispatch_id = NULL, warehouse_hold_reason = '', modified_at = NOW()
        WHERE id = ${request.params.id} AND shop_id = ${shopId} AND warehouse_sent_at IS NULL
      `;
    }
    return reply.redirect(`/ucetnictvi/objednavky/${request.params.id}?saved=1`);
  });

  // ── Admin: Uložení poznámky ────────────────────────────────

  fastify.post('/ucetnictvi/objednavky/:id/poznamka', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
    const { notes } = request.body ?? {};
    await sql`
      UPDATE shop_orders SET notes = ${notes??''}, modified_at = NOW()
      WHERE id = ${request.params.id}
    `;
    return reply.redirect(`/ucetnictvi/objednavky/${request.params.id}`);
  });

  // ── Admin: Migrace z Airtable ──────────────────────────────

  fastify.get('/ucetnictvi/migrace', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');
    return reply.view('pages/toneracek/migrace.ejs', {
      pageTitle: 'Migrace z Airtable', currentPath: '/ucetnictvi/objednavky',
      user: request.user, result: null,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/ucetnictvi/migrace', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Pouze admin');

    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return reply.view('pages/toneracek/migrace.ejs', {
        pageTitle: 'Migrace z Airtable', currentPath: '/ucetnictvi/objednavky',
        user: request.user,
        result: { error: 'Chybí AIRTABLE_API_KEY nebo AIRTABLE_BASE_ID v prostředí.' },
      }, { layout: 'layouts/base.ejs' });
    }

    const shopId = await getToneracekShopId(sql);
    if (!shopId) {
      return reply.view('pages/toneracek/migrace.ejs', {
        pageTitle: 'Migrace z Airtable', currentPath: '/ucetnictvi/objednavky',
        user: request.user,
        result: { error: 'Toneráček shop není nakonfigurován v databázi.' },
      }, { layout: 'layouts/base.ejs' });
    }

    const AT_ORDERS    = 'tblhP8tvVl0KdJQeR';
    const AT_ITEMS     = 'tblqjU6x9KTGEH7YW';
    const AT_CUSTOMERS = 'tblk6MpLpLpe7wTq7';
    const FC = {
      email: 'fldalJniBJAO6SSFB', orderLinks: 'fldiTbjYcUsE0e5d2',
      isRegistered: 'fldRegistrace', firstName: 'fldJmeno',
      lastName: 'fldPrijmeni', phone: 'fldTelefon', company: 'fldFirma',
    };
    const F = {
      orderNumber: 'fldrpOS8rh4zFuQhf', createdAt: 'fldBoq3y26qLLmFmf',
      status: 'fldqYJ0WgbNktvodr', firstName: 'fldSXFWeGZWP5p78m',
      lastName: 'fldHWnihHavgvzd7C', company: 'fld0baVKNA2s8Ew30',
      phone: 'fldM1HKgq9JG7z1Qv', address: 'fldRPHZNBLGIYctDq',
      city: 'fldz9ziSCPL4nhyRN', zip: 'fldNgmNrv1cwC2j4A',
      ipAddress: 'fldFT6kBX0IFpKf7F', shippingMethod: 'fld8Q8OjYH7vtGmK6',
      paymentMethod: 'fldfS6nqK4WallV4P', shippingFirstName: 'fld4IdoOPmcyrhp5L',
      shippingLastName: 'fld2sRyKXxE72cHM8', shippingCompany: 'fldeUtp0EUC74ycKf',
      shippingPhone: 'fldsWCHPNEkxI185x', shippingAddress: 'fldDi1E3Zc8PTyRnu',
      shippingCity: 'fldGluke3JodUfPc6', shippingZip: 'fldBBzDOdot41I90S',
      totalPrice: 'flds7bIEsbE2cEWWj', pickupPointName: 'fldcrzmuNe6XcYURH',
      pickupPointId: 'fldniFThX5tVAh1aB', trackingNumber: 'fldCZ1TBBTGgBMfVg',
      labelUrl: 'fldIMKECXvDhNCUct',
    };
    const FI = {
      orderLink: 'fldY2RggE06sKFJ8y', name: 'fldvB5z3lFM8JLTQT', quantity: 'fld8hRuAjAkk1VnSL',
    };

    async function fetchAll(table, fieldIds) {
      const records = [];
      let offset;
      do {
        const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${table}`);
        url.searchParams.set('returnFieldsByFieldId', 'true');
        url.searchParams.set('pageSize', '100');
        if (offset) url.searchParams.set('offset', offset);
        fieldIds.forEach(f => url.searchParams.append('fields[]', f));
        const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
        if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
        const data = await res.json();
        records.push(...data.records);
        offset = data.offset;
      } while (offset);
      return records;
    }

    const s = v => { if (!v && v !== 0) return ''; if (Array.isArray(v)) return v.filter(x => typeof x === 'string').join(', '); return String(v); };
    const n = v => { if (typeof v === 'number') return v; if (Array.isArray(v) && typeof v[0] === 'number') return v[0]; return 0; };

    try {
      const [orderRecords, itemRecords] = await Promise.all([
        fetchAll(AT_ORDERS, Object.values(F)),
        fetchAll(AT_ITEMS, Object.values(FI)),
      ]);

      const customerByOrder = {};
      let emailsNote = null;
      try {
        const customerRecords = await fetchAll(AT_CUSTOMERS, Object.values(FC));
        for (const rec of customerRecords) {
          const email = s(rec.fields[FC.email]);
          const links = rec.fields[FC.orderLinks];
          if (!email || !Array.isArray(links)) continue;
          const cust = {
            email, isRegistered: s(rec.fields[FC.isRegistered]) === 'Registrovaný',
            firstName: s(rec.fields[FC.firstName]), lastName: s(rec.fields[FC.lastName]),
            phone: s(rec.fields[FC.phone]), company: s(rec.fields[FC.company]),
          };
          for (const orderId of links) customerByOrder[orderId] = cust;
        }
      } catch (err) {
        emailsNote = `Emaily zákazníků nebyly načteny (${err.message}).`;
        fastify.log.warn(emailsNote);
      }

      const itemsByOrder = {};
      for (const rec of itemRecords) {
        const links = rec.fields[FI.orderLink];
        const orderId = Array.isArray(links) ? links[0] : links;
        if (!orderId) continue;
        if (!itemsByOrder[orderId]) itemsByOrder[orderId] = [];
        itemsByOrder[orderId].push({ name: s(rec.fields[FI.name]), quantity: n(rec.fields[FI.quantity]) || 1 });
      }

      const stats = { imported: 0, skipped: 0, items: 0, contacts: 0 };

      for (const rec of orderRecords) {
        const f = rec.fields;
        const atId = rec.id;
        const orderNum = n(f[F.orderNumber]);
        if (!orderNum) { stats.skipped++; continue; }

        const existing = await sql`
          SELECT id FROM shop_orders WHERE id = ${atId} OR (shop_id = ${shopId} AND order_number = ${String(orderNum)})
          LIMIT 1
        `;
        if (existing[0]) { stats.skipped++; continue; }

        const cust = customerByOrder[atId] || null;
        const email = cust?.email || '';
        const createdAt = s(f[F.createdAt]) || new Date().toISOString();
        const year = new Date(createdAt).getFullYear();

        await sql`
          INSERT INTO shop_orders (
            id, shop_id, order_number, status, payment_method, shipping_method,
            first_name, last_name, company, email, phone, address, city, zip,
            shipping_first_name, shipping_last_name, shipping_company,
            shipping_phone, shipping_address, shipping_city, shipping_zip,
            pickup_point_id, pickup_point_name, total_price, invoice_number,
            tracking_number, label_url, ip_address, created_at, modified_at
          ) VALUES (
            ${atId}, ${shopId}, ${String(orderNum)},
            ${s(f[F.status])||'Přijata'}, ${s(f[F.paymentMethod])}, ${s(f[F.shippingMethod])||'Zásilkovna'},
            ${s(f[F.firstName])}, ${s(f[F.lastName])}, ${s(f[F.company])},
            ${email}, ${s(f[F.phone])},
            ${s(f[F.address])}, ${s(f[F.city])}, ${s(f[F.zip])},
            ${s(f[F.shippingFirstName])||s(f[F.firstName])},
            ${s(f[F.shippingLastName]) ||s(f[F.lastName])},
            ${s(f[F.shippingCompany]) ||s(f[F.company])},
            ${s(f[F.shippingPhone])   ||s(f[F.phone])},
            ${s(f[F.shippingAddress]) ||s(f[F.address])},
            ${s(f[F.shippingCity])    ||s(f[F.city])},
            ${s(f[F.shippingZip])     ||s(f[F.zip])},
            ${s(f[F.pickupPointId])}, ${s(f[F.pickupPointName])},
            ${n(f[F.totalPrice])}, ${`FV-${year}-${orderNum}`},
            ${s(f[F.trackingNumber])}, ${s(f[F.labelUrl])}, ${s(f[F.ipAddress])},
            ${createdAt}, ${createdAt}
          )
        `;

        for (const item of (itemsByOrder[atId] || [])) {
          await sql`INSERT INTO shop_order_items (order_id, name, quantity) VALUES (${atId}, ${item.name}, ${item.quantity})`;
          stats.items++;
        }

        if (email) {
          try {
            const { contactId, companyId } = await upsertCustomerToCRM(sql, {
              email, firstName: cust?.firstName||s(f[F.firstName]),
              lastName: cust?.lastName||s(f[F.lastName]),
              company: cust?.company||s(f[F.company]),
              phone: cust?.phone||s(f[F.phone]),
              city: s(f[F.city]), country: 'Česká republika',
              isRegistered: cust?.isRegistered ?? false,
            });
            if (contactId || companyId) {
              await sql`
                UPDATE shop_orders SET crm_contact_id = ${contactId}, crm_company_id = ${companyId}
                WHERE id = ${atId}
              `;
            }
            stats.contacts++;
          } catch {}
        }

        stats.imported++;
      }

      fastify.log.info(stats, 'Airtable migrace dokončena');
      return reply.view('pages/toneracek/migrace.ejs', {
        pageTitle: 'Migrace z Airtable', currentPath: '/ucetnictvi/objednavky',
        user: request.user,
        result: { ...stats, total: orderRecords.length, totalItems: itemRecords.length, emailsNote },
      }, { layout: 'layouts/base.ejs' });

    } catch (err) {
      fastify.log.error({ err }, 'Airtable migrace selhala');
      return reply.view('pages/toneracek/migrace.ejs', {
        pageTitle: 'Migrace z Airtable', currentPath: '/ucetnictvi/objednavky',
        user: request.user, result: { error: err.message },
      }, { layout: 'layouts/base.ejs' });
    }
  });
}
