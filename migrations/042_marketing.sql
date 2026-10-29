-- ============================================================
-- one.seil.space — marketing: zdroj objednávky, nákupní cena a statistiky platforem
-- ============================================================
-- Toneráček rozjíždí reklamu (Google, Sklik + Zboží.cz, Heureka, Meta)
-- a One SEIL má ukazovat, co stojí a co přináší: PNO, ROAS a marži po
-- kanálech, zvlášť pro každý e-shop. K tomu dnes chybí tři věci:
--
--   1. objednávka nenese, odkud zákazník přišel (UTM, click-id, referrer,
--      vstupní stránka) — za běžících kampaní je každá objednávka bez
--      atribuce ztracené číslo, proto jde tahle migrace na produkci DŘÍV
--      než e-shop, který pole začne posílat;
--   2. položka objednávky nenese nákupní cenu, takže se marže jen odhaduje;
--   3. není kam ukládat denní statistiky platforem, běhy synchronizace ani
--      ruční náklady za období, kdy API ještě nebylo napojené.
--
-- Nic tu nepřepisuje existující data ani výchozí hodnoty existujících
-- sloupců — jen přidává. Objednávky z doby před nasazením mají atribuci
-- prázdnou ('' a NULL) a attribution_consent = '' (= před nasazením);
-- /api/toneracek i /api/eshop zapisují nové sloupce vždy a bez `marketing`
-- v těle dosadí tytéž výchozí hodnoty (src/atribuce-objednavky.js).
--
-- Bezpečné na živé databázi: jen CREATE … IF NOT EXISTS a ADD COLUMN
-- IF NOT EXISTS s konstantní výchozí hodnotou, což Postgres od verze 11
-- zapíše do katalogu bez přepisu tabulky. CHECK na attribution_consent se
-- přidává zvlášť v bloku DO, který spolkne duplicate_object: ADD COLUMN
-- IF NOT EXISTS s vloženým CHECK by u už existujícího sloupce omezení
-- potichu vynechal.
--
-- Pořadí je kvůli zámkům, ne kvůli čtení. Celá migrace je jedna transakce
-- (src/migrate.js) a každý zámek drží až do COMMIT:
--   1. nové tabulky marketing_* — na ně zatím nikdo nesahá;
--   2. shop_order_items — čte se při detailu objednávky a v expedici;
--   3. shop_orders — 21 sloupců, každý ALTER bere výhradní zámek, ale
--      s konstantní výchozí hodnotou trvá milisekundy;
--   4. ALTER TABLE shops úplně nakonec — čte ho každý požadavek Toneráčku
--      (getToneracekShopId), výhradní zámek se tak drží jen do COMMIT, ne
--      po dobu čekání na zámky ostatních tabulek.
-- lock_timeout 2 s: když ALTER čeká za cizí transakcí (pg_dump, zapomenutá
-- psql session), radši ať start spadne, celá transakce se vrátí a kontejner
-- to zkusí znovu (docs/druhy-eshop.md, servisní okno).

SET LOCAL lock_timeout = '2s';

-- ── Napojení e-shopu na platformu ─────────────────────────────
-- Jeden řádek na (e-shop, platforma). Google (ga4, google_ads,
-- search_console, merchant) jede přes firemní service account z env
-- GOOGLE_SERVICE_ACCOUNT_JSON, tady je jen ID (property GA4, zákaznické
-- číslo Ads, adresa webu v Search Console, číslo účtu Merchant). Sklik
-- (klíč API Fénix s právem r), Heureka (API klíč) a Meta (token System
-- User) mají tajemství v secret_enc — šifrované AES-256-GCM klíčem
-- MARKETING_SECRETS_KEY z env, ven jde jen otisk. Zboží.cz vlastní zdroj
-- nemá: jeho statistiky jsou od října 2026 jen ve Skliku, zapisuje je
-- adaptér sklik. Platforma eshop = vlastní endpoint e-shopu
-- (GET /api/marketing/statistika: hledání bez výsledku, opuštěné košíky).

CREATE TABLE IF NOT EXISTS marketing_sources (
  id                 SERIAL PRIMARY KEY,
  shop_id            INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  platform           TEXT NOT NULL
    CHECK (platform IN ('ga4', 'google_ads', 'search_console', 'merchant', 'sklik', 'heureka', 'meta', 'eshop')),
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  external_id        TEXT NOT NULL DEFAULT '',
  parent_external_id TEXT NOT NULL DEFAULT '',
  secret_enc         TEXT NOT NULL DEFAULT '',
  secret_fingerprint TEXT NOT NULL DEFAULT '',
  secret_set_at      TIMESTAMPTZ,
  since              DATE,
  last_run_at        TIMESTAMPTZ,
  last_ok_at         TIMESTAMPTZ,
  last_error         TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, platform)
);

COMMENT ON TABLE marketing_sources IS
  'Napojení e-shopu na marketingovou platformu (jeden řádek na e-shop a platformu). Google přes service account z env, Sklik, Heureka a Meta s tajemstvím šifrovaným v secret_enc.';
COMMENT ON COLUMN marketing_sources.id IS
  'Interní číslo napojení.';
COMMENT ON COLUMN marketing_sources.shop_id IS
  'E-shop, kterému napojení patří. Data platforem se mezi e-shopy nikdy nemíchají.';
COMMENT ON COLUMN marketing_sources.platform IS
  'ga4, google_ads, search_console, merchant, sklik, heureka, meta nebo eshop. Zboží.cz vlastní zdroj nemá, plní ho adaptér sklik.';
COMMENT ON COLUMN marketing_sources.active IS
  'Vypnuté napojení noční sync přeskočí, nastavení i historie zůstanou.';
COMMENT ON COLUMN marketing_sources.external_id IS
  'ID na straně platformy: property GA4, zákaznické číslo Google Ads, adresa webu v Search Console, číslo účtu Merchant, účet Sklik, účet Meta (act_…). U eshop prázdné (bere se shops.url).';
COMMENT ON COLUMN marketing_sources.parent_external_id IS
  'Nadřazené ID, kde je potřeba: premiseId provozovny pro Seznam Nákupy u sklik, MCC (login-customer-id) u google_ads. Jinak prázdné.';
COMMENT ON COLUMN marketing_sources.secret_enc IS
  'Token nebo API klíč platformy šifrovaný AES-256-GCM klíčem MARKETING_SECRETS_KEY z env. Prázdné = bez tajemství (Google jede přes service account).';
COMMENT ON COLUMN marketing_sources.secret_fingerprint IS
  'Otisk tajemství pro zobrazení v nastavení (prvních osm znaků SHA-256). Tajemství z něj zpět nejde.';
COMMENT ON COLUMN marketing_sources.secret_set_at IS
  'Kdy bylo tajemství naposledy uložené. NULL = nikdy.';
COMMENT ON COLUMN marketing_sources.since IS
  'Od kterého dne stahovat data při prvním běhu (strop 400 dní zpět). NULL = jen okno posledních 14 dnů.';
COMMENT ON COLUMN marketing_sources.last_run_at IS
  'Kdy sync tenhle zdroj naposledy zkusil.';
COMMENT ON COLUMN marketing_sources.last_ok_at IS
  'Kdy sync tenhle zdroj naposledy dokončil bez chyby. Přehled podle toho ukazuje, jak stará data jsou.';
COMMENT ON COLUMN marketing_sources.last_error IS
  'Text poslední chyby (do 500 znaků), prázdné po úspěšném běhu.';
COMMENT ON COLUMN marketing_sources.created_at IS
  'Kdy napojení vzniklo.';
COMMENT ON COLUMN marketing_sources.modified_at IS
  'Poslední změna nastavení nebo tajemství.';

-- ── Běh synchronizace ─────────────────────────────────────────
-- Běh = zámek, vzor warehouse_dispatches (migrace 037): řádek vzniká PŘED
-- prací, opakování po chybě je UPDATE téhož řádku (attempt + 1). Dva
-- částečné unikátní indexy: jeden automatický běh na zdroj a pražský den
-- a nejvýš jeden rozběhnutý běh na zdroj (automat vs. ruční spuštění,
-- dvě repliky aplikace).

CREATE TABLE IF NOT EXISTS marketing_sync_runs (
  id          SERIAL PRIMARY KEY,
  source_id   INTEGER NOT NULL REFERENCES marketing_sources(id) ON DELETE CASCADE,
  shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL
    CHECK (platform IN ('ga4', 'google_ads', 'search_console', 'merchant', 'sklik', 'heureka', 'meta', 'eshop')),
  kind        TEXT NOT NULL DEFAULT 'auto'    CHECK (kind IN ('auto', 'rucni')),
  run_date    DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'probiha' CHECK (status IN ('probiha', 'hotovo', 'chyba')),
  attempt     INTEGER NOT NULL DEFAULT 1,
  permanent   BOOLEAN NOT NULL DEFAULT FALSE,
  from_date   DATE,
  to_date     DATE,
  rows_saved  INTEGER NOT NULL DEFAULT 0,
  error       TEXT NOT NULL DEFAULT '',
  started_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

COMMENT ON TABLE marketing_sync_runs IS
  'Jeden běh stažení statistik z platformy. Zároveň zámek: řádek vzniká před prací, opakování po chybě je attempt + 1 na témže řádku.';
COMMENT ON COLUMN marketing_sync_runs.id IS
  'Interní číslo běhu.';
COMMENT ON COLUMN marketing_sync_runs.source_id IS
  'Napojení (marketing_sources), které běh stahoval.';
COMMENT ON COLUMN marketing_sync_runs.shop_id IS
  'E-shop zdroje, zkopírovaný kvůli výpisům bez JOINu.';
COMMENT ON COLUMN marketing_sync_runs.platform IS
  'Platforma zdroje, zkopírovaná kvůli výpisům bez JOINu.';
COMMENT ON COLUMN marketing_sync_runs.kind IS
  'auto = noční scheduler, rucni = tlačítko v /marketing/sync.';
COMMENT ON COLUMN marketing_sync_runs.run_date IS
  'Pražské datum běhu. Pražské, ne serverové: kontejner nemá nastavené TZ.';
COMMENT ON COLUMN marketing_sync_runs.status IS
  'probiha, hotovo nebo chyba. Běh v probiha déle než 30 minut se bere jako přerušený (pád procesu).';
COMMENT ON COLUMN marketing_sync_runs.attempt IS
  'Kolikátý pokus (backoff 10, 20, 30 minut, nejvýš 6).';
COMMENT ON COLUMN marketing_sync_runs.permanent IS
  'TRUE = chyba, kterou opakování nespraví (401, 403, špatné ID), čeká na obsluhu.';
COMMENT ON COLUMN marketing_sync_runs.from_date IS
  'První den stahovaného okna.';
COMMENT ON COLUMN marketing_sync_runs.to_date IS
  'Poslední den stahovaného okna (zpravidla včerejšek).';
COMMENT ON COLUMN marketing_sync_runs.rows_saved IS
  'Kolik řádků marketing_daily_stats běh zapsal.';
COMMENT ON COLUMN marketing_sync_runs.error IS
  'Text chyby posledního pokusu (do 500 znaků), prázdné při úspěchu.';
COMMENT ON COLUMN marketing_sync_runs.started_by IS
  'Kdo běh spustil ručně. NULL u automatu.';
COMMENT ON COLUMN marketing_sync_runs.started_at IS
  'Začátek posledního pokusu.';
COMMENT ON COLUMN marketing_sync_runs.finished_at IS
  'Konec posledního pokusu, NULL dokud běží.';

CREATE UNIQUE INDEX IF NOT EXISTS marketing_sync_runs_auto_day_idx
  ON marketing_sync_runs (source_id, run_date) WHERE kind = 'auto';

CREATE UNIQUE INDEX IF NOT EXISTS marketing_sync_runs_running_idx
  ON marketing_sync_runs (source_id) WHERE status = 'probiha';

CREATE INDEX IF NOT EXISTS marketing_sync_runs_shop_idx
  ON marketing_sync_runs (shop_id, started_at DESC);

-- ── Denní statistiky ──────────────────────────────────────────
-- Jeden řádek na (e-shop, platforma, den, druh rozpadu, segment).
-- segment_kind = '' je denní součet platformy a JEN TEN vstupuje do KPI
-- (PNO, ROAS); rozpady (kampaň, kanál, dotaz, stránka, země, produkt) jsou
-- doplňkové a sčítat je s celkem by náklady zdvojilo. Sloupce jsou typované
-- metriky, ne JSONB: každá platforma vyplní svou část, zbytek nechá 0.
-- Náklady vždy bez DPH (Google i Meta reverse charge, Sklik haléře bez
-- DPH); Heureka posílá obojí, proto cost_with_vat. Sync přepisuje okno
-- posledních 14 dnů (DELETE okna + INSERT v jedné transakci), UNIQUE je
-- pojistka proti duplicitě.

CREATE TABLE IF NOT EXISTS marketing_daily_stats (
  id                 BIGSERIAL PRIMARY KEY,
  shop_id            INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  platform           TEXT NOT NULL
    CHECK (platform IN ('ga4', 'google_ads', 'search_console', 'merchant', 'sklik', 'zbozi', 'heureka', 'meta', 'eshop')),
  date               DATE NOT NULL,
  segment_kind       TEXT NOT NULL DEFAULT ''
    CHECK (segment_kind IN ('', 'campaign', 'channel', 'query', 'page', 'country', 'product')),
  segment            TEXT NOT NULL DEFAULT '',
  cost               NUMERIC(12,2) NOT NULL DEFAULT 0,
  cost_with_vat      NUMERIC(12,2) NOT NULL DEFAULT 0,
  impressions        INTEGER NOT NULL DEFAULT 0,
  clicks             INTEGER NOT NULL DEFAULT 0,
  conversions        NUMERIC(12,2) NOT NULL DEFAULT 0,
  conversion_value   NUMERIC(12,2) NOT NULL DEFAULT 0,
  sessions           INTEGER NOT NULL DEFAULT 0,
  total_users        INTEGER NOT NULL DEFAULT 0,
  view_item          INTEGER NOT NULL DEFAULT 0,
  add_to_cart        INTEGER NOT NULL DEFAULT 0,
  begin_checkout     INTEGER NOT NULL DEFAULT 0,
  purchase           INTEGER NOT NULL DEFAULT 0,
  purchase_revenue   NUMERIC(12,2) NOT NULL DEFAULT 0,
  position_sum       NUMERIC(14,2) NOT NULL DEFAULT 0,
  approved_items     INTEGER NOT NULL DEFAULT 0,
  disapproved_items  INTEGER NOT NULL DEFAULT 0,
  searches           INTEGER NOT NULL DEFAULT 0,
  searches_no_result INTEGER NOT NULL DEFAULT 0,
  carts_abandoned    INTEGER NOT NULL DEFAULT 0,
  carts_value        NUMERIC(12,2) NOT NULL DEFAULT 0,
  run_id             INTEGER REFERENCES marketing_sync_runs(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, platform, date, segment_kind, segment)
);

COMMENT ON TABLE marketing_daily_stats IS
  'Denní statistiky platforem po e-shopech. segment_kind = prázdné je denní součet platformy a jen ten vstupuje do KPI, rozpady jsou doplňkové. Náklady bez DPH.';
COMMENT ON COLUMN marketing_daily_stats.id IS
  'Interní číslo řádku.';
COMMENT ON COLUMN marketing_daily_stats.shop_id IS
  'E-shop, kterému řádek patří.';
COMMENT ON COLUMN marketing_daily_stats.platform IS
  'ga4, google_ads, search_console, merchant, sklik, zbozi, heureka, meta nebo eshop. zbozi zapisuje adaptér sklik (kampaně Seznam Nákupy).';
COMMENT ON COLUMN marketing_daily_stats.date IS
  'Den v pásmu účtu platformy (GA4, Ads, Meta) nebo pražský den (e-shop, objednávky).';
COMMENT ON COLUMN marketing_daily_stats.segment_kind IS
  'Prázdné = denní součet platformy (jediný řádek, který jde do KPI). campaign, channel, query, page, country, product = rozpad podle segmentu.';
COMMENT ON COLUMN marketing_daily_stats.segment IS
  'Hodnota segmentu (název kampaně, kanál, dotaz, cesta stránky, kód země, SKU). Prázdné u denního součtu.';
COMMENT ON COLUMN marketing_daily_stats.cost IS
  'Náklady na reklamu v CZK bez DPH.';
COMMENT ON COLUMN marketing_daily_stats.cost_with_vat IS
  'Náklady v CZK s DPH tam, kde je platforma posílá (Heureka). Jinak 0.';
COMMENT ON COLUMN marketing_daily_stats.impressions IS
  'Zobrazení (reklama, organika, Merchant). Heureka imprese neposílá.';
COMMENT ON COLUMN marketing_daily_stats.clicks IS
  'Kliknutí.';
COMMENT ON COLUMN marketing_daily_stats.conversions IS
  'Konverze podle platformy (Google Ads je dopočítává zlomkově). Jen pro porovnání, zdroj pravdy jsou objednávky v shop_orders.';
COMMENT ON COLUMN marketing_daily_stats.conversion_value IS
  'Hodnota konverzí podle platformy v CZK. Jen pro porovnání.';
COMMENT ON COLUMN marketing_daily_stats.sessions IS
  'GA4: relace.';
COMMENT ON COLUMN marketing_daily_stats.total_users IS
  'GA4: uživatelé.';
COMMENT ON COLUMN marketing_daily_stats.view_item IS
  'GA4: zobrazení produktu (trychtýř).';
COMMENT ON COLUMN marketing_daily_stats.add_to_cart IS
  'GA4: přidání do košíku (trychtýř).';
COMMENT ON COLUMN marketing_daily_stats.begin_checkout IS
  'GA4: zahájení pokladny (trychtýř).';
COMMENT ON COLUMN marketing_daily_stats.purchase IS
  'GA4: nákupy (trychtýř). Bez souhlasu s analytikou GA4 nákup nevidí, tržby proto vždy ze shop_orders.';
COMMENT ON COLUMN marketing_daily_stats.purchase_revenue IS
  'GA4: tržby z nákupů v CZK, jen pro porovnání.';
COMMENT ON COLUMN marketing_daily_stats.position_sum IS
  'Search Console: součet pozice krát zobrazení, průměrná pozice = position_sum / impressions.';
COMMENT ON COLUMN marketing_daily_stats.approved_items IS
  'Merchant Center: schválené položky feedu ke dni.';
COMMENT ON COLUMN marketing_daily_stats.disapproved_items IS
  'Merchant Center: zamítnuté položky feedu ke dni.';
COMMENT ON COLUMN marketing_daily_stats.searches IS
  'E-shop: hledání za den (ze statistiky e-shopu).';
COMMENT ON COLUMN marketing_daily_stats.searches_no_result IS
  'E-shop: hledání bez výsledku za den (chybějící náplně v katalogu).';
COMMENT ON COLUMN marketing_daily_stats.carts_abandoned IS
  'E-shop: opuštěné košíky založené ten den.';
COMMENT ON COLUMN marketing_daily_stats.carts_value IS
  'E-shop: hodnota opuštěných košíků v CZK s DPH, jak ji e-shop ukládá.';
COMMENT ON COLUMN marketing_daily_stats.run_id IS
  'Běh syncu, který řádek zapsal. NULL po smazání běhu.';
COMMENT ON COLUMN marketing_daily_stats.created_at IS
  'Kdy řádek vznikl (sync okno přepisuje, takže je to čas posledního přepisu).';

CREATE INDEX IF NOT EXISTS marketing_daily_stats_shop_date_idx
  ON marketing_daily_stats (shop_id, date);

-- ── Ruční náklady ─────────────────────────────────────────────
-- Náklady za období před napojením API nebo při jeho výpadku. Částka za
-- období se do KPI rozpočítá rovnoměrně po dnech; když pro tutéž platformu
-- a den existují i řádky z API, přehled varuje (dvojí započtení).
-- Heureka tu je jen jako záloha: má API s náklady (napojuje se až ve
-- 4. kroku nasazení), ručně se zadává jen do jeho napojení nebo při jeho
-- výpadku a při překryvu s řádky z API platí totéž varování.
-- Typy cizích klíčů podle skutečných tabulek: accounting_invoices.id je
-- TEXT (migrace 001), receipts.id SERIAL (migrace 005).

CREATE TABLE IF NOT EXISTS marketing_manual_costs (
  id         SERIAL PRIMARY KEY,
  shop_id    INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  platform   TEXT NOT NULL
    CHECK (platform IN ('google_ads', 'sklik', 'zbozi', 'heureka', 'meta', 'ostatni')),
  date_from  DATE NOT NULL,
  date_to    DATE NOT NULL,
  amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  invoice_id TEXT REFERENCES accounting_invoices(id) ON DELETE SET NULL,
  receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT marketing_manual_costs_obdobi_chk CHECK (date_to >= date_from),
  CONSTRAINT marketing_manual_costs_castka_chk CHECK (amount >= 0)
);

COMMENT ON TABLE marketing_manual_costs IS
  'Ručně zadané náklady na reklamu za období (před napojením API, při výpadku). Do KPI se rozpočítají rovnoměrně po dnech.';
COMMENT ON COLUMN marketing_manual_costs.id IS
  'Interní číslo nákladu.';
COMMENT ON COLUMN marketing_manual_costs.shop_id IS
  'E-shop, kterému náklad patří.';
COMMENT ON COLUMN marketing_manual_costs.platform IS
  'google_ads, sklik, zbozi, heureka, meta nebo ostatni.';
COMMENT ON COLUMN marketing_manual_costs.date_from IS
  'První den období.';
COMMENT ON COLUMN marketing_manual_costs.date_to IS
  'Poslední den období (včetně), nesmí být před date_from.';
COMMENT ON COLUMN marketing_manual_costs.amount IS
  'Částka za celé období v CZK bez DPH.';
COMMENT ON COLUMN marketing_manual_costs.note IS
  'Poznámka (číslo faktury dodavatele, kampaň).';
COMMENT ON COLUMN marketing_manual_costs.invoice_id IS
  'Přijatá faktura, ze které náklad je (accounting_invoices). NULL bez vazby.';
COMMENT ON COLUMN marketing_manual_costs.receipt_id IS
  'Účtenka, ze které náklad je (receipts). NULL bez vazby.';
COMMENT ON COLUMN marketing_manual_costs.created_by IS
  'Kdo náklad zadal.';
COMMENT ON COLUMN marketing_manual_costs.created_at IS
  'Kdy byl náklad zadán.';

CREATE INDEX IF NOT EXISTS marketing_manual_costs_shop_idx
  ON marketing_manual_costs (shop_id, date_from, date_to);

-- ── Nákupní cena položky ──────────────────────────────────────
-- Snímek nákupní ceny v okamžiku objednávky (katalog ji časem mění). Na
-- haléře, NE v celých korunách jako prodejní cena: na doklad nejde a marže
-- z ní má být přesná. Nikdy se nevrací e-shopu (by-number vybírá sloupce
-- výslovně). NULL = e-shop cenu neposlal (starší e-shop, pseudo-položky
-- DOPRAVA, DOBIRKA, SLEVA-REG, multipack s neúplnými komponentami).

ALTER TABLE shop_order_items ADD COLUMN IF NOT EXISTS cost_price              NUMERIC(10,2);
ALTER TABLE shop_order_items ADD COLUMN IF NOT EXISTS cost_price_vat_included BOOLEAN;

COMMENT ON COLUMN shop_order_items.cost_price IS
  'Nákupní cena za kus v okamžiku objednávky, na haléře. NULL = e-shop ji neposlal (pseudo-položky, starší e-shop). E-shopu se nikdy nevrací.';
COMMENT ON COLUMN shop_order_items.cost_price_vat_included IS
  'TRUE = cost_price je s DPH, FALSE = bez DPH (Toneráček), NULL = neznámo. Marže při TRUE nejdřív dělí 1,21.';

-- ── Atribuce objednávky ───────────────────────────────────────
-- První a poslední dotyk zákazníka před objednávkou tak, jak je posílá
-- e-shop v `marketing` (kontrakt v docs/api.md). Přípona _first/_last je
-- kvůli first_name/last_name. '' = nic (i u objednávek před nasazením),
-- touch_last_at IS NULL = e-shop atribuci neposlal → kanál neznámý. Proto
-- má dotyk, který něco nese, čas vždy: nepoužitelný čas z e-shopu (bez
-- pásma, nečitelný, mimo ±1 rok) nahradí čas přijetí objednávky.
-- Click-id (gclid, sznclid, …) se ukládá jen s marketingovým souhlasem
-- a noční sync ho po 90 dnech maže (retence, viz docs/moduly.md).

ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS utm_source_first    TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS utm_medium_first    TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS utm_campaign_first  TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS utm_term_first      TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS utm_content_first   TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS click_id_kind_first TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS click_id_first      TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS referrer_host_first TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS landing_page_first  TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS touch_first_at      TIMESTAMPTZ;

ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS utm_source_last     TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS utm_medium_last     TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS utm_campaign_last   TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS utm_term_last       TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS utm_content_last    TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS click_id_kind_last  TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS click_id_last       TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS referrer_host_last  TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS landing_page_last   TEXT NOT NULL DEFAULT '';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS touch_last_at       TIMESTAMPTZ;

ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS attribution_consent TEXT NOT NULL DEFAULT '';

-- CHECK zvlášť, ať platí i kdyby sloupec už existoval (ADD COLUMN IF NOT
-- EXISTS by vložený CHECK přeskočil). Podruhé spuštěné hlásí
-- duplicate_object a blok to spolkne.
DO $$
BEGIN
  ALTER TABLE shop_orders ADD CONSTRAINT shop_orders_attribution_consent_chk
    CHECK (attribution_consent IN ('', 'none', 'analytics', 'marketing', 'all'));
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

COMMENT ON COLUMN shop_orders.utm_source_first IS
  'První dotyk: utm_source malými písmeny (google, seznam, heureka.cz, …). Prázdné = neznámý nebo před nasazením atribuce.';
COMMENT ON COLUMN shop_orders.utm_medium_first IS
  'První dotyk: utm_medium malými písmeny (cpc, organic, referral, (none), …).';
COMMENT ON COLUMN shop_orders.utm_campaign_first IS
  'První dotyk: utm_campaign.';
COMMENT ON COLUMN shop_orders.utm_term_first IS
  'První dotyk: utm_term (klíčové slovo).';
COMMENT ON COLUMN shop_orders.utm_content_first IS
  'První dotyk: utm_content (varianta inzerátu).';
COMMENT ON COLUMN shop_orders.click_id_kind_first IS
  'První dotyk: druh click-id (gclid, gbraid, wbraid, fbclid, sznclid, sznaiid, hgtid, aku). Prázdné bez click-id.';
COMMENT ON COLUMN shop_orders.click_id_first IS
  'První dotyk: hodnota click-id. Jen s marketingovým souhlasem, po 90 dnech se maže.';
COMMENT ON COLUMN shop_orders.referrer_host_first IS
  'První dotyk: jen hostitel odkazujícího webu bez www. (google.com, seznam.cz). Prázdné = přímý přístup.';
COMMENT ON COLUMN shop_orders.landing_page_first IS
  'První dotyk: cesta vstupní stránky bez parametrů dotazu (/produkty/hp-12a).';
COMMENT ON COLUMN shop_orders.touch_first_at IS
  'Kdy první dotyk nastal (z e-shopu, paměť 90 dnů jen s marketingovým souhlasem), při nepoužitelném čase z e-shopu čas přijetí objednávky. NULL = e-shop první dotyk neposlal.';
COMMENT ON COLUMN shop_orders.utm_source_last IS
  'Poslední dotyk před objednávkou: utm_source malými písmeny. Kanál objednávky se počítá z posledního dotyku.';
COMMENT ON COLUMN shop_orders.utm_medium_last IS
  'Poslední dotyk: utm_medium malými písmeny.';
COMMENT ON COLUMN shop_orders.utm_campaign_last IS
  'Poslední dotyk: utm_campaign.';
COMMENT ON COLUMN shop_orders.utm_term_last IS
  'Poslední dotyk: utm_term.';
COMMENT ON COLUMN shop_orders.utm_content_last IS
  'Poslední dotyk: utm_content.';
COMMENT ON COLUMN shop_orders.click_id_kind_last IS
  'Poslední dotyk: druh click-id (gclid, gbraid, wbraid, fbclid, sznclid, sznaiid, hgtid, aku). Prázdné bez click-id.';
COMMENT ON COLUMN shop_orders.click_id_last IS
  'Poslední dotyk: hodnota click-id. Jen s marketingovým souhlasem, po 90 dnech se maže.';
COMMENT ON COLUMN shop_orders.referrer_host_last IS
  'Poslední dotyk: hostitel odkazujícího webu bez www.';
COMMENT ON COLUMN shop_orders.landing_page_last IS
  'Poslední dotyk: cesta vstupní stránky bez parametrů dotazu.';
COMMENT ON COLUMN shop_orders.touch_last_at IS
  'Kdy poslední dotyk nastal, při nepoužitelném čase z e-shopu čas přijetí objednávky. NULL = e-shop atribuci neposlal, kanál objednávky je neznámý.';
COMMENT ON COLUMN shop_orders.attribution_consent IS
  'Kategorie souhlasu z lišty e-shopu při objednávce: none, analytics, marketing nebo all. Prázdné = objednávka z doby před nasazením atribuce.';

-- ── Nastavení e-shopu ─────────────────────────────────────────
-- Poslední příkazy migrace — viz pořadí v hlavičce.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS marketing_margin_pct    NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS marketing_pno_alert_pct NUMERIC(5,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN shops.marketing_margin_pct IS
  'Odhad marže v procentech z ceny bez DPH pro položky bez cost_price (Toneráček zhruba 33). 0 = marže se bez nákupní ceny nepočítá.';
COMMENT ON COLUMN shops.marketing_pno_alert_pct IS
  'Práh PNO v procentech pro upozornění (Toneráček zhruba 28 = bod zvratu). 0 = bez upozornění.';
