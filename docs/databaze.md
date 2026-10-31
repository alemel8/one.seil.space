# Databázové schéma

Systém používá **PostgreSQL 16** pro všechna živá data. Pro historické VPS metriky slouží **SQLite** (`data/history.sqlite`) — ta je read-only z aplikace, zapisuje do ní pouze collector běžící na hostu.

Migrace jsou číslovány (`migrations/001_initial_schema.sql` … `010_push_subscriptions.sql`) a spouštějí se automaticky při každém startu serveru přes `src/migrate.js`. Provedené migrace jsou evidovány v tabulce `schema_migrations`.

---

## Uživatelé a session

### `users`
Uživatelé systému.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `public_id` | TEXT UNIQUE | 12 hex znaků, v URL místo `id`; výchozí hodnota generuje databáze |
| `email` | TEXT UNIQUE | |
| `password_hash` | TEXT | bcryptjs, salt 10 |
| `first_name` | TEXT | |
| `last_name` | TEXT | |
| `is_admin` | BOOL | Přístup k admin sekcím |
| `is_active` | BOOL | Deaktivovaný účet se nemůže přihlásit |
| `photo` | TEXT | Název souboru v `data/media/` |
| `created_at` | TIMESTAMPTZ | |
| `title`, `phone`, `position`, `bio` | TEXT | HR údaje (migrace 012) |
| `address`, `city`, `zip`, `country` | TEXT | Adresa |
| `bank_account`, `bank_name`, `iban` | TEXT | Bankovní spojení |

### `user_access`
Přístupová matice — kdo vidí kterou sekci systému. Klíče definuje katalog
v `src/access.js`; chybějící řádek znamená „vidí“.

| Sloupec | Typ | Popis |
|---|---|---|
| `user_id` | INT → users | ON DELETE CASCADE |
| `access_key` | TEXT | Např. `ucetnictvi.banka` (PK spolu s `user_id`) |
| `allowed` | BOOL | |
| `updated_at` | TIMESTAMPTZ | |

### `session`
PostgreSQL session store (connect-pg-simple). Spravuje se automaticky.

---

## Personální agenda

Přeneseno z Airtable základen, které se ruší. Kolem jednoho člověka se točí
tři toky a jejich rozdíl je jeho **osobní zůstatek**:
příjmy (fakturační podklady) − výdaje (mzdy) − platby mimo mzdu.

### `hr_employments`
Zaměstnanecký poměr. Vlastní tabulka, ne sloupce na `users` — sazba i typ
úvazku se v čase mění a mzdový list se musí odkázat na to, co platilo tehdy.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | TEXT PK | `generateId()` |
| `user_id` | INT → users | ON DELETE **RESTRICT** — mzdový list se archivuje 30 let |
| `kind` | TEXT | `hpp` \| `dpp` \| `dpc` \| `osvc` \| `jednatel` |
| `monthly_gross`, `hourly_rate` | NUMERIC | sjednaná hrubá / sazba |
| `started_on`, `ended_on` | DATE | |

### `hr_work_reports`
Fakturační podklad — jedna služební cesta nebo zakázka, ze které vznikla
vydaná faktura.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | TEXT PK | |
| `user_id` | INT → users | RESTRICT |
| `report_date` | DATE | |
| `breakdown` | TEXT | volný rozpad hodin a výdajů, **neparsuje se** |
| `total_amount` | NUMERIC(12,2) | k fakturaci |
| `status` | TEXT | `rozpracovano` \| `k_fakturaci` \| `odeslano` \| `fakturovano` \| `storno` |
| `invoice_id` | TEXT → accounting_invoices | vydaná faktura se odkazuje, nekopíruje |
| `invoice_number` | TEXT | zůstává i bez vazby, aby šlo spárovat později |
| `airtable_id` | TEXT | partial UNIQUE — idempotence importu |

`hr_work_report_projects` a `hr_work_report_locations` drží vícehodnotová
čísla zakázek a lokality. Nejsou to projekty SEIL, ale **zakázková čísla
odběratele**, proto vlastní tabulky a ne vazba na `projects`.

### `hr_payroll_runs`
Mzdový list za jeden měsíc. HPP i dohody v jedné tabulce — liší se vyplněná
pole, ne rytmus.

| Sloupec | Typ | Popis |
|---|---|---|
| `period` | DATE | vždy 1. den měsíce, ZA který mzda je |
| `hours`, `hourly_rate`, `earned` | NUMERIC | dohody |
| `gross`, `net` | NUMERIC | hrubá, čistá |
| `social`, `health` | NUMERIC | odvody **za zaměstnance i zaměstnavatele dohromady** |
| `tax`, `insolvency`, `garnishment`, `accident_insurance` | NUMERIC | srážky |
| `company_cost` | NUMERIC | **náklad zaměstnavatele → jde do hrubého zisku** |
| `paid_total` | NUMERIC GENERATED | **co odešlo z účtu → jde do osobního zůstatku** |

`company_cost` a `paid_total` **nejsou zaměnitelné** a u části měsíců se liší.
`company_cost` se ukládá tak, jak přišel z mzdové účtárny, a nedopočítává se.

Bez unikátního klíče na `(user_id, period)` — Airtable vede na některé měsíce
dva listy a sloučit je při importu by byla interpretace. UI takový měsíc označí.

### `hr_payroll_items`
Platby mimo mzdu. `kind` rozlišuje `zaloha` (pohledávka za zaměstnancem, účet
335 — **není náklad**) od `proplaceny_naklad` (náklad je). Špatné zařazení
posune hrubý zisk.

### `hr_documents`
Osobní a smluvní dokumenty. `category` je volný text — v Airtable byla
vyplněná u tří záznamů z deseti a odvozuje se z názvu.

---

## Úkoly a měření času

### `tasks`
Úkoly. `code` (`GUK-467`), self-link `parent_id`, vazba na `crm_companies`
a `projects`. Naměřený čas se **neukládá** — dopočítá se z `time_entries`,
aby se uložená kopie nerozešla první spuštěnou stopkou.

### `time_entries`
Měření času. `ended_at IS NULL` znamená **běžící stopky**; částečný unikátní
index `time_entries_running_idx` hlídá, že běží nejvýš jedny na člověka.
`duration_seconds` je generovaný sloupec.

---

## Přílohy

### `attachments`
Do migrace 022 uměl systém právě **jednu** přílohu na doklad (sloupce
`attachment_path`/`_mime`/`_size` přímo na tabulce). Mzdový balíček od účetní
jich má 4 až 17, proto vlastní tabulka.

Vlastník se drží **výlučným obloukem**: vyplněný je právě jeden z pěti FK
sloupců (`work_report_id`, `payroll_run_id`, `payroll_item_id`, `document_id`,
`task_id`), což hlídá CHECK. Proti dvojici (typ, id) to má skutečné cizí klíče
a kaskádu — smazaný mzdový list po sobě nenechá osiřelé soubory.

Účtenky a faktury se sem **nepřevádějí** — fungují a mají vlastní UI.

Pohled **`attachment_files`** sjednocuje všechny zdroje souborů; z něj čte
`checkAttachments()` (`src/attachments.js`). Kdyby se seznam tabulek psal v JS,
na další entitu by se dřív nebo později zapomnělo.

---

## E-shopy a objednávky

### `shops`
Registrované e-shopy.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `slug` | TEXT UNIQUE | Identifikátor (např. `toneracek`) |
| `name` | TEXT | Zobrazovaný název |
| `url` | TEXT | URL e-shopu |
| `active` | BOOL | |
| `email_from_name`, `email_from_address`, `email_reply_to` | TEXT | Odesílatel zákaznických e-mailů (migrace 030) |
| `support_email`, `support_phone`, `support_phone_link` | TEXT | Kontakty v patičce |
| `tagline`, `claim`, `logo_mark_url`, `logo_wordmark_url` | TEXT | Vzhled e-mailů |
| `color_primary`, `color_primary_dark`, `color_primary_light`, `color_on_primary_soft` | TEXT | Barvy značky |
| `warehouse_email` | TEXT | Adresa skladu pro ranní expedici; prázdné = vypnuto (migrace 037) |
| `warehouse_email_bcc` | TEXT | Skrytá kopie expedice; prázdné = bez kopie (migrace 038) |
| `warehouse_dispatch_since` | DATE | Objednávky přijaté dřív se do skladu neposílají |
| `webhook_secret` | TEXT | `x-webhook-secret` pro volání e-shopu (podání balíku); prázdné = balík se nepodá. Toneráček ho nepoužívá, jede na `SHOP_WEBHOOK_SECRET` z prostředí (migrace 040) |
| `marketing_margin_pct` | NUMERIC(5,2) | Odhad marže v % z ceny bez DPH pro položky bez `cost_price`; `0` = bez odhadu (migrace 042) |
| `marketing_pno_alert_pct` | NUMERIC(5,2) | Práh PNO v % pro upozornění; `0` = bez upozornění (migrace 042) |

### `eshop_api_keys`
Klíče pro `/api/eshop/*` (migrace 040). Klíč určuje e-shop; ukládá se jen
otisk. Jediné místo, odkud se klíče vydávají (detail e-shopu → *Napojení
e-shopu*).

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `shop_id` | INT → shops (CASCADE) | |
| `key_hash` | TEXT UNIQUE | SHA-256 klíče v hexu (CHECK na 64 hex znaků) |
| `label` | TEXT | Popis („produkce (Coolify)“) |
| `active` | BOOL | Zrušený klíč přestane platit hned |
| `created_by` | INT → users | Kdo klíč vydal |
| `created_at`, `last_used_at`, `revoked_at` | TIMESTAMPTZ | `last_used_at` se zapisuje nejvýš jednou za 5 minut |

### `api_keys`
**Nepoužívá se** (od 26. 10. 2026). Klíče pro starší `/api/v1` (hlavička
`X-API-Key`); API i jeho správa jsou pryč, kód tabulku nečte. Zůstala, aby
se nic nemazalo — dá se zrušit samostatnou migrací.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `key` | TEXT UNIQUE | 64 hex znaků |
| `shop_id` | INT → shops | |
| `active` | BOOL | |
| `created_at` | TIMESTAMPTZ | |

### `shop_orders`
Objednávky z e-shopů.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | TEXT PK | Vlastní ID (timestamp36 + random) |
| `shop_id` | INT → shops | |
| `order_number` | TEXT | Číslo objednávky v rámci e-shopu |
| `status` | TEXT | Přijata / Ve zpracování / Vyřízena / Stornována |
| `payment_method` | TEXT | |
| `shipping_method` | TEXT | |
| `currency` | TEXT | Výchozí CZK |
| `first_name`, `last_name` | TEXT | Fakturační adresa |
| `company`, `ic`, `dic` | TEXT | |
| `email`, `phone` | TEXT | |
| `address`, `city`, `zip`, `country` | TEXT | |
| `shipping_*` | TEXT | Doručovací adresa |
| `pickup_point_id`, `pickup_point_name` | TEXT | Zásilkovna apod. |
| `total_price` | NUMERIC | |
| `invoice_number` | TEXT | Číslo vydané faktury; zapisuje ho `generateInvoiceForOrder()`, do vystavení prázdné. Objednávky z doby před migrací 039 v něm nesou vymyšlené `FV-<rok>-<objednávka>`, ke kterému doklad neexistuje — e-shopu proto API posílá číslo z `accounting_invoices`, ne tenhle sloupec |
| `paid_at` | TIMESTAMPTZ | Kdy e-shop poprvé ohlásil zaplacení kartou (stav „Zaplaceno“ při založení, v payment-status nebo payment-method); další potvrzení ho nepřepíší. Z něj je den přijetí úplaty karty (DUZP) na faktuře a od něj běží hlídaná lhůta 15 dnů. NULL = převod, dobírka, starší objednávky (migrace 039); zaplacená karta bez něj bere pražský den `created_at` — dopočítá se, nedopisuje (`denPlatbyKartou()`) |
| `tracking_number`, `label_url` | TEXT | Sledování zásilky |
| `ip_address`, `notes` | TEXT | |
| `crm_contact_id` | TEXT → crm_contacts | Automaticky linkovaný kontakt |
| `crm_company_id` | TEXT → crm_companies | |
| `warehouse_sent_at` | TIMESTAMPTZ | Kdy objednávka odešla skladu; NULL = ještě ne (migrace 037) |
| `warehouse_dispatch_id` | INT → warehouse_dispatches | Který běh ji poslal; NULL u ručního označení |
| `warehouse_sent_by` | INT → users | Kdo ji označil ručně |
| `warehouse_hold_reason` | TEXT | Proč do skladu nešla (bez výdejního místa, balík nepodán, štítek nestažen) |
| `utm_source_first`, `utm_medium_first`, `utm_campaign_first`, `utm_term_first`, `utm_content_first` | TEXT | První dotyk zákazníka (UTM; `source`/`medium` malými písmeny). `''` = neznámý nebo objednávka před migrací 042 |
| `click_id_kind_first`, `click_id_first` | TEXT | Druh (`gclid`, `gbraid`, `wbraid`, `fbclid`, `sznclid`, `sznaiid`, `hgtid`, `aku`) a hodnota click-id prvního dotyku; jen s marketingovým souhlasem, hodnota se po 90 dnech maže |
| `referrer_host_first`, `landing_page_first` | TEXT | Hostitel odkazujícího webu bez `www.` a cesta vstupní stránky bez query stringu |
| `touch_first_at` | TIMESTAMPTZ | Kdy první dotyk nastal; nepoužitelný čas z e-shopu (bez pásma, nečitelný, mimo ±1 rok) nahradí čas přijetí objednávky. NULL = e-shop první dotyk neposlal |
| `*_last`, `touch_last_at` | | Totéž pro poslední dotyk před objednávkou — z něj se počítá kanál objednávky. `touch_last_at IS NULL` = e-shop atribuci neposlal → kanál „neznámý“ (dotyk, který něco nese, má čas vždy — viz `touch_first_at`) |
| `attribution_consent` | TEXT | Kategorie souhlasu z lišty e-shopu: `none` / `analytics` / `marketing` / `all`; `''` = před nasazením (CHECK) |
| `created_at`, `modified_at` | TIMESTAMPTZ | |

### `shop_order_items`
Položky objednávek.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `order_id` | TEXT → shop_orders | |
| `sku` | TEXT | |
| `name` | TEXT | Název produktu |
| `quantity` | INT | |
| `price` | NUMERIC | Cena za kus |
| `product_id` | TEXT | ID produktu v e-shopu |
| `supplier_code` | TEXT | Kód dodavatele pro sklad (Airtable „ID Dodavatele"). **Není to `sku`** — to je interní kód Toneráčku. Prázdné = neznámý |
| `cost_price` | NUMERIC(10,2) | Nákupní cena za kus v okamžiku objednávky, na haléře (ne celé koruny jako `price`). NULL = e-shop ji neposlal (pseudo-položky, starší e-shop). **E-shopu se nikdy nevrací** — API vybírá sloupce položek výslovně (migrace 042) |
| `cost_price_vat_included` | BOOLEAN | `TRUE` = `cost_price` s DPH, `FALSE` = bez DPH (Toneráček), NULL = neznámo |

### `warehouse_dispatches`
Jeden běh ranní expedice do skladu. Zároveň zámek — řádek vzniká před prací.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `shop_id` | INT → shops | |
| `kind` | TEXT | `auto` / `rucni` |
| `run_date` | DATE | Pražské datum běhu |
| `status` | TEXT | `probiha` / `odeslano` / `prazdno` / `chyba` |
| `attempt` | INT | Kolikátý pokus (backoff 10, 20, 30… minut, max 6) |
| `started_at`, `finished_at` | TIMESTAMPTZ | |
| `email_sent_at` | TIMESTAMPTZ | Kdy Resend zprávu přijal — bod, za kterým se běh už neposílá znovu |
| `recipient`, `subject`, `resend_id` | TEXT | Co a komu odešlo |
| `order_count`, `held_count` | INT | Odeslané a zadržené objednávky |
| `error` | TEXT | |
| `started_by` | INT → users | U ručního spuštění |

Dva částečné unikátní indexy: `(shop_id, run_date) WHERE kind='auto'` (jeden
automatický běh na den) a `(shop_id) WHERE status='probiha'` (nejvýš jeden
rozběhnutý běh, i kdyby klikli dva operátoři naráz).

---

## Marketing

Data pro sekci Marketing (migrace 042): napojení e-shopů na reklamní
platformy, běhy nočního stahování, denní statistiky a ručně zadané náklady.
Všechno **per e-shop** (`shop_id`), nic se mezi e-shopy nemíchá. Tržby,
marže a kanál objednávky se počítají ze `shop_orders` / `shop_order_items`
(atribuce a `cost_price` výš), tabulky tady nesou jen to, co přijde
z platforem nebo z ručního zadání.

### `marketing_sources`
Napojení e-shopu na platformu, jeden řádek na `(shop_id, platform)`
(UNIQUE). Google (`ga4`, `google_ads`, `search_console`, `merchant`) jede
přes firemní service account z `GOOGLE_SERVICE_ACCOUNT_JSON`, tady je jen
ID; Sklik, Heureka a Meta mají tajemství šifrované v databázi.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `shop_id` | INT → shops (CASCADE) | |
| `platform` | TEXT | `ga4` / `google_ads` / `search_console` / `merchant` / `sklik` / `heureka` / `meta` / `eshop` (CHECK). Zboží.cz vlastní zdroj nemá — jeho statistiky jsou od října 2026 jen ve Skliku, zapisuje je adaptér `sklik` |
| `active` | BOOL | Vypnutý zdroj sync přeskočí |
| `external_id` | TEXT | ID na straně platformy (property GA4, zákaznické číslo Ads, web v Search Console, účet Merchant, účet Sklik, `act_…` Meta); u `eshop` prázdné (bere se `shops.url`) |
| `parent_external_id` | TEXT | Nadřazené ID: `premiseId` provozovny pro Seznam Nákupy, MCC u Google Ads |
| `secret_enc` | TEXT | Token / API klíč platformy šifrovaný AES-256-GCM klíčem `MARKETING_SECRETS_KEY`; prázdné u Googlu |
| `secret_fingerprint`, `secret_set_at` | TEXT, TIMESTAMPTZ | Otisk tajemství pro nastavení (prvních 8 znaků SHA-256) a kdy bylo uloženo |
| `since` | DATE | Od kdy stahovat při prvním běhu (strop 400 dní); NULL = jen okno 14 dnů |
| `last_run_at`, `last_ok_at`, `last_error` | TIMESTAMPTZ, TIMESTAMPTZ, TEXT | Poslední pokus, poslední úspěch, text poslední chyby |
| `created_at`, `modified_at` | TIMESTAMPTZ | |

### `marketing_sync_runs`
Jeden běh stažení statistik ze zdroje. Zároveň zámek (vzor
`warehouse_dispatches`): řádek vzniká před prací, opakování po chybě je
`attempt + 1` na témže řádku.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `source_id` | INT → marketing_sources (CASCADE) | |
| `shop_id`, `platform` | INT → shops, TEXT | Zkopírované ze zdroje kvůli výpisům bez JOINu |
| `kind` | TEXT | `auto` (noční scheduler) / `rucni` |
| `run_date` | DATE | Pražské datum běhu |
| `status` | TEXT | `probiha` / `hotovo` / `chyba`; `probiha` déle než 30 minut = přerušený běh |
| `attempt` | INT | Kolikátý pokus (backoff 10, 20, 30 minut, nejvýš 6) |
| `permanent` | BOOL | Chyba, kterou opakování nespraví (401, 403, špatné ID) — čeká na obsluhu |
| `from_date`, `to_date` | DATE | Stahované okno (zpravidla posledních 14 dnů do včerejška) |
| `rows_saved` | INT | Zapsané řádky `marketing_daily_stats` |
| `error` | TEXT | Text chyby posledního pokusu (do 500 znaků) |
| `started_by` | INT → users | U ručního spuštění |
| `started_at`, `finished_at` | TIMESTAMPTZ | |

Dva částečné unikátní indexy: `(source_id, run_date) WHERE kind = 'auto'`
(jeden automatický běh na zdroj a den) a `(source_id) WHERE status =
'probiha'` (nejvýš jeden rozběhnutý běh na zdroj).

### `marketing_daily_stats`
Denní statistiky platforem; jeden řádek na `(shop_id, platform, date,
segment_kind, segment)` (UNIQUE). **`segment_kind = ''` je denní součet
platformy a jen ten vstupuje do KPI** (PNO, ROAS); rozpady jsou doplňkové
a sčítat je s celkem by náklady zdvojilo. Typované metriky, ne JSONB —
každá platforma vyplní svou část, zbytek nechá `0`. Sync přepisuje okno
14 dnů (`DELETE` okna + `INSERT` v jedné transakci).

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `shop_id` | INT → shops (CASCADE) | |
| `platform` | TEXT | `ga4` / `google_ads` / `search_console` / `merchant` / `sklik` / `zbozi` / `heureka` / `meta` / `eshop` (CHECK) |
| `date` | DATE | Den v pásmu účtu platformy, u e-shopu a objednávek pražský |
| `segment_kind` | TEXT | `''` / `campaign` / `channel` / `query` / `page` / `country` / `product` (CHECK) |
| `segment` | TEXT | Hodnota segmentu (název kampaně, kanál, dotaz, cesta, země, SKU); u součtu prázdné |
| `cost`, `cost_with_vat` | NUMERIC(12,2) | Náklady v CZK **bez DPH**; s DPH jen tam, kde je platforma posílá (Heureka) |
| `impressions`, `clicks` | INT | Zobrazení (Heureka je neposílá) a kliknutí |
| `conversions`, `conversion_value` | NUMERIC(12,2) | Konverze a jejich hodnota podle platformy — jen pro porovnání, zdroj pravdy jsou objednávky |
| `sessions`, `total_users`, `view_item`, `add_to_cart`, `begin_checkout`, `purchase`, `purchase_revenue` | INT / NUMERIC | GA4: relace, uživatelé a trychtýř; nákupy jen pro porovnání (bez souhlasu je GA4 nevidí) |
| `position_sum` | NUMERIC(14,2) | Search Console: Σ pozice × zobrazení; průměrná pozice = `position_sum / impressions` |
| `approved_items`, `disapproved_items` | INT | Merchant Center: schválené a zamítnuté položky feedu ke dni |
| `searches`, `searches_no_result` | INT | E-shop: hledání a hledání bez výsledku za den (z `GET /api/marketing/statistika`) |
| `carts_abandoned`, `carts_value` | INT, NUMERIC(12,2) | E-shop: opuštěné košíky za den a jejich hodnota v CZK s DPH |
| `run_id` | INT → marketing_sync_runs (SET NULL) | Běh, který řádek zapsal |
| `created_at` | TIMESTAMPTZ | Čas posledního přepisu |

Index `(shop_id, date)` pro součty za období.

### `marketing_manual_costs`
Ručně zadané náklady za období (před napojením API, při výpadku). Do KPI
se rozpočítají rovnoměrně po dnech; když pro tutéž platformu a den existují
i řádky z API, přehled varuje. Heureka tu je jen jako záloha — má API
s náklady (napojuje se až ve 4. kroku nasazení), ručně se zadává jen do
jeho napojení nebo při výpadku a při překryvu s API platí totéž varování.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `shop_id` | INT → shops (CASCADE) | |
| `platform` | TEXT | `google_ads` / `sklik` / `zbozi` / `heureka` / `meta` / `ostatni` (CHECK) |
| `date_from`, `date_to` | DATE | Období včetně obou dnů; CHECK `date_to >= date_from` |
| `amount` | NUMERIC(12,2) | Částka za celé období v CZK bez DPH; CHECK `>= 0` |
| `note` | TEXT | |
| `invoice_id` | TEXT → accounting_invoices (SET NULL) | Přijatá faktura, ze které náklad je (`accounting_invoices.id` je TEXT) |
| `receipt_id` | INT → receipts (SET NULL) | Účtenka |
| `created_by` | INT → users | |
| `created_at` | TIMESTAMPTZ | |

---

## CRM

### `crm_companies`
Firmy (zákazníci, dodavatelé, …).

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | TEXT PK | `generateId()` |
| `name` | TEXT | |
| `company_type` | TEXT | Zákazník / Dodavatel / Partner / Jiný |
| `ico`, `dic` | TEXT | |
| `address`, `city`, `zip`, `country` | TEXT | |
| `phone`, `email`, `website` | TEXT | |
| `notes` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

### `crm_contacts`
Fyzické osoby.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | TEXT PK | `generateId()` |
| `first_name`, `last_name` | TEXT | |
| `email` | TEXT | UNIQUE |
| `phone` | TEXT | |
| `company_id` | TEXT → crm_companies | Volitelné |
| `address`, `city`, `zip`, `country` | TEXT | |
| `notes` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

### `crm_contact_shops`
Zákaznický účet kontaktu v jednom e-shopu napojeném přes `/api/eshop`
(od migrace 040; účty Toneráčku jsou v `crm_contacts`). Řádek vzniká i pro
hosta z objednávky (`is_registered = FALSE`). Primární klíč
`(contact_id, shop_id)`.

| Sloupec | Typ | Popis |
|---|---|---|
| `contact_id` | TEXT → crm_contacts (CASCADE) | |
| `shop_id` | INT → shops (CASCADE) | |
| `is_registered` | BOOL | Účet v tomhle e-shopu. Výchozí `TRUE` z migrace 001 — kód zapisuje vždy výslovně |
| `registered_at` | TIMESTAMPTZ | Registrace v e-shopu (u hosta první objednávka) |
| `marketing_consent`, `notifications_consent` | BOOL | Souhlasy pro tenhle e-shop |
| `gdpr_consent_at` | TIMESTAMPTZ | Kdy dal souhlas se zpracováním údajů tomuhle e-shopu |
| `last_login` | TIMESTAMPTZ | |
| `password_backup` | TEXT | Záložní hash hesla z e-shopu (`PWDHASH:…`), ven jen přes `?withNote=1` |
| `active` | BOOL | |
| `first_name`, `last_name`, `phone`, `company_name`, `address`, `city`, `zip` | TEXT | Profil v e-shopu; `NULL` = převzít z `crm_contacts` |
| `external_id` | TEXT | Nepoužívá se |
| `modified_at` | TIMESTAMPTZ | |

---

## Účetnictví

### `accounting_invoices`
Vydané i přijaté faktury.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | TEXT PK | `generateId()` |
| `type` | TEXT | `issued` / `received` / `proforma` (zálohová faktura, migrace 015) |
| `number` | TEXT | Číslo faktury |
| `status` | TEXT | Nezaplacena / Zaplacena / Po splatnosti / Storno (`STATUSES_ISSUED`) |
| `issue_date`, `due_date` | DATE | |
| `paid_date` | DATE | Den úhrady — den pohybu na účtu (párování s bankou) nebo den zadaný při ruční změně stavu, ne den kliknutí. U faktury k objednávce den přijetí úplaty (karta, převod), u dobírky NULL do spárování |
| `taxable_date` | DATE | DUZP vydané faktury: u karty a převodu den přijetí úplaty, u dobírky den vystavení. NULL = shodné s `issue_date` (starší a ruční doklady). Tiskne ho PDF, je v CSV exportu a jde do POHODY jako `dateTax`; opravuje se v úpravě faktury (migrace 039) |
| `client_name`, `client_ico`, `client_dic` | TEXT | Odběratel (vydané a zálohové faktury) |
| `supplier` | TEXT | Dodavatel (přijaté faktury) |
| `supplier_ico` | TEXT | IČO dodavatele (přijaté faktury) |
| `amount`, `vat_amount`, `total_amount` | NUMERIC | Základ, DPH, celkem |
| `vat_rate` | NUMERIC | Sazba DPH |
| `payment_method` | TEXT | |
| `series_id` | INT → invoice_number_series | |
| `shop_order_id` | TEXT → shop_orders | Propojení s objednávkou |
| `account_debit`, `account_credit` | TEXT | Předkontace (MD/D) |
| `vat_deductible` | BOOL | Nárok na odpočet DPH (§ 72 odst. 4 ZDPH u reprezentace `FALSE`) |
| `pohoda_exported_at` | TIMESTAMPTZ | Poslední export do POHODY (ochrana před duplicitou) |
| `pdf_path` | TEXT | Cesta k vygenerovanému PDF |
| `attachment_path` | TEXT | Doklad přijaté faktury v `data/media/` (viz `src/attachments.js`) |
| `attachment_mime` | TEXT | `image/jpeg`, `application/pdf`, … |
| `attachment_size` | INT | Velikost v bajtech po zmenšení |
| `notes` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

### `accounting_invoice_items`
Položky faktur.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `invoice_id` | INT → accounting_invoices | |
| `description` | TEXT | |
| `quantity` | NUMERIC | |
| `unit_price` | NUMERIC | |
| `vat_rate` | NUMERIC | |
| `total` | NUMERIC | |

### `invoice_number_series`
Číselné řady.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | TEXT | Zobrazovaný název |
| `prefix` | TEXT | Např. `FV` |
| `year` | INT | Volitelně; zařazuje rok do čísla |
| `current_number` | INT | Aktuální čítač |
| `start_number` | INT | Počáteční hodnota |
| `padding` | INT | Počet číslic (vedoucí nuly) |
| `shop_id` | INT → shops | Volitelné přiřazení e-shopu |
| `active` | BOOL | |

### `recurring_invoices`
Šablony opakujících se faktur.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | TEXT | Interní název šablony |
| `active` | BOOL | |
| `frequency` | TEXT | `monthly` / `quarterly` / `yearly` |
| `next_run_date` | DATE | Kdy se má příště vygenerovat |
| `last_run_date` | DATE | |
| `series_id` | INT → invoice_number_series | |
| `customer_*` | TEXT | Fakturační data |
| `items_json` | JSONB | Pole položek faktury |
| `send_email` | BOOL | Automaticky odeslat e-mailem |

---

## Banka

### `accounting_bank_accounts`
Bankovní účty.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | TEXT | |
| `bank_name` | TEXT | |
| `account_number` | TEXT | |
| `currency` | TEXT | |

### `accounting_bank_imports`
Historie CSV importů.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `account_id` | INT → accounting_bank_accounts | |
| `filename` | TEXT | |
| `imported_at` | TIMESTAMPTZ | |
| `rows_imported`, `rows_skipped`, `rows_matched` | INT | Statistiky |

### `accounting_bank_transactions`
Bankovní pohyby.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `account_id` | INT → accounting_bank_accounts | |
| `date` | DATE | |
| `amount` | NUMERIC | Kladné = příjem, záporné = výdaj |
| `currency` | TEXT | |
| `counterparty_name`, `counterparty_account` | TEXT | |
| `variable_symbol`, `specific_symbol`, `constant_symbol` | TEXT | |
| `note`, `bank_reference` | TEXT | |
| `matched_invoice_id` | INT → accounting_invoices | Spárovaná faktura |
| `matched_receipt_id` | INT → receipts | Spárovaná účtenka |
| `import_id` | INT → accounting_bank_imports | |

---

## Účtenky

### `receipts`

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `status` | TEXT | Nezaúčtována / Zaúčtována / Storno |
| `receipt_date` | DATE | |
| `vendor` | TEXT | Název prodejce |
| `amount`, `vat_amount` | NUMERIC | |
| `vat_rate` | NUMERIC | |
| `category` | TEXT | Kancelář, IT & Software, … |
| `description` | TEXT | |
| `account_debit`, `account_credit` | TEXT | Předkontace |
| `payment_method` | TEXT | Hotovost / Karta / Převodem — určuje agendu v POHODĚ |
| `vat_deductible` | BOOL | Nárok na odpočet DPH; u reprezentace vždy `FALSE` |
| `pohoda_exported_at` | TIMESTAMPTZ | Poslední export do POHODY (ochrana před duplicitou) |
| `attachment_path` | TEXT | Foto / PDF dokladu v `data/media/` (viz `src/attachments.js`) |
| `attachment_mime` | TEXT | `image/jpeg`, `application/pdf`, … |
| `attachment_size` | INT | Velikost v bajtech po zmenšení |
| `ai_raw` | JSONB | Surová odpověď z Claude API |
| `bank_tx_id` | INT → accounting_bank_transactions | Spárovaná transakce |
| `created_at` | TIMESTAMPTZ | |

---

## Monitoring

### `healthchecks`
Definice HTTP kontrol.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | TEXT | |
| `url` | TEXT | URL pro ping |
| `interval_minutes` | INT | |
| `active` | BOOL | |
| `expected_status` | INT | Očekávaný HTTP status (výchozí 200) |

### `healthcheck_results`
Výsledky jednotlivých pingů.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `healthcheck_id` | INT → healthchecks | |
| `checked_at` | TIMESTAMPTZ | |
| `status_code` | INT | |
| `response_ms` | INT | Doba odpovědi |
| `success` | BOOL | |
| `error` | TEXT | Chybová zpráva |

### `notification_channels`
Kanály pro notifikace.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `type` | TEXT | `discord` / `email` |
| `name` | TEXT | |
| `config` | JSONB | `{webhook_url}` nebo `{to}` |
| `active` | BOOL | |

### `notification_rules`
Pravidla kdy notifikovat.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `event_type` | TEXT | Typ události |
| `channel_id` | INT → notification_channels | |
| `threshold` | JSONB | Podmínky spuštění |
| `active` | BOOL | |

### `notification_log`
Log odeslaných notifikací (deduplikace — zabraňuje opakovanému spamu).

---

## Nastavení firmy

### `company_settings`
Jeden řádek — údaje fakturující firmy.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | TEXT | Název firmy |
| `ico`, `dic` | TEXT | |
| `address`, `city`, `zip`, `country` | TEXT | |
| `phone`, `email` | TEXT | |
| `bank_account`, `bank_name`, `iban`, `swift` | TEXT | |
| `vat_payer` | BOOL | Plátce DPH |
| `invoice_note` | TEXT | Patička na fakturách |
| `pohoda_cash_account` | TEXT | Název pokladny v POHODĚ (účtenky placené hotově) |
| `pohoda_predkontace` | TEXT | Předkontace účtenek v pokladně |
| `pohoda_predkontace_prijate` | TEXT | Předkontace přijatých faktur a ostatních závazků |
| `pohoda_predkontace_repre` | TEXT | Předkontace dokladů bez nároku na odpočet DPH |
| `gdrive_root_folder_id` | TEXT | Kořenová složka pro import přijatých faktur |
| `logo_path` | TEXT | Logo v `data/media/` |
| `updated_at` | TIMESTAMPTZ | |

### `accounting_chart`
Číselník účtů pro předkontaci.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `code` | TEXT UNIQUE | Číslo účtu (např. `321000`) |
| `name` | TEXT | Název účtu |
| `active` | BOOL | |

---

## Push notifikace

### `push_subscriptions`
Web Push registrace zařízení.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `user_id` | INT → users | |
| `endpoint` | TEXT | Push service URL |
| `p256dh` | TEXT | Šifrovací klíč |
| `auth` | TEXT | Auth secret |
| `created_at` | TIMESTAMPTZ | |

Unique constraint: `(user_id, endpoint)` — každé zařízení jednoho uživatele má vlastní subscription.
