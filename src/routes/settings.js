import crypto from 'node:crypto';
import { getDb, generateId } from '../db.js';
import { renderSeriesNumber } from '../series-format.js';
import { invalidateBrandCache, shopBrand } from '../brand.js';
import { hashKlice, otiskKlice, vygenerujKlic } from '../eshop-klice.js';

/**
 * Toneráček jede přes /api/toneracek s klíčem z TONERACEK_API_KEY a jeho
 * účty jsou v crm_contacts. Klíč pro /api/eshop by mu založil druhou,
 * oddělenou sadu účtů, proto se pro něj nevydává.
 */
const ESHOP_S_VLASTNIM_API = 'toneracek';

export default async function settingsRoutes(fastify) {
  const sql = getDb();

  // Pouze admin
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Přístup odepřen — pouze administrátor');
  });

  // ── Nastavení firmy ──────────────────────────────────────────

  fastify.get('/nastaveni/firma', async (request, reply) => {
    const [company] = await sql`SELECT * FROM company_settings LIMIT 1`;
    return reply.view('pages/settings/company.ejs', {
      pageTitle: 'Nastavení firmy', currentPath: '/nastaveni/firma',
      user: request.user, company: company || {}, saved: request.query.saved === '1',
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/nastaveni/firma', async (request, reply) => {
    const b = request.body || {};
    const [existing] = await sql`SELECT id FROM company_settings LIMIT 1`;
    if (existing) {
      await sql`
        UPDATE company_settings SET
          name         = ${(b.name         ||'').trim()},
          ico          = ${(b.ico          ||'').trim()},
          dic          = ${(b.dic          ||'').trim()},
          address      = ${(b.address      ||'').trim()},
          city         = ${(b.city         ||'').trim()},
          zip          = ${(b.zip          ||'').trim()},
          country      = ${(b.country      ||'').trim()},
          phone        = ${(b.phone        ||'').trim()},
          email        = ${(b.email        ||'').trim()},
          bank_account = ${(b.bank_account ||'').trim()},
          bank_name    = ${(b.bank_name    ||'').trim()},
          iban         = ${(b.iban         ||'').trim()},
          swift        = ${(b.swift        ||'').trim()},
          vat_payer    = ${b.vat_payer === 'on' || b.vat_payer === '1'},
          invoice_note = ${(b.invoice_note ||'').trim()},
          pohoda_cash_account = ${(b.pohoda_cash_account ||'').trim() || 'Pokladna'},
          pohoda_predkontace  = ${(b.pohoda_predkontace  ||'').trim()},
          pohoda_predkontace_prijate = ${(b.pohoda_predkontace_prijate ||'').trim()},
          pohoda_predkontace_repre   = ${(b.pohoda_predkontace_repre   ||'').trim()},
          gdrive_root_folder_id = ${(b.gdrive_root_folder_id ||'').trim()},
          updated_at   = NOW()
        WHERE id = ${existing.id}
      `;
    } else {
      await sql`
        INSERT INTO company_settings
          (name, ico, dic, address, city, zip, country, phone, email,
           bank_account, bank_name, iban, swift, vat_payer, invoice_note,
           pohoda_cash_account, pohoda_predkontace,
           pohoda_predkontace_prijate, pohoda_predkontace_repre,
           gdrive_root_folder_id)
        VALUES (${(b.name||'').trim()}, ${(b.ico||'').trim()}, ${(b.dic||'').trim()},
                ${(b.address||'').trim()}, ${(b.city||'').trim()}, ${(b.zip||'').trim()},
                ${(b.country||'Česká republika').trim()}, ${(b.phone||'').trim()},
                ${(b.email||'').trim()}, ${(b.bank_account||'').trim()},
                ${(b.bank_name||'').trim()}, ${(b.iban||'').trim()}, ${(b.swift||'').trim()},
                ${b.vat_payer === 'on' || b.vat_payer === '1'},
                ${(b.invoice_note||'').trim()},
                ${(b.pohoda_cash_account||'').trim() || 'Pokladna'},
                ${(b.pohoda_predkontace||'').trim()},
                ${(b.pohoda_predkontace_prijate||'').trim()},
                ${(b.pohoda_predkontace_repre||'').trim()},
                ${(b.gdrive_root_folder_id||'').trim()})
      `;
    }
    return reply.redirect('/nastaveni/firma?saved=1');
  });

  // ── Číselné řady ─────────────────────────────────────────────

  fastify.get('/nastaveni/ciselne-rady', async (request, reply) => {
    const seriesRows = await sql`
      SELECT s.*, sh.name AS shop_name
      FROM invoice_number_series s
      LEFT JOIN shops sh ON s.shop_id = sh.id
      ORDER BY s.active DESC, s.name
    `;
    const series = seriesRows.map(s => ({
      ...s,
      example: renderSeriesNumber({ ...s, current_number: s.current_number + 1 }),
    }));
    const shops = await sql`SELECT id, name FROM shops WHERE active = TRUE ORDER BY name`;
    return reply.view('pages/settings/invoice-series.ejs', {
      pageTitle: 'Číselné řady', currentPath: '/nastaveni/ciselne-rady',
      user: request.user, series, shops,
      saved: request.query.saved === '1',
      error: request.query.error || null,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/nastaveni/ciselne-rady/vytvorit', async (request, reply) => {
    const b = request.body || {};
    const format = (b.format || '').trim();
    if (!b.name || (!b.prefix && !format)) return reply.redirect('/nastaveni/ciselne-rady?error=missing');
    const startNum = Math.max(0, parseInt(b.start_number || '1', 10));
    await sql`
      INSERT INTO invoice_number_series
        (name, prefix, year, current_number, start_number, padding, shop_id, active, entity_type, format)
      VALUES (
        ${b.name.trim()}, ${(b.prefix || '').trim().toUpperCase()},
        ${b.year ? parseInt(b.year, 10) : null},
        ${startNum - 1},
        ${startNum},
        ${parseInt(b.padding || '4', 10)},
        ${b.shop_id ? parseInt(b.shop_id, 10) : null},
        TRUE,
        ${['objednavka', 'zalohova_faktura'].includes(b.entity_type) ? b.entity_type : 'faktura'},
        ${format || null}
      )
    `;
    return reply.redirect('/nastaveni/ciselne-rady?saved=1');
  });

  fastify.post('/nastaveni/ciselne-rady/:id/deaktivovat', async (request, reply) => {
    await sql`UPDATE invoice_number_series SET active = FALSE WHERE id = ${request.params.id}`;
    return reply.redirect('/nastaveni/ciselne-rady');
  });

  fastify.post('/nastaveni/ciselne-rady/:id/aktivovat', async (request, reply) => {
    await sql`UPDATE invoice_number_series SET active = TRUE WHERE id = ${request.params.id}`;
    return reply.redirect('/nastaveni/ciselne-rady');
  });

  // ── Eshopy ────────────────────────────────────────────────────
  //
  // Klíče se vydávají jen v detailu e-shopu (karta „Napojení e-shopu“, tabulka
  // eshop_api_keys). Starší klíče z api_keys otevíraly /api/v1 a s ním všechny
  // kontakty v CRM; nikdo to API nepoužíval, 26. 10. 2026 zmizelo i s nimi.
  // Tabulka api_keys v databázi zůstala (nic se nemaže), kód ji už nečte.

  fastify.get('/nastaveni/eshopy', async (request, reply) => {
    const shops = await sql`
      SELECT s.*, COUNT(k.id) FILTER (WHERE k.active)::int AS key_count
      FROM shops s
      LEFT JOIN eshop_api_keys k ON k.shop_id = s.id
      GROUP BY s.id ORDER BY s.name
    `;
    return reply.view('pages/settings/shops.ejs', {
      pageTitle: 'Eshopy', currentPath: '/nastaveni/eshopy',
      user: request.user, shops, eshopSVlastnimApi: ESHOP_S_VLASTNIM_API,
      saved: request.query.saved === '1',
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/nastaveni/eshopy/vytvorit', async (request, reply) => {
    const b = request.body || {};
    if (!b.name || !b.slug) return reply.redirect('/nastaveni/eshopy?error=missing');
    await sql`
      INSERT INTO shops (slug, name, url, active)
      VALUES (${b.slug.trim().toLowerCase()}, ${b.name.trim()}, ${(b.url||'').trim()}, TRUE)
      ON CONFLICT (slug) DO NOTHING
    `;
    return reply.redirect('/nastaveni/eshopy?saved=1');
  });


  // ── Detail eshopu (healthcheck + alerty) ──────────────────────

  /**
   * Detail e-shopu. Vykresluje ho i POST, který vydává klíč nebo tajemství —
   * ty se ukážou jednou přímo v odpovědi. Přesměrování s klíčem v URL
   * (?newKey=…) by ho zapsalo do logu požadavků i do historie prohlížeče.
   */
  async function vykresliDetail(request, reply, shopId, extra = {}) {
    const [shop] = await sql`SELECT * FROM shops WHERE id = ${shopId}`;
    if (!shop) return reply.code(404).send('Eshop nenalezen');

    const checks = await sql`
      SELECT h.*, r.ok, r.status_code, r.latency_ms, r.checked_at, r.error
      FROM healthchecks h
      LEFT JOIN LATERAL (
        SELECT ok, status_code, latency_ms, checked_at, error
        FROM healthcheck_results WHERE check_id = h.id ORDER BY checked_at DESC LIMIT 1
      ) r ON TRUE
      WHERE h.shop_id = ${shop.id} ORDER BY h.name
    `;
    const eshopKlice = (await sql`
      SELECT k.id, k.label, k.active, k.created_at, k.last_used_at, k.revoked_at, k.key_hash,
             TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS vytvoril
      FROM eshop_api_keys k LEFT JOIN users u ON u.id = k.created_by
      WHERE k.shop_id = ${shop.id}
      ORDER BY k.active DESC, k.created_at DESC
    `).map(({ key_hash, ...k }) => ({ ...k, otisk: otiskKlice(key_hash) }));
    const channels = await sql`SELECT * FROM notification_channels ORDER BY name`;
    const rules = await sql`
      SELECT r.*, c.name AS channel_name FROM notification_rules r
      LEFT JOIN notification_channels c ON r.channel_id = c.id
      WHERE r.event_type = 'app_down' ORDER BY r.id
    `;

    const expedice = await sql`
      SELECT * FROM warehouse_dispatches WHERE shop_id = ${shop.id}
      ORDER BY started_at DESC LIMIT 5
    `;

    if (extra.novyEshopKlic || extra.novyWebhookSecret) {
      reply.header('Cache-Control', 'no-store');
    }

    const toneracek = shop.slug === ESHOP_S_VLASTNIM_API;

    return reply.view('pages/settings/shop-detail.ejs', {
      pageTitle: shop.name, currentPath: '/nastaveni/eshopy',
      user: request.user, shop, checks, channels, rules, expedice, eshopKlice,
      // Bez těchhle tajemství expedice objednávky jen zadrží — ať to admin
      // vidí tady, a ne až v pushi o zadržených objednávkách. Tajemství pro
      // podání balíku bere Toneráček jen z prostředí a ostatní e-shopy jen
      // vlastní (webhookSecretEshopu v expedice.js).
      maPacketaHeslo: Boolean(process.env.PACKETA_API_PASSWORD),
      maWebhookSecret: toneracek ? Boolean(process.env.SHOP_WEBHOOK_SECRET) : Boolean(shop.webhook_secret),
      tajemstviZProstredi: toneracek,
      otiskWebhookSecret: !toneracek && shop.webhook_secret ? otiskKlice(hashKlice(shop.webhook_secret)) : '',
      vydavaEshopKlice: !toneracek,
      novyEshopKlic: extra.novyEshopKlic || null,
      novyWebhookSecret: extra.novyWebhookSecret || null,
      saved: request.query.saved === '1',
      error: extra.error || request.query.error || null,
    }, { layout: 'layouts/base.ejs' });
  }

  fastify.get('/nastaveni/eshopy/:id', async (request, reply) => {
    return vykresliDetail(request, reply, request.params.id);
  });

  // ── Klíče pro /api/eshop ─────────────────────────────────────
  //
  // Jediné místo, kde se klíče vydávají (starší api_keys a /api/v1 jsou pryč,
  // viz přehled eshopů výš). V databázi zůstane jen otisk, klíč se ukáže
  // jednou v odpovědi na tenhle POST.

  fastify.post('/nastaveni/eshopy/:id/eshop-klic/vytvorit', async (request, reply) => {
    const shopId = parseInt(request.params.id, 10);
    if (!shopId) return reply.code(400).send('Neplatný eshop');
    const [shop] = await sql`SELECT id, slug FROM shops WHERE id = ${shopId}`;
    if (!shop) return reply.code(404).send('Eshop nenalezen');
    if (shop.slug === ESHOP_S_VLASTNIM_API) {
      return reply.redirect(`/nastaveni/eshopy/${shopId}?error=eshop-klic-toneracek`);
    }

    const label = String(request.body?.label || '').trim().slice(0, 100);
    const { klic, hash, otisk } = vygenerujKlic();
    await sql`
      INSERT INTO eshop_api_keys (shop_id, key_hash, label, active, created_by)
      VALUES (${shopId}, ${hash}, ${label}, TRUE, ${request.user.id})
    `;
    request.log.info({ shopId, otisk }, 'Vydán klíč pro /api/eshop');
    return vykresliDetail(request, reply, shopId, { novyEshopKlic: { klic, otisk, label } });
  });

  fastify.post('/nastaveni/eshopy/:id/eshop-klic/:keyId/zrusit', async (request, reply) => {
    const shopId = parseInt(request.params.id, 10);
    if (!shopId) return reply.code(400).send('Neplatný eshop');
    // Zneplatní se hned: API klíč ověřuje při každém požadavku, nic necachuje.
    await sql`
      UPDATE eshop_api_keys SET active = FALSE, revoked_at = COALESCE(revoked_at, NOW())
      WHERE id = ${parseInt(request.params.keyId, 10) || 0} AND shop_id = ${shopId}
    `;
    return reply.redirect(`/nastaveni/eshopy/${shopId}?saved=1`);
  });

  // ── Tajemství pro podání balíku (One SEIL → e-shop) ───────────
  //
  // Hlavička x-webhook-secret u POST {url e-shopu}/api/orders/podat-balik.
  // Každý e-shop kromě Toneráčku má vlastní; bez něj se jeho balík nepodá —
  // globální SHOP_WEBHOOK_SECRET je tajemství Toneráčku a jinam se neposílá.
  // Hodnota se v administraci neukazuje, jen otisk — ať jde porovnat
  // s WEBHOOK_SECRET v e-shopu, aniž by ležela v HTML.

  fastify.post('/nastaveni/eshopy/:id/webhook-secret', async (request, reply) => {
    const shopId = parseInt(request.params.id, 10);
    if (!shopId) return reply.code(400).send('Neplatný eshop');
    const [shop] = await sql`SELECT id, slug FROM shops WHERE id = ${shopId}`;
    if (!shop) return reply.code(404).send('Eshop nenalezen');

    // Toneráček jede jen na SHOP_WEBHOOK_SECRET z prostředí, stejně jako jeho
    // API klíč. Dřív tu šlo jedním kliknutím nastavit mu vlastní tajemství,
    // které e-shop Toneráčku nezná — podání balíku by pak vracelo 401
    // a převody by se vyřizovaly bez zásilky.
    if (shop.slug === ESHOP_S_VLASTNIM_API) {
      return reply.redirect(`/nastaveni/eshopy/${shopId}?error=webhook-secret-toneracek`);
    }

    const akce = String(request.body?.akce || '');
    if (akce === 'vymazat') {
      await sql`UPDATE shops SET webhook_secret = '' WHERE id = ${shopId}`;
      return reply.redirect(`/nastaveni/eshopy/${shopId}?saved=1`);
    }
    if (akce === 'vygenerovat') {
      const secret = crypto.randomBytes(32).toString('hex');
      await sql`UPDATE shops SET webhook_secret = ${secret} WHERE id = ${shopId}`;
      return vykresliDetail(request, reply, shopId, { novyWebhookSecret: secret });
    }

    const secret = String(request.body?.webhook_secret || '').trim();
    // Krátké nebo s mezerou je skoro jistě chyba při kopírování; tajemství
    // se navíc posílá v hlavičce, kde mezera nemá co dělat.
    if (secret.length < 32 || /\s/.test(secret)) {
      return reply.redirect(`/nastaveni/eshopy/${shopId}?error=webhook-secret`);
    }
    await sql`UPDATE shops SET webhook_secret = ${secret} WHERE id = ${shopId}`;
    return reply.redirect(`/nastaveni/eshopy/${shopId}?saved=1`);
  });

  // ── Identita e-mailů e-shopu ─────────────────────────────────
  //
  // Odesílatel, barvy a kontakty pro zákaznické e-maily. Do migrace 030 to
  // byly konstanty v kódu, takže druhý e-shop by posílal svá storna jako
  // Toneráček.

  fastify.post('/nastaveni/eshopy/:id/identita', async (request, reply) => {
    const b = request.body || {};
    const shopId = parseInt(request.params.id, 10);
    if (!shopId) return reply.code(400).send('Neplatný eshop');

    const from = (b.email_from_address || '').trim().toLowerCase();
    // Stejná podmínka hlídá i CHECK constraint v migraci 030 — tohle jen
    // vrátí srozumitelnou chybu místo pádu na databázi.
    if (from.endsWith('@seil.cz')) {
      return reply.redirect(`/nastaveni/eshopy/${shopId}?error=firemni-adresa`);
    }

    await sql`
      UPDATE shops SET
        email_from_name       = ${(b.email_from_name       ||'').trim()},
        email_from_address    = ${from},
        email_reply_to        = ${(b.email_reply_to        ||'').trim()},
        support_email         = ${(b.support_email         ||'').trim()},
        support_phone         = ${(b.support_phone         ||'').trim()},
        support_phone_link    = ${(b.support_phone_link    ||'').trim()},
        tagline               = ${(b.tagline               ||'').trim()},
        claim                 = ${(b.claim                 ||'').trim()},
        logo_mark_url         = ${(b.logo_mark_url         ||'').trim()},
        logo_wordmark_url     = ${(b.logo_wordmark_url     ||'').trim()},
        color_primary         = ${(b.color_primary         ||'').trim()},
        color_primary_dark    = ${(b.color_primary_dark    ||'').trim()},
        color_primary_light   = ${(b.color_primary_light   ||'').trim()},
        color_on_primary_soft = ${(b.color_on_primary_soft ||'').trim()}
      WHERE id = ${shopId}
    `;
    invalidateBrandCache(shopId);
    return reply.redirect(`/nastaveni/eshopy/${shopId}?saved=1`);
  });

  // ── Expedice do skladu ───────────────────────────────────────
  //
  // Prázdná adresa znamená vypnuto — po nasazení tedy automat mlčí, dokud si
  // ho někdo vědomě nezapne. `warehouse_dispatch_since` chrání první ráno:
  // starší objednávky vyřídil sklad ručně a nemá je dostat znovu.

  fastify.post('/nastaveni/eshopy/:id/expedice', async (request, reply) => {
    const b = request.body || {};
    const shopId = parseInt(request.params.id, 10);
    if (!shopId) return reply.code(400).send('Neplatný eshop');

    const email = (b.warehouse_email || '').trim().toLowerCase();
    if (email && !email.includes('@')) {
      return reply.redirect(`/nastaveni/eshopy/${shopId}?error=sklad-email`);
    }

    const bcc = (b.warehouse_email_bcc || '').trim().toLowerCase();
    if (bcc && !bcc.includes('@')) {
      return reply.redirect(`/nastaveni/eshopy/${shopId}?error=sklad-kopie`);
    }

    const since = (b.warehouse_dispatch_since || '').trim();
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return reply.redirect(`/nastaveni/eshopy/${shopId}?error=sklad-datum`);
    }

    await sql`
      UPDATE shops SET
        warehouse_email = ${email},
        warehouse_email_bcc = ${bcc},
        warehouse_dispatch_since = COALESCE(${since || null}::date, warehouse_dispatch_since)
      WHERE id = ${shopId}
    `;
    return reply.redirect(`/nastaveni/eshopy/${shopId}?saved=1`);
  });

  // Náhled bez odesílání — ať se barvy a loga dají zkontrolovat v prohlížeči
  // dřív, než odejdou zákazníkovi.
  fastify.get('/nastaveni/eshopy/:id/nahled-emailu', async (request, reply) => {
    const { emailShell, banner, infoBlock, infoRow } = await import('../email-templates.js');
    const [issuer] = await sql`SELECT * FROM company_settings LIMIT 1`;

    let brand;
    try {
      brand = await shopBrand(parseInt(request.params.id, 10));
    } catch (err) {
      return reply.code(400).type('text/plain; charset=utf-8').send(err.message);
    }

    const html = emailShell({
      brand, issuer: issuer || {},
      title: 'Náhled e-mailu',
      bannerHtml: banner({
        tone: 'green', icon: '✅',
        title: 'Objednávka #10001 vyřízena', subtitle: 'Zásilka je na cestě',
      }),
      body: `
        <p style="font-size:15px;color:#334155;margin:0 0 16px">Dobrý den,</p>
        <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 20px">
          takhle vypadá e-mail, který zákazníkovi odešle One SEIL jménem e-shopu
          <strong>${brand.name}</strong>.
        </p>
        ${infoBlock('Faktura', infoRow('Číslo faktury', 'FV-2026-10001') + infoRow('Celkem k úhradě', '<strong>1 085,00 Kč</strong>'))}`,
    });

    return reply.type('text/html; charset=utf-8').send(html);
  });

  // ── Účetní osnova (číselník účtů MD/D) ───────────────────────

  fastify.get('/nastaveni/ucetni-osnova', async (request, reply) => {
    const accounts = await sql`SELECT * FROM accounting_chart ORDER BY code`;
    return reply.view('pages/settings/accounts.ejs', {
      pageTitle: 'Účetní osnova', currentPath: '/nastaveni/ucetni-osnova',
      user: request.user, accounts, saved: request.query.saved === '1',
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/nastaveni/ucetni-osnova/vytvorit', async (request, reply) => {
    const b = request.body || {};
    if (!b.code || !b.name) return reply.redirect('/nastaveni/ucetni-osnova');
    await sql`
      INSERT INTO accounting_chart (code, name, active)
      VALUES (${b.code.trim()}, ${b.name.trim()}, TRUE)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, active = TRUE
    `;
    return reply.redirect('/nastaveni/ucetni-osnova?saved=1');
  });

  fastify.post('/nastaveni/ucetni-osnova/:id/smazat', async (request, reply) => {
    await sql`DELETE FROM accounting_chart WHERE id = ${request.params.id}`;
    return reply.redirect('/nastaveni/ucetni-osnova');
  });

  fastify.post('/nastaveni/ucetni-osnova/:id/toggle', async (request, reply) => {
    await sql`UPDATE accounting_chart SET active = NOT active WHERE id = ${request.params.id}`;
    return reply.redirect('/nastaveni/ucetni-osnova');
  });

  // ── API: Číselník účtů (pro autocomplete) ────────────────────

  fastify.get('/api/accounting-chart', async (request, reply) => {
    const accounts = await sql`SELECT code, name FROM accounting_chart WHERE active = TRUE ORDER BY code`;
    return reply.send(accounts);
  });

  // ── API: Vygenerování čísla faktury (interní helper) ─────────

  fastify.post('/api/invoice-series/:id/next', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const [series] = await sql`
      UPDATE invoice_number_series
      SET current_number = current_number + 1
      WHERE id = ${request.params.id} AND active = TRUE
      RETURNING *
    `;
    if (!series) return reply.code(404).send({ error: 'Číselná řada nenalezena' });

    const number = renderSeriesNumber(series);
    return reply.send({ number, seriesId: series.id });
  });
}
