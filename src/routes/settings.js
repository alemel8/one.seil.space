import { getDb, generateId } from '../db.js';
import { renderSeriesNumber } from '../series-format.js';
import { invalidateBrandCache, shopBrand } from '../brand.js';

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

  // ── Eshopy + API klíče ────────────────────────────────────────

  fastify.get('/nastaveni/eshopy', async (request, reply) => {
    const shops = await sql`
      SELECT s.*, COUNT(k.id)::int AS key_count
      FROM shops s
      LEFT JOIN api_keys k ON k.shop_id = s.id
      GROUP BY s.id ORDER BY s.name
    `;
    const keys = await sql`
      SELECT k.*, s.name AS shop_name
      FROM api_keys k JOIN shops s ON k.shop_id = s.id
      ORDER BY s.name, k.created_at DESC
    `;
    return reply.view('pages/settings/shops.ejs', {
      pageTitle: 'Eshopy & API klíče', currentPath: '/nastaveni/eshopy',
      user: request.user, shops, keys,
      saved: request.query.saved === '1', newKey: request.query.newKey || null,
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

  fastify.post('/nastaveni/eshopy/api-klic/vytvorit', async (request, reply) => {
    const b = request.body || {};
    const shopId = parseInt(b.shop_id, 10);
    if (!shopId) return reply.redirect('/nastaveni/eshopy?error=missing');

    // Vygeneruj bezpečný API klíč
    const { randomBytes } = await import('node:crypto');
    const newKey = randomBytes(32).toString('hex');

    await sql`INSERT INTO api_keys (key, shop_id, active) VALUES (${newKey}, ${shopId}, TRUE)`;
    return reply.redirect(`/nastaveni/eshopy?saved=1&newKey=${newKey}`);
  });

  fastify.post('/nastaveni/eshopy/api-klic/:id/deaktivovat', async (request, reply) => {
    await sql`UPDATE api_keys SET active = FALSE WHERE id = ${request.params.id}`;
    return reply.redirect('/nastaveni/eshopy');
  });

  // ── Detail eshopu (healthcheck + alerty) ──────────────────────

  fastify.get('/nastaveni/eshopy/:id', async (request, reply) => {
    const [shop] = await sql`SELECT * FROM shops WHERE id = ${request.params.id}`;
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
    const keys = await sql`SELECT * FROM api_keys WHERE shop_id = ${shop.id} ORDER BY created_at DESC`;
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

    return reply.view('pages/settings/shop-detail.ejs', {
      pageTitle: shop.name, currentPath: '/nastaveni/eshopy',
      user: request.user, shop, checks, keys, channels, rules, expedice,
      // Bez těchhle tajemství expedice objednávky jen zadrží — ať to admin
      // vidí tady, a ne až v pushi o zadržených objednávkách.
      maPacketaHeslo: Boolean(process.env.PACKETA_API_PASSWORD),
      maWebhookSecret: Boolean(process.env.SHOP_WEBHOOK_SECRET),
      saved: request.query.saved === '1', newKey: request.query.newKey || null,
      error: request.query.error || null,
    }, { layout: 'layouts/base.ejs' });
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
