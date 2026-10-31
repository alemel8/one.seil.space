# Další e-shop v One SEIL (Dílna Vlněnka)

Jak napojit e-shop, který funguje stejně jako Toneráček — objednávky,
zálohovky, faktury, zákaznické účty, expedice — a jak tu změnu nasadit na
živý One SEIL, na kterém Toneráček synchronně závisí.

Prodává stejná firma (SEIL s.r.o.): jeden vystavovatel v Nastavení firmy,
jeden bankovní účet, jedna Packeta (Dílna je druhý odesílatel). Co je po
e-shopech: číselné řady, identita e-mailů, klíč do API, tajemství pro podání
balíku, zákaznické účty, adresa skladu.

---

## Jak to funguje

| | Toneráček | Další e-shop (Dílna) |
|---|---|---|
| API | `/api/toneracek/*` | `/api/eshop/*` — stejných 11 endpointů, těla i odpovědi |
| Klíč | `TONERACEK_API_KEY` v prostředí One SEIL | řádek v `eshop_api_keys` (jen SHA-256 otisk), určuje e-shop |
| Zákaznické účty | `crm_contacts` (`is_registered`, `notes` = záložní hash hesla) | `crm_contact_shops` — po e-shopech |
| Tajemství pro `podat-balik` | globální `SHOP_WEBHOOK_SECRET`, jen z prostředí (v administraci se nenastavuje) | jen vlastní `shops.webhook_secret`; bez něj se balík nepodá — globální patří Toneráčku a jinam se neposílá |
| Seznam objednávek | `/ucetnictvi/objednavky` | `/ucetnictvi/objednavky?eshop=<slug>` |

Kontakt v CRM je jeden na e-mail pro všechny e-shopy. Zákazník Toneráčku se
na Dílně registruje zvlášť, vlastním heslem; heslo z Dílny Toneráček neotevře
a souhlasy dané Dílně neplatí pro Toneráček. Profil (jméno, telefon, firma,
adresa) z registrace a úprav na Dílně jde jen do účtu Dílny — co zákazník
upraví na Dílně, vidí jen na Dílně. Kontakt, který je účtem Toneráčku, Dílna
nemění vůbec (ani prázdné pole: pokladna Toneráčku z něj předvyplňuje firmu
a adresu). Hostovi nebo obchodnímu partnerovi doplní prázdné jméno a telefon
jen objednávka z Dílny.

Detail objednávky, štítek, změna stavu, značka „sklad to má“ i poznámka
berou e-shop z objednávky samé, takže každý odkaz `/ucetnictvi/objednavky/:id`
(push, faktura, CRM) funguje pro oba.

---

## Přidání e-shopu (krok za krokem)

Všechno v administraci One SEIL, jako správce. Pořadí je důležité: dokud
e-shop nemá vyplněnou identitu, API objednávky odmítá (`503`).

1. **Řádek e-shopu** — Nastavení → Eshopy → **+ Nový eshop**: název
   `Dílna Vlněnka`, slug `dilnavlnenka` (nejde změnit), URL
   `https://dilnavlnenka.cz` (bez lomítka na konci; One SEIL na ni volá
   `/api/orders/podat-balik` a e-maily odkazují na `/api/qr` a `/produkty`).

2. **Identita e-mailů** — detail e-shopu → záložka *Identita e-mailů*: odesílatel
   (`Dílna Vlněnka` / `noreply@dilnavlnenka.cz`), odpovědi na, kontaktní
   e-mail a telefon, podtitul, claim, URL log, čtyři barvy. Doména odesílatele
   musí být ověřená v **tomtéž** Resend účtu, který používá One SEIL. Náhled:
   tlačítko *Náhled e-mailu*.

3. **Číselné řady** — Nastavení → Číselné řady, tři řady s e-shopem
   `Dílna Vlněnka`. Formáty schvaluje účetní; pravidla:
   - **objednávka** (`objednavka`): jen číslice (e-shop čte číslo objednávky
     jako celé číslo a bankovní párování odstraňuje jen `-` a `/`), nesmí
     začínat čtyřmístným rokem (variabilní symbol by se mohl trefit do čísla
     cizí zálohovky `ZF-2026NNNN`) a nesmí se krýt s čísly Toneráčku
     (`YYMMXXXX`). Návrh: `YYMMXXXXX` (9 číslic) — od Toneráčku ho odliší
     hlavně pozdější start a 9. číslice, ne jen délka (Toneráček měl dřív
     i 9místná čísla).
   - **zálohová faktura** (`zalohova_faktura`) a **faktura** (`faktura`):
     vlastní prefix, např. `ZV-YYYYNNNN` a `V-YYYYNNNN`. Čísla dokladů jsou
     jedinečná v rámci typu napříč **všemi** e-shopy i fakturami SEILu
     (index z migrace 021) — shoda s jinou aktivní řadou znamená, že faktura
     nevznikne (chyba jen v logu) a objednávka zůstane bez faktury.
   - V doslovném textu formátu nesmí být `X`, `N`, `YY`, `MM`, `DD` — to jsou
     zástupné znaky (`src/series-format.js`).

   Bez řady objednávek by se čísla počítala „poslední + 1“ od `10001`.

4. **Klíč pro API** — detail e-shopu → záložka *Napojení e-shopu* → popis
   (např. `produkce (Coolify)`) → **Vygenerovat klíč**. Klíč se ukáže
   **jednou**; vložte ho do prostředí e-shopu jako `SEIL_API_KEY`. One SEIL
   si drží jen otisk (prvních 8 znaků SHA-256 je vidět v seznamu). Ztracený
   klíč nejde znovu ukázat — vydejte nový a starý zrušte. Zrušení platí
   okamžitě.

5. **Tajemství pro podání balíku** — tamtéž, **Vygenerovat nové**. Ukáže se
   jednou; do prostředí e-shopu jako `WEBHOOK_SECRET`. Kontrola shody bez
   ukazování hodnoty: `printf %s "$WEBHOOK_SECRET" | shasum -a 256 | cut -c1-8`
   na straně e-shopu = otisk v administraci. Bez tohohle kroku One SEIL
   balíky Dílny nepodá (detail e-shopu to hlásí červeně) — globální
   `SHOP_WEBHOOK_SECRET` je tajemství Toneráčku a Dílně se nikdy neposílá.
   Nevkládejte ho do `WEBHOOK_SECRET` Dílny, ani když e-shop podání odmítá.

6. **Healthcheck** — detail e-shopu → záložka *Healthchecky* → **+ Healthcheck**, URL
   `https://dilnavlnenka.cz/api/health`.

7. **Expedice do skladu** — adresu skladu nechte **prázdnou**, dokud není
   rozhodnuté, kdo Dílnu balí. Jakmile se vyplní, ranní automat (všední dny
   6:00) začne Dílnu posílat sám, vždy až po Toneráčku. Při zapnutí nastavte
   *Posílat objednávky přijaté od* na den spuštění.

### Marketing (volitelné)

Sekce Marketing počítá PNO a marži pro každý e-shop zvlášť. V detailu e-shopu
(záložka **Marketing**) se nastaví odhad hrubé marže v % z ceny bez DPH (pro
položky, u kterých e-shop neposlal nákupní cenu) a práh PNO pro upozornění,
a napojí se platformy: u Googlu stačí ID (GA4 property, zákazník Google Ads,
property Search Console, účet Merchant Center) a přidat e-mail firemního
service accountu jako čtenáře; Sklik, Heureka a Meta potřebují token, který se
uloží šifrovaný (`MARKETING_SECRETS_KEY` v prostředí). Platforma „E-shop“ čte
`{url}/api/marketing/statistika` s tajemstvím e-shopu — e-shop ji musí mít
(kopie z Toneráčku ji má). Bez napojení přehled ukazuje jen objednávky a ruční
náklady.

### Co potřebuje e-shop (kopie e-shopu Toneráčku)

| Proměnná | Hodnota |
|---|---|
| `SEIL_API_URL` | `https://one.seil.space` (bez lomítka na konci) |
| `SEIL_API_KEY` | klíč z kroku 4 |
| `WEBHOOK_SECRET` | tajemství z kroku 5 |

V kódu e-shopu se mění jen cesta: všech 12 volání `/api/toneracek/…` (11
endpointů, `by-number` se volá dvakrát) v `src/app/api/orders/route.ts`,
`src/app/api/orders/my/route.ts`, `src/app/api/orders/my/[orderNumber]/route.ts`,
`src/lib/seilOrders.ts` a `src/lib/auth.ts` → `/api/eshop/…`. Hlavička zůstává
`Authorization: Bearer <SEIL_API_KEY>`, těla i odpovědi jsou stejné. Hotové
objednávky e-shop dál podává u Packety sám (odesílatel `dilnavlnenka.cz`),
One SEIL štítky stahuje jedním `PACKETA_API_PASSWORD`.

### Globální nastavení, která platí pro všechny e-shopy

- `SHOP_SENDS_PAYMENT_EMAIL` — Dílna musí posílat platební údaje stejně jako
  Toneráček (e-shop v potvrzení objednávky), jinak zákazník dostane zálohovku
  dvakrát, nebo vůbec.
- `EMAIL_BCC` — skrytá kopie zákaznické pošty jde i z Dílny (osobní údaje).
- Vystavovatel, IBAN a export do POHODY jsou jedny (`company_settings`).
- Automatické párování plateb (`POST /api/webhook/banka`, jen s
  `BANK_WEBHOOK_SECRET`) hledá variabilní symbol ve všech e-shopech — proto
  pravidla formátů v kroku 3.

---

## Nasazení na živý One SEIL (servisní okno)

Push do `main` = automatický redeploy v Coolify a migrace nad živou databází
při startu. Toneráček na One SEIL čeká při každém přihlášení, objednávce
i platbě, proto v okně s nízkým provozem (večer) a s někým, kdo může
zkontrolovat Toneráček.

### Před oknem

1. Testy větve proti **lokální** databázi (nikdy `npm test` — načítá `.env`,
   které míří mimo tento stroj):
   ```bash
   # PostgreSQL 16 na 127.0.0.1 s prázdnou databází oneseil_test
   export DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/oneseil_test
   export TONERACEK_API_KEY=test-toneracek-key-0123456789abcdef
   mkdir -p data/media                                   # test příloh
   PORT=3999 HOST=127.0.0.1 node src/server.js &         # migrace + server
   # test faktur se přihlašuje jako „první aktivní uživatel“ — založte trvalého:
   psql "$DATABASE_URL" -c "INSERT INTO users (email, password_hash, is_admin) VALUES ('admin@example.invalid', 'x', TRUE)"
   TEST_BASE_URL=http://127.0.0.1:3999 node --test test/
   ```
   Server i testy bez `RESEND_API_KEY`, `PACKETA_API_PASSWORD`,
   `SHOP_WEBHOOK_SECRET` a `VAPID_*` — nic tak neodejde ven. Nové testy
   (`eshop-*`, `toneracek-kontrakt`, `smazat-testovaci-data`) jinou než
   lokální databázi odmítnou.
2. Přečíst `migrations/040_eshop_api_a_ucty_po_eshopech.sql`: jen
   `CREATE … IF NOT EXISTS` a `ADD COLUMN IF NOT EXISTS` s konstantní výchozí
   hodnotou (bez přepisu tabulek), jedna transakce, `lock_timeout` 2 s,
   tabulka `shops` (čte ji každý požadavek Toneráčku) se zamyká až posledním
   příkazem. Totéž platí pro každou další migraci nasazovanou tímhle
   postupem: `042_marketing.sql` přidává nové tabulky `marketing_*` a sloupce
   do `shop_order_items` (nákupní cena), `shop_orders` (21 sloupců atribuce)
   a nakonec `shops` (marže, práh PNO).
3. Domluvit, kdo hlídá Toneráček, a mít po ruce přístup do Coolify a na VPS
   (`psql` do produkční databáze pro kontroly v okně).
4. V Coolify ověřit, že nový kontejner nahradí starý až po úspěšném
   healthchecku (Dockerfile ho má). Jinak by migrace, která nedoběhne,
   znamenala výpadek backendu Toneráčku, dokud se nevyřeší.

### V okně

1. **Záloha databáze** (na VPS, mimo kontejner aplikace):
   ```bash
   pg_dump -Fc -h <db-host> -U seil -d seil -f /root/zalohy/seil-$(date +%Y%m%d-%H%M)-pred-040.dump
   pg_restore --list /root/zalohy/seil-…-pred-040.dump | head   # dump je čitelný
   ```
   Zálohu zkopírovat i mimo VPS.
2. **Kontroly těsně před pushem** (`psql` do produkční databáze, jen čtení):
   ```sql
   -- a) Poslední aplikovaná migrace musí být ta, nad kterou se větev testovala
   --    (poslední v migrations/ na main před mergem; při nasazení 042 je to 041)
   --    — jinak se nasazuje na jiný stav, než se testoval.
   SELECT max(filename) FROM schema_migrations;          -- 041_dilna_cislo_faktury_a_identita.sql

   -- b) crm_contact_shops musí být prázdná. Výchozí is_registered je TRUE,
   --    takže cizí řádky by /api/eshop bral jako hotové účty.
   SELECT COUNT(*) FROM crm_contact_shops;               -- 0

   -- c) Aktivní e-shopy a jejich objednávky. Čekáme jediný aktivní toneracek.
   --    Každý další aktivní e-shop se hned po nasazení objeví v přepínači
   --    seznamu objednávek a jeho objednávky půjdou otevřít, vyřídit,
   --    stornovat i označit (detail, stav, sklad a štítek už nefiltrují
   --    Toneráček); s vyplněnou adresou skladu ho bere i ranní expedice.
   SELECT s.id, s.slug, s.active, s.warehouse_email <> '' AS expedice, COUNT(o.id) AS objednavek
   FROM shops s LEFT JOIN shop_orders o ON o.shop_id = s.id
   GROUP BY s.id ORDER BY s.id;

   -- d) Žádná dlouhá transakce. ALTER na shops by za ní čekal a s ním každý
   --    dotaz Toneráčku (nejvýš 2 s na pokus, při restartech opakovaně).
   SELECT pid, usename, application_name, state, now() - xact_start AS trva, left(query, 80) AS dotaz
   FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid()
     AND xact_start < now() - interval '30 seconds';     -- nic
   ```
   Záloha z kroku 1 musí být dokončená a v okně nesmí běžet žádný plánovaný
   `pg_dump` (cron na VPS, zálohy Coolify) — drží zámek na všech tabulkách.
   Vrátí-li d) zapomenutou session `idle in transaction` (ne aplikaci),
   ukončete ji `SELECT pg_terminate_backend(<pid>);`, jinak počkejte.
   Neodpovídá-li a)–c), nenasazujte a nejdřív zjistěte proč.
3. **Merge a push**: `git checkout main && git merge --ff-only eshop-dilnavlnenka && git push origin main`
   (nebo merge přes PR).
4. **Logy deploye v Coolify** — čekat na:
   ```
   [migrate] Spouštím 040_eshop_api_a_ucty_po_eshopech.sql
   [migrate] ✓ 040_eshop_api_a_ucty_po_eshopech.sql
   one.seil.space běží na http://0.0.0.0:3000
   ```
   Spadne-li migrace (`canceling statement due to lock timeout`), nic se
   nezapsalo (migrace běží v jedné transakci) a kontejner se po restartu
   pokusí znovu. Každý pokus může požadavky Toneráčku pozdržet až o 2 s.
   Opakuje-li se to, najděte blokující session (kontrola d) z kroku 2, nebo
   `SELECT pid, pg_blocking_pids(pid), left(query, 80) FROM pg_stat_activity
   WHERE wait_event_type = 'Lock';`) a ukončete ji, případně viz *Návrat*.
5. **Kouřový test Toneráčku** (hned po startu):
   - `https://one.seil.space/health` → `{"ok":true}`;
   - přihlášení existujícím účtem na toneracek.cz (čte
     `/api/toneracek/users?withNote=1` a zapisuje poslední přihlášení);
   - *Moje objednávky* v účtu se načtou;
   - administrace: `/ucetnictvi/objednavky` vypadá jako dřív (nadpis
     „Objednávky Toneráček“, přepínač e-shopů se objeví až s druhým aktivním
     e-shopem), detail objednávky, štítek PDF;
   - platební údaje k existující nezaplacené objednávce převodem (děkovná
     stránka nebo `curl -H "Authorization: Bearer $TONERACEK_API_KEY"
     https://one.seil.space/api/toneracek/orders/<id>/payment-details`) → 200;
   - v logu žádné 500 u `/api/toneracek`.
   Testovací objednávku na produkci jen po dohodě — spotřebuje čísla v řadách
   a vystaví skutečný doklad SEIL s.r.o.
6. **Konfigurace Dílny** — kroky 1–6 výš. Dokud e-shop Dílny neběží, nic
   dalšího se neděje (bez klíče se k API nikdo nedostane, bez adresy skladu
   ho ranní expedice přeskakuje).
7. Po prvních objednávkách Dílny: objednávka v `/ucetnictvi/objednavky?eshop=dilnavlnenka`,
   zálohovka s prefixem Dílny, platební údaje v potvrzení, po zaplacení
   Vyřízena → faktura z řady Dílny a e-mail od `noreply@dilnavlnenka.cz`.

### Návrat

- **Kód**: redeploy předchozího commitu `main` v Coolify (nebo
  `git revert` merge a push). Migrace 040 je jen přidávající a kód z původního
  `main` nad ní běží — celá jeho sada testů (190/190) prošla nad databází
  s migrací 040. Databázi kvůli návratu kódu vracet netřeba; nové tabulky
  a sloupce starý kód ignoruje.
- **Databáze** jen v krajním případě a vědomě (smaže klíče, tajemství
  a účty dalších e-shopů):
  ```sql
  BEGIN;
  DROP TABLE IF EXISTS eshop_api_keys;
  ALTER TABLE shops DROP COLUMN IF EXISTS webhook_secret;
  ALTER TABLE crm_contact_shops
    DROP COLUMN IF EXISTS password_backup, DROP COLUMN IF EXISTS gdpr_consent_at,
    DROP COLUMN IF EXISTS active, DROP COLUMN IF EXISTS modified_at,
    DROP COLUMN IF EXISTS first_name, DROP COLUMN IF EXISTS last_name,
    DROP COLUMN IF EXISTS phone, DROP COLUMN IF EXISTS company_name,
    DROP COLUMN IF EXISTS address, DROP COLUMN IF EXISTS city, DROP COLUMN IF EXISTS zip;
  DROP INDEX IF EXISTS crm_contact_shops_shop_idx;
  DELETE FROM schema_migrations WHERE filename = '040_eshop_api_a_ucty_po_eshopech.sql';
  COMMIT;
  ```
  Obnova z dumpu (`pg_restore --clean`) vrátí i data od zálohy — jen když je
  databáze poškozená.

---

## Úklid testovacích dat

`scripts/smazat-testovaci-data.js --eshop dilnavlnenka` (bez `--smazat` jen
vypíše, co by se stalo) maže objednávky a doklady e-shopu a jeho testovací
zákazníky. Zákazníky Toneráčku nechává být: kontakt s objednávkou, účtem nebo
vazbou hosta v jiném e-shopu zůstane, odpojí se jen od Dílny. Objednávky
počítá podle vazby i podle e-mailu (vazba chybí, když zápis do CRM při
objednávce selhal). Testovat se má na stagingu; na produkci jen s dumpem po
ruce.
