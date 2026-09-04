-- ============================================================
-- one.seil.space — ranní expedice zaplacených objednávek do skladu
-- ============================================================
-- Sklad se o zaplacených objednávkách dozvídal ručně: někdo musel projít
-- administraci, stáhnout štítky a napsat e-mail. Nově to každý všední den
-- ráno udělá Seil sám. Aby to šlo, chybí v databázi tři věci.
--
-- **Značka „sklad už o tom ví“.** Bez ní by automat každé ráno posílal
-- tytéž objednávky znovu. Ukládá se čas, ne ano/ne — v UI je vidět, kdy to
-- skladu odešlo, a ručně označená objednávka se pozná podle `warehouse_sent_by`.
--
-- **Stavový řádek běhu** (`warehouse_dispatches`). Není to jen historie:
-- je to zámek. Pořadí zápisů je claim → razítko → odeslání → `email_sent_at`
-- → dokončení, takže pád procesu uprostřed (deploy v 07:02, SIGTERM) nikdy
-- nevede k druhému e-mailu skladu. Dva částečné unikátní indexy zajistí, že
-- na e-shop připadá jeden automatický běh na pražský den a nejvýš jeden
-- rozběhnutý běh vůbec — i kdyby klikli dva operátoři naráz.
--
-- **Kód dodavatele u položky.** `shop_order_items.sku` je interní kód
-- Toneráčku (T03065); sklad vychystává podle kódu dodavatele (5–6 číslic),
-- který dosud žil jen v Airtable e-shopu a nikam se neposílal.
--
-- Nic se zpětně nerazítkuje. Objednávky přijaté před spuštěním automatu
-- vyřídil sklad ručně a pozná se to podle `shops.warehouse_dispatch_since`,
-- ne podle vymyšleného data v `warehouse_sent_at`.

-- ── Běh expedice ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS warehouse_dispatches (
  id            SERIAL PRIMARY KEY,
  shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'auto'    CHECK (kind   IN ('auto', 'rucni')),
  run_date      DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'probiha' CHECK (status IN ('probiha', 'odeslano', 'prazdno', 'chyba')),
  attempt       INTEGER NOT NULL DEFAULT 1,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  email_sent_at TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  recipient     TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  resend_id     TEXT NOT NULL DEFAULT '',
  order_count   INTEGER NOT NULL DEFAULT 0,
  held_count    INTEGER NOT NULL DEFAULT 0,
  error         TEXT NOT NULL DEFAULT '',
  started_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE warehouse_dispatches IS
  'Jeden běh ranní expedice. Zároveň zámek: řádek vzniká PŘED prací, email_sent_at je bod, za kterým se běh už nikdy neposílá znovu.';
COMMENT ON COLUMN warehouse_dispatches.run_date IS
  'Pražské datum běhu. Pražské, ne serverové — kontejner nemá nastavené TZ.';
COMMENT ON COLUMN warehouse_dispatches.email_sent_at IS
  'Kdy Resend zprávu přijal. Vyplněné = e-mail odešel; obnova po pádu už jen dokončí evidenci a nikdy neposílá znovu.';

-- Jeden automatický běh na e-shop a pražský den. Opakování po chybě je UPDATE
-- téhož řádku (attempt + 1), ne nový řádek.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_dispatches_auto_day_idx
  ON warehouse_dispatches (shop_id, run_date) WHERE kind = 'auto';

-- Nejvýš jeden rozběhnutý běh na e-shop: brání souběhu automatu s ručním
-- spuštěním, dvou operátorů i dvou replik aplikace.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_dispatches_running_idx
  ON warehouse_dispatches (shop_id) WHERE status = 'probiha';

CREATE INDEX IF NOT EXISTS warehouse_dispatches_shop_idx
  ON warehouse_dispatches (shop_id, started_at DESC);

-- ── Značka na objednávce ──────────────────────────────────────

ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS warehouse_sent_at     TIMESTAMPTZ;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS warehouse_dispatch_id INTEGER REFERENCES warehouse_dispatches(id) ON DELETE SET NULL;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS warehouse_sent_by     INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS warehouse_hold_reason TEXT NOT NULL DEFAULT ''
  CHECK (warehouse_hold_reason IN ('', 'bez-vydejniho-mista', 'balik-nepodan', 'stitek-nestazen', 'neplatne-cislo-zasilky'));

COMMENT ON COLUMN shop_orders.warehouse_sent_at IS
  'Kdy objednávka odešla skladu (ranní expedicí nebo ručním označením). NULL = sklad o ní ještě neví.';
COMMENT ON COLUMN shop_orders.warehouse_dispatch_id IS
  'Běh, který objednávku skladu poslal. NULL u ručního označení.';
COMMENT ON COLUMN shop_orders.warehouse_sent_by IS
  'Kdo objednávku označil ručně. Automat sem nezapisuje — a podle toho se pozná, které razítko smí odvolat neúspěšné odeslání.';
COMMENT ON COLUMN shop_orders.warehouse_hold_reason IS
  'Proč objednávka do skladu nešla (chybí výdejní místo, balík se nepodal, štítek se nestáhl). Prázdné = v pořádku.';

-- Ranní dotaz prochází jen objednávky, které skladu ještě nešly.
CREATE INDEX IF NOT EXISTS shop_orders_warehouse_pending_idx
  ON shop_orders (shop_id, created_at) WHERE warehouse_sent_at IS NULL;

-- ── Kód dodavatele u položky ──────────────────────────────────

ALTER TABLE shop_order_items ADD COLUMN IF NOT EXISTS supplier_code TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN shop_order_items.supplier_code IS
  'Kód dodavatele, podle kterého sklad vychystává (Airtable Produkty „ID Dodavatele“). Posílá ho e-shop při založení objednávky. NENÍ to sku — to je interní kód Toneráčku. Prázdné = neznámý (objednávky před nasazením, multipacky).';

-- ── Nastavení expedice na e-shopu ─────────────────────────────

ALTER TABLE shops ADD COLUMN IF NOT EXISTS warehouse_email          TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS warehouse_dispatch_since DATE NOT NULL DEFAULT CURRENT_DATE;

COMMENT ON COLUMN shops.warehouse_email IS
  'Adresa skladu pro ranní expedici. Prázdné = expedice pro tenhle e-shop vypnutá (výchozí stav po nasazení).';
COMMENT ON COLUMN shops.warehouse_dispatch_since IS
  'Objednávky přijaté před tímhle dnem se skladu neposílají — vyřídil je ručně, než automat existoval. Při nasazení se nastaví na den migrace.';
