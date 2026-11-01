/**
 * Sekce Marketing: přehled PNO/ROAS/ROI po e-shopech, ruční náklady
 * a stav noční synchronizace (plán D3). Čísla skládá src/marketing/prehled.js
 * z SQL pomocníků v kpi.js; tady je jen načtení, formuláře a vykreslení.
 *
 * Přístup hlídá přístupová matice přes katalog v src/access.js (sekce
 * `marketing`); ruční spuštění syncu je navíc jen pro správce, protože
 * spotřebovává kvóty API platforem.
 *
 * E-shop se volí `?eshop=<slug>` jako u objednávek (toneracek.js); výchozí
 * je Toneráček. Nikdy se nemíchají data dvou e-shopů – každý dotaz nese shop_id.
 */

import { getDb } from '../db.js';
import { prazskyCas, jenDatum } from '../prazsky-cas.js';
import { PRESETY, rozsahCesky, vyhodnotObdobi } from '../marketing/obdobi.js';
import * as kpi from '../marketing/kpi.js';
import { PLATFORMA_POPIS, sestavPrehled } from '../marketing/prehled.js';
import { behySyncu, nactiZdroje, pocetBehuSyncu } from '../marketing/zdroje.js';
import { maKlic } from '../marketing/tajemstvi.js';
import { isConfigured as maGoogleServiceAccount } from '../google-auth.js';
import { parametr, strankovani } from '../strankovani.js';
import { bezpecnyNavrat } from '../navrat.js';
import { zalozka } from '../zalozky.js';

const VYCHOZI_ESHOP = 'toneracek';

/** Záložky přehledu; první je výchozí a do adresy se nepíše. */
const ZALOZKY_PREHLEDU = [
  ['prehled', 'Přehled'],
  ['kanaly', 'Kanály'],
  ['vyhledavani', 'Vyhledávání a e-shop'],
];

/** Platformy ručních nákladů – stejný seznam jako CHECK v migraci 042. */
export const RUCNI_PLATFORMY = ['google_ads', 'sklik', 'zbozi', 'heureka', 'meta', 'ostatni'];

/** Nejvyšší ruční náklad za jedno období; víc je skoro jistě překlep (haléře, částka za rok). */
const MAX_RUCNI_CASTKA = 10_000_000;

export default async function marketingRoutes(fastify) {
  const sql = getDb();

  async function eshopZDotazu(query) {
    const eshopy = await sql`
      SELECT id, slug, name, url, active,
             marketing_margin_pct::float8 AS marketing_margin_pct,
             marketing_pno_alert_pct::float8 AS marketing_pno_alert_pct
      FROM shops WHERE active = TRUE
      ORDER BY (slug = ${VYCHOZI_ESHOP}) DESC, name`;
    const slug = parametr(query?.eshop).toLowerCase();
    const shop = eshopy.find(e => e.slug === slug) ?? eshopy.find(e => e.slug === VYCHOZI_ESHOP) ?? eshopy[0] ?? null;
    return { eshopy, shop };
  }

  /** Query string s e-shopem (výchozí e-shop bez parametru, jako u objednávek) a případně obdobím. */
  function dotaz(shop, obdobi, dalsi = {}) {
    const q = new URLSearchParams();
    if (shop && shop.slug !== VYCHOZI_ESHOP) q.set('eshop', shop.slug);
    if (obdobi) {
      q.set('obdobi', obdobi.preset);
      if (obdobi.preset === 'vlastni') { q.set('od', obdobi.od); q.set('do', obdobi.do); }
    }
    for (const [k, v] of Object.entries(dalsi)) if (v != null && v !== '') q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  /** Dotaz přehledu: e-shop, období a záložka. Stejná adresa pro záložky i přepínač e-shopů. */
  const dotazPrehledu = (shop, obdobi, tab) => dotaz(shop, obdobi, { tab: tab === ZALOZKY_PREHLEDU[0][0] ? null : tab });

  /** Parametry odkazů stran: e-shop, na kterém seznam opravdu je, ne hodnota z adresy. */
  const eshopSeznamu = (shop) => (shop.slug === VYCHOZI_ESHOP ? {} : { eshop: shop.slug });

  const spolecne = (request, currentPath, eshopy, shop) => ({
    user: request.user, currentPath, eshopy, shop, vychoziEshop: VYCHOZI_ESHOP,
    saved: request.query.saved === '1', error: request.query.error || null,
  });

  // ── Přehled ─────────────────────────────────────────────────

  fastify.get('/marketing', async (request, reply) => {
    const { eshopy, shop } = await eshopZDotazu(request.query);
    const dnes = prazskyCas().datum;
    const obdobi = vyhodnotObdobi(request.query, dnes);
    const tab = zalozka(ZALOZKY_PREHLEDU, request.query.tab);
    const stranka = {
      pageTitle: 'Marketing', ...spolecne(request, '/marketing', eshopy, shop),
      obdobi, presety: PRESETY, dotaz, dotazPrehledu, zalozky: ZALOZKY_PREHLEDU, tab,
    };

    if (!shop) {
      return reply.view('pages/marketing/prehled.ejs', { ...stranka, prehled: null }, { layout: 'layouts/base.ejs' });
    }

    const rozsah = { shopId: shop.id, od: obdobi.od, do: obdobi.do };
    const [objednavky, nakladyApi, rucni, trzbyDny, nakladyDny, apiDny, funnel, kanalyGa4Radky, organika, merchant, konverze, eshopDny, zdroje] = await Promise.all([
      kpi.objednavkyZaObdobi(sql, rozsah),
      kpi.nakladyPlatforem(sql, rozsah),
      kpi.rucniNaklady(sql, rozsah),
      kpi.trzbyPoDnech(sql, rozsah),
      kpi.nakladyPoDnech(sql, rozsah),
      kpi.dnyNakladuPlatforem(sql, rozsah),
      kpi.funnelGa4(sql, rozsah),
      kpi.kanalyGa4(sql, rozsah),
      kpi.organikaSearchConsole(sql, rozsah),
      kpi.stavMerchantu(sql, rozsah),
      kpi.platformniKonverze(sql, rozsah),
      kpi.eshopStatistiky(sql, rozsah),
      nactiZdroje(sql, shop.id),
    ]);
    const polozky = await kpi.polozkyObjednavek(sql, objednavky.map(o => o.id));

    // Skládá se celý i pro jednu záložku: varování nad pruhem potřebují zdroje a ruční
    // náklady, kanály tržby a náklady, takže úspora by chtěla rozebrat sestavPrehled.
    const prehled = sestavPrehled({
      shop, obdobi, objednavky, polozky, nakladyApi, rucni, trzbyDny, nakladyDny, apiDny,
      funnel, kanalyGa4Radky, organika, merchant, konverze, eshopDny, zdroje, dnes,
    });

    return reply.view('pages/marketing/prehled.ejs', {
      ...stranka, prehled, dnes,
      extraJs: tab === 'prehled' ? '<script src="/static/chart.umd.min.js"></script><script src="/static/js/marketing.js"></script>' : '',
    }, { layout: 'layouts/base.ejs' });
  });

  // ── Ruční náklady ───────────────────────────────────────────
  //
  // Pro platformy, které API ještě nemají napojené, nebo za období před
  // napojením. Částka bez DPH se rozpočítá rovnoměrně po dnech období
  // (kpi.rozpoctiManualniNaklad); překryv s daty z API přehled hlásí.

  fastify.get('/marketing/naklady', async (request, reply) => {
    const { eshopy, shop } = await eshopZDotazu(request.query);
    let naklady = [];
    let strany = null;
    if (shop) {
      const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM marketing_manual_costs WHERE shop_id = ${shop.id}`;
      strany = strankovani({ cesta: '/marketing/naklady', query: request.query, celkem: count, pevne: eshopSeznamu(shop) });
      naklady = await sql`
        SELECT n.id, n.platform, n.date_from::text AS date_from, n.date_to::text AS date_to,
               n.amount::float8 AS amount, n.note, n.created_at,
               TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS zadal
        FROM marketing_manual_costs n
        LEFT JOIN users u ON u.id = n.created_by
        WHERE n.shop_id = ${shop.id}
        ORDER BY n.date_from DESC, n.id DESC
        LIMIT ${strany.naStranku} OFFSET ${strany.offset}`;
    }
    return reply.view('pages/marketing/naklady.ejs', {
      pageTitle: 'Ruční náklady na reklamu', ...spolecne(request, '/marketing/naklady', eshopy, shop),
      naklady, strany, smazano: request.query.smazano === '1',
      platformy: RUCNI_PLATFORMY, platformaPopis: PLATFORMA_POPIS, rozsahCesky, dotaz, dnes: prazskyCas().datum,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/marketing/naklady/vytvorit', async (request, reply) => {
    const b = request.body || {};
    const { shop } = await eshopZDotazu({ eshop: b.eshop });
    if (!shop) return reply.code(400).send('Neznámý e-shop');
    const zpet = (chyba) => reply.redirect(`/marketing/naklady${dotaz(shop, null, chyba ? { error: chyba } : { saved: 1 })}`);

    const platform = String(b.platform || '').trim();
    if (!RUCNI_PLATFORMY.includes(platform)) return zpet('platforma');
    const od = jenDatum(String(b.date_from || '').trim());
    const do_ = jenDatum(String(b.date_to || '').trim());
    if (!od || !do_ || od > do_) return zpet('obdobi');
    const castka = Number(String(b.amount ?? '').replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(castka) || castka < 0 || castka > MAX_RUCNI_CASTKA) return zpet('castka');
    const note = String(b.note || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 300);

    await sql`
      INSERT INTO marketing_manual_costs (shop_id, platform, date_from, date_to, amount, note, created_by)
      VALUES (${shop.id}, ${platform}, ${od}, ${do_}, ${Math.round(castka * 100) / 100}, ${note}, ${request.user.id})`;
    return zpet(null);
  });

  fastify.post('/marketing/naklady/:id/smazat', async (request, reply) => {
    const { shop } = await eshopZDotazu({ eshop: request.body?.eshop ?? request.query.eshop });
    if (!shop) return reply.code(400).send('Neznámý e-shop');
    // Číslo nad rozsah sloupce by Postgres odmítl a stránka by spadla na 500; devět číslic ruční náklady nepřekročí.
    const id = /^\d{1,9}$/.test(request.params.id) ? Number(request.params.id) : 0;
    // Jen vlastní e-shop: id z cizího e-shopu se nesmaže, ani omylem.
    const { count } = await sql`DELETE FROM marketing_manual_costs WHERE id = ${id} AND shop_id = ${shop.id}`;
    const navrat = bezpecnyNavrat(request.body?.redirect_to, `/marketing/naklady${dotaz(shop, null)}`);
    return reply.redirect(count ? `${navrat}${navrat.includes('?') ? '&' : '?'}smazano=1` : navrat);
  });

  // ── Synchronizace ───────────────────────────────────────────

  fastify.get('/marketing/sync', async (request, reply) => {
    const { eshopy, shop } = await eshopZDotazu(request.query);
    let zdroje = [];
    let behy = [];
    let strany = null;
    if (shop) {
      const pocet = await pocetBehuSyncu(sql, shop.id);
      // 50 na stránku: automat dělá až 8 běhů denně, tolik se tu ukazovalo i před stránkováním.
      strany = strankovani({ cesta: '/marketing/sync', query: request.query, celkem: pocet, naStranku: 50, pevne: eshopSeznamu(shop) });
      [zdroje, behy] = await Promise.all([nactiZdroje(sql, shop.id), behySyncu(sql, shop.id, strany.naStranku, strany.offset)]);
    }
    return reply.view('pages/marketing/sync.ejs', {
      pageTitle: 'Synchronizace marketingu', ...spolecne(request, '/marketing/sync', eshopy, shop),
      zdroje, behy, strany, dotaz, rozsahCesky,
      zadnyBeh: request.query.behu === '0', behSChybou: Number(parametr(request.query.chyb)) > 0,
      maGoogleSa: maGoogleServiceAccount(), maSecretsKey: maKlic(),
      jeAdmin: Boolean(request.user?.is_admin),
    }, { layout: 'layouts/base.ejs' });
  });

  /**
   * Ruční běh (jen správce – čerpá kvóty API). Samotný worker je
   * v src/marketing/sync.js; dokud není nasazený, tlačítko vrátí
   * srozumitelnou chybu místo 500.
   */
  fastify.post('/marketing/sync/spustit', async (request, reply) => {
    if (!request.user?.is_admin) return reply.code(403).send('Přístup odepřen – pouze administrátor');
    const b = request.body || {};
    const { shop } = await eshopZDotazu({ eshop: b.eshop });
    if (!shop) return reply.code(400).send('Neznámý e-shop');
    const zpet = (chyba, dalsi = {}) => reply.redirect(`/marketing/sync${dotaz(shop, null, chyba ? { error: chyba, ...dalsi } : { saved: 1, ...dalsi })}`);

    let sync;
    try {
      sync = await import('../marketing/sync.js');
    } catch (err) {
      request.log.warn({ err }, 'Marketing sync není k dispozici');
      return zpet('sync-nedostupny');
    }
    try {
      const vysledek = await sync.spustSyncRucne({
        sql, log: request.log, shopId: shop.id,
        platform: String(b.platform || 'vse'),
        od: jenDatum(String(b.od || '').trim()) || null,
        do: jenDatum(String(b.do || '').trim()) || null,
        userId: request.user.id,
      });
      const behy = Array.isArray(vysledek) ? vysledek : [vysledek];
      const chyb = behy.filter(beh => beh?.status === 'chyba').length;
      return zpet(null, { behu: behy.length, ...(chyb ? { chyb } : {}) });
    } catch (err) {
      if (err?.name === 'SyncBeziError') return zpet('sync-bezi');
      request.log.error({ err, shop: shop.slug }, 'Ruční sync marketingu selhal');
      return zpet('sync-chyba');
    }
  });
}
