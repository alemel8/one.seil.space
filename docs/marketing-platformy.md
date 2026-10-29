# Marketingové platformy — napojení a adaptéry

Sekce Marketing v One SEIL stahuje každou noc statistiky z reklamních
a analytických platforem a ukládá je po dnech do `marketing_daily_stats`
(tabulky viz [databaze.md](databaze.md#marketing)). Tenhle dokument říká,
**co je potřeba zařídit u každého poskytovatele, co zadat v One SEIL
a co a v jakých jednotkách se stahuje**. Kód adaptérů leží v
`src/marketing/adapters/`, jeden soubor na platformu, všechny se stejným
rozhraním (hlavička `src/marketing/adapters/index.js`).

Napojení se zakládá v **Nastavení → Eshopy → detail e-shopu → Marketing**:
platforma, ID na straně platformy (`external_id`), u Google Ads případně
nadřazené ID (`parent_external_id`), u Skliku, Heureky a Mety token. Tokeny
leží v databázi šifrované klíčem `MARKETING_SECRETS_KEY` z prostředí
(AES-256-GCM, `src/marketing/tajemstvi.js`), v administraci je vidět jen
otisk. Tlačítko **Ověřit připojení** zavolá `overit()` adaptéru a bez
ukládání řekne, zda přístup funguje a co platforma o účtu říká (název,
pásmo, měna); u aktivního zdroje úspěch rovnou spustí stažení dat na pozadí
(průběh v Marketing › Synchronizace), takže po opravě přístupu není třeba
chodit na ruční spuštění. Chyba u zdroje v kartě nese čas posledního běhu;
po restartu aplikace (redeploy) se dnešní neúspěšný běh zkusí sám znovu.

---

## Co platí pro všechny platformy

| | |
|---|---|
| **Peníze** | vždy **Kč bez DPH** ve sloupci `cost` (Google i Meta fakturují v režimu reverse charge, Sklik posílá haléře bez DPH). Heureka posílá obojí, s DPH jde do `cost_with_vat`. Mikro-koruny (Google Ads) a haléře (Sklik) převádí adaptér. |
| **Datum** | `YYYY-MM-DD` v **pásmu účtu platformy** (GA4, Google Ads, Merchant, Meta mají pásmo v nastavení účtu — `overit()` ho vypisuje, u Toneráčku je všude Europe/Prague). Sklik, Heureka a e-shop počítají pražské dny. Search Console používá pásmo PT; s objednávkami se po dnech nesrovnává. |
| **Denní součet** | řádek `segment_kind = ''` je **povinný pro každý den, kdy platforma něco má**, a jediný vstupuje do KPI (PNO, ROAS). Rozpady (`campaign`, `channel`, `query`, `product`) jsou doplňkové a sčítat je s celkem by náklady zdvojilo. Dotazy a produkty se ukládají jen **top 50 na den**. |
| **Záporné a nečíselné hodnoty** | Sklik i Google Ads umí poslat zápornou opravu konverzí. Do denního součtu nevstoupí, řádek kampaně si ji nese a normalizace (`src/marketing/normalizace.js`) ji nahradí nulou a ohlásí do logu běhu. Nečíselný text („1 234,50“) se nikdy nepřevede potichu na nulu — vždy s varováním. |
| **Okno a přepis** | sync stahuje okno `[dnes − prepisDni, včera]` a každou noc ho celé přepíše (DELETE + INSERT). `prepisDni` je 14 u GA4, Search Console, Merchantu a e-shopu, **30 u Google Ads, Skliku, Heureky a Mety** (konverze se připisují ke dni kliku až 30 dní zpětně). Okno se dělí na kusy nejvýš `maxDniNaDotaz` dní (31; Sklik 30; e-shop 90). První běh stahuje historii od `since`, nejvýš 400 dní. |
| **Chyby** | `AdapterError { permanent, status }` (`src/marketing/adapters/chyby.js`). **Trvalé** = HTTP 4xx kromě 429 a 408, typicky 400/401/403/404 (špatný token, chybějící právo, špatné ID, chybný dotaz) a chybějící šifrovací klíč — sync se neopakuje, zdroj čeká na obsluhu a text chyby říká, co udělat. **Přechodné** = 429, 5xx, síť, timeout — opakují se třikrát hned (prodleva 2, 4 s, `Retry-After` se respektuje) a pak s backoffem syncu. Tokeny se nikdy nelogují (adresy jdou do logu bez query stringu). |
| **Testy** | `env -u DATABASE_URL node --test test/marketing-adaptery.test.js` — `parsuj()` každého adaptéru nad `test/fixtures/marketing/<platforma>-*.json` (ručně psané odpovědi ve tvaru skutečného API), falešný fetch pro adresy, hlavičky, stránkování a třídění chyb. |

Přehled:

| platforma | kam se přidává přístup | co zadat v One SEIL | co se stahuje | přepis |
|---|---|---|---|---|
| GA4 | service account jako **Čtenář** property | ID property (číslo) | relace, uživatelé, trychtýř, nákupy; kanály zdroj / médium | 14 dní |
| Google Ads | service account jako uživatel **jen pro čtení** | zákaznické číslo; MCC jen u agenturního účtu | náklady, zobrazení, kliky, konverze po kampaních | 30 dní |
| Search Console | service account jako **uživatel** property | property (`sc-domain:…` nebo URL) | kliky, zobrazení, pozice; top 50 dotazů/den | 14 dní |
| Merchant Center | service account v **Lidé a přístup**; jednorázová registrace projektu | číslo účtu | kliky a zobrazení ORGANIC/ADS; schválené a zamítnuté položky | 14 dní |
| Sklik (+ Zboží.cz) | klíč **API Fénix** s právem čtení | klíč; ID účtu jen u propojeného účtu | kampaně po dnech → platformy `sklik` a `zbozi` | 30 dní |
| Heureka | klíč **API měření konverzí** | klíč | návštěvy, objednávky, tržby, náklady bez/s DPH; top 50 produktů/den | 30 dní |
| Meta | token **System User** s `ads_read` | token; ID účtu (za `act_`) | útrata, zobrazení, kliky na odkaz, nákupy po kampaních | 30 dní |
| e-shop | `WEBHOOK_SECRET` e-shopu | nic (URL e-shopu z nastavení) | hledání, hledání bez výsledku, opuštěné košíky | 14 dní |

---

## Google — jeden service account pro GA4, Ads, Search Console i Merchant

Všechny čtyři služby Googlu čte **tentýž service account** jako import
faktur z Google Disku (`GOOGLE_SERVICE_ACCOUNT_JSON`, `src/google-auth.js`),
jen s jiným scope. Postup (jednou, ~20 minut):

1. [console.cloud.google.com](https://console.cloud.google.com) → projekt →
   **IAM & Admin → Service Accounts → Create** (např. `one-seil`) →
   **Keys → Add key → JSON**. Poznamenat `client_email`.
2. **APIs & Services → Enable APIs**: *Google Analytics Data API*, *Google
   Analytics Admin API* (ověření property), *Google Search Console API*,
   *Merchant API*, *Google Ads API*. U Google Ads API navíc na jeho stránce
   v Cloud Console **Upgrade access level → Apply for access** (úroveň
   *Explorer*, 2 880 operací denně, schválení automatické) — od 9. 9. 2026
   je úroveň přístupu vlastností Cloud projektu a developer token se už
   nepoužívá.
3. Coolify (One SEIL): `GOOGLE_SERVICE_ACCOUNT_JSON` = celý obsah JSON
   klíče v jedné proměnné (escapované `\n` se přeloží samy), redeploy.
4. E-mail service accountu přidat tam, odkud má číst (níž u každé platformy).
   Nastavení e-shopu ho ukazuje, aby se dal zkopírovat.

Bez `GOOGLE_SERVICE_ACCOUNT_JSON` hlásí každý Google adaptér trvalou chybu
s tímhle návodem.

### GA4 (`ga4`)

| | |
|---|---|
| U Googlu | GA4 → **Správa → Správa přístupu k vlastnosti** → přidat e-mail service accountu jako **Čtenář** (Viewer). |
| V One SEIL | `external_id` = **ID property** (číslo, např. `318467224`; v GA4 → Správa → Nastavení vlastnosti). **Ne `G-…`** — to je ID datového streamu, adaptér ho odmítne. |
| Volání | `POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`, scope `analytics.readonly`, dva reporty za sebou: **A** dimenze `date`, metriky `sessions, totalUsers, newUsers, engagementRate, itemsViewed, addToCarts, checkouts, ecommercePurchases, purchaseRevenue`; **B** dimenze `date × sessionSourceMedium`, metriky `sessions, totalUsers, ecommercePurchases, purchaseRevenue`. Limit 250 000 řádků s `offset`, `returnPropertyQuota: true`. |
| Co se ukládá | součet dne: `sessions`, `total_users`, `view_item` (itemsViewed = kusy zobrazené v události view_item; na detailu produktu 1 kus = 1 zobrazení, metrika `itemViewEvents` by počítala události — plán D9 zvolil itemsViewed), `add_to_cart` (addToCarts), `begin_checkout` (checkouts), `purchase` (ecommercePurchases), `purchase_revenue`; rozpad `channel` se segmentem doslova „google / cpc“ (na kanál Seilu překládá `kanalZeSegmentuGa4()`). `newUsers` a `engagementRate` se stahují, ale zatím nemají sloupec. Rozpad po kampaních se v první verzi nestahuje. |
| Jednotky, pásmo | `purchaseRevenue` v měně property (CZK); datum `YYYYMMDD` v pásmu property. Nákupy GA4 jsou jen pro porovnání — bez souhlasu s analytikou GA4 nákup nevidí, tržby bere Seil z objednávek. |
| Přepis | 14 dní (data definitivní po 24–48 h, atribuce klíčových událostí se mění 12 dní). |
| Limity | kvóta 200 000 tokenů/den a 40 000/h na property, 10 souběžných požadavků — adaptér volá reporty za sebou; den bez návštěv v reportu A chybí, součet se dopočítá z kanálů (bez trychtýře) a běh to ohlásí. |
| Ověření | `GET https://analyticsadmin.googleapis.com/v1beta/properties/{id}` → „Property 318467224 (Toneráček), pásmo Europe/Prague“, varování při jiné měně než CZK. 403 = e-mail není Čtenář property nebo není zapnuté Analytics Data/Admin API. |

### Google Ads (`google_ads`)

| | |
|---|---|
| U Googlu | Google Ads → **Správce → Přístup a zabezpečení → Uživatelé** → přidat e-mail service accountu s rolí **Jen pro čtení**. Cloud projekt s úrovní *Explorer* (viz výše). |
| V One SEIL | `external_id` = **zákaznické číslo** (10 číslic, `882-718-1396` i bez pomlček); `parent_external_id` = číslo **správcovského účtu (MCC)** jen tehdy, když účet spravuje agentura — jde do hlavičky `login-customer-id`; u přímo spravovaného účtu nechat prázdné. |
| Volání | `POST https://googleads.googleapis.com/v26/customers/{číslo bez pomlček}/googleAds:searchStream` s `{"query": GAQL}`, scope `adwords`, **bez hlavičky `developer-token`**. GAQL: `SELECT segments.date, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.all_conversions FROM campaign WHERE segments.date BETWEEN 'A' AND 'B'`. Odpověď je pole dávek s `results[]` (camelCase, int64 jako řetězce). |
| Co se ukládá | rozpad `campaign` (segment = název kampaně) + součet dne: `cost` = `costMicros / 1 000 000`, `impressions`, `clicks`, `conversions` (desetinné — atribuce podle dat), `conversion_value`. `all_conversions` se stahuje, ale neukládá. |
| Jednotky, pásmo | mikro-koruny → Kč bez DPH; den v pásmu účtu (`overit()` vypisuje měnu a pásmo). |
| Přepis | 30 dní (konverze se dopočítávají). |
| Limity | dny bez útraty v odpovědi nejsou (= 0, ne chyba); verze API `v26` je konstanta `VERZE` v adaptéru (Google vydává čtyři verze ročně, podpora ~rok). Známá chyba Googlu: `AUTHORIZATION_ERROR` u projektů povýšených na Explorer po 9. 9. 2026 — Google opravuje; do té doby trvalá chyba 403 s textem Googlu. |
| Ověření | GAQL `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer` → „Účet 882-718-1396 (Toneráček), měna CZK, pásmo Europe/Prague“. |

### Search Console (`search_console`)

| | |
|---|---|
| U Googlu | Search Console → **Nastavení → Uživatelé a oprávnění** → přidat e-mail service accountu (stačí **Omezený** přístup). Property musí být ověřená. |
| V One SEIL | `external_id` = property **přesně jak ji Search Console vypisuje**: doménová `sc-domain:toneracek.cz` nebo URL prefix `https://toneracek.cz/` (s lomítkem). Jiný tvar vrací 403, i když přístup je. |
| Volání | `POST https://searchconsole.googleapis.com/webmasters/v3/sites/{encodeURIComponent(property)}/searchAnalytics/query`, scope `webmasters.readonly`: `{startDate, endDate, dimensions: ['date'], rowLimit: 1000}` pro součty a `{dimensions: ['date', 'query'], rowLimit: 25000, startRow}` pro dotazy (stránkuje se, nejvýš 4 stránky). |
| Co se ukládá | součet dne: `clicks`, `impressions`, `position_sum = position × impressions` (průměrná pozice za období = `position_sum / impressions`, viz `organikaSearchConsole()`); rozpad `query` = **top 50 dotazů na den** podle kliků (shoda: zobrazení). Anonymizované dotazy Google neposílá, součet dotazů je proto menší než součet dne. |
| Jednotky, pásmo | počty; den v pásmu PT (Google ho pro Search Console nemění). Bez nákladů. |
| Přepis | 14 dní. **Data jsou 2–3 dny pozadu** — chybějící poslední dny nejsou chyba, doplní je další běh. Historie 16 měsíců. |
| Ověření | `GET …/webmasters/v3/sites` → property v `siteEntry[]` s `permissionLevel` → „Property sc-domain:toneracek.cz, oprávnění siteRestrictedUser“; když chybí, hláška vypíše weby, které účet vidí, a koho přidat. `siteUnverifiedUser` = neověřená property. |

### Merchant Center (`merchant`)

| | |
|---|---|
| U Googlu | Merchant Center → **Nastavení → Lidé a přístup** → přidat e-mail service accountu (práva *Performance and insights*, pro stav položek i *Admin*). **Jednorázově zaregistrovat Cloud projekt k účtu**: `POST https://merchantapi.googleapis.com/accounts/v1/accounts/{číslo účtu}/developerRegistration:registerGcp` s tělem `{"developerEmail": "<e-mail správce účtu>"}`, voláno tímtéž service accountem (např. přes OAuth Playground nebo `curl` s tokenem) — bez registrace Merchant API vrací 403 s odkazem na ni. One SEIL ji nedělá automaticky. |
| V One SEIL | `external_id` = **číslo účtu** Merchant Center (vpravo nahoře). |
| Volání | `POST https://merchantapi.googleapis.com/reports/v1/accounts/{id}/reports:search` s `{"query": "SELECT date, marketing_method, clicks, impressions, click_through_rate FROM product_performance_view WHERE date BETWEEN 'A' AND 'B'", "pageSize": 1000, "pageToken"}`; `GET https://merchantapi.googleapis.com/issueresolution/v1/accounts/{id}/aggregateProductStatuses?pageSize=100`. Scope `content` — **jediný, který Merchant API má, je read/write**; klíč service accountu proto chránit jako token s právem zápisu. |
| Co se ukládá | rozpad `channel` se segmentem `ORGANIC` (bezplatné záznamy) / `ADS` (reklamy Nákupů) + součet dne: `clicks`, `impressions`; `approved_items` (Σ `activeCount`) a `disapproved_items` (Σ `disapprovedCount`) ze záznamů s kontextem `SHOPPING_ADS` (všechny země; když žádný není, ze všech kontextů) **na poslední den okna, a jen když okno sahá aspoň k včerejšku** — API vrací jen dnešní stav, historii nemá; historické kusy prvního běhu stav nedostanou, aby přehled za minulý měsíc neukazoval dnešní počty jako loňské. Bez nákladů (ty jsou v Google Ads). |
| Jednotky, pásmo | datum chodí jako objekt `{year, month, day}` v pásmu účtu. |
| Přepis | 14 dní. |
| Limity | kvóty `GET …/quota/v1/accounts/{id}/quotas`; Content API skončilo 18. 8. 2026, používá se Merchant API v1. |
| Ověření | `GET https://merchantapi.googleapis.com/accounts/v1/accounts/{id}` → „Účet 123456789 (Toneráček), pásmo Europe/Prague“. |

---

## Sklik a Zboží.cz (`sklik`, zapisuje `sklik` i `zbozi`)

Zboží.cz vlastní API nemá (skončilo 16. 3. 2026) a statistiky Seznam
Nákupů jsou od 9. 10. 2026 jen ve Skliku jako kampaně typu `zbozi`. Proto
**žádné napojení „zbozi“ neexistuje** — adaptér Sklik rozdělí kampaně
podle typu a zapíše dvě platformy, každou s vlastním denním součtem.

| | |
|---|---|
| U Seznamu | Sklik → **Nastavení → Správa klíčů API Fénix** → nový klíč s právem **čtení (r)**. Jde založit **jen při přímém přihlášení majitele účtu**, ne přes agenturní přístup. Klíč může mít expiraci — po ní sync hlásí trvalou chybu (400/401 u tokenu) a stačí uložit nový. |
| V One SEIL | token = **klíč API Fénix**; `external_id` = ID účtu Sklik (`userId`) **jen když klíč patří agentuře a čte propojený účet** (jde jako `user_id` do žádosti o token), jinak prázdné. `parent_external_id` se nepoužívá (plán počítal s `premiseId` provozovny pro statistiky Nákupů per provozovna — první verze je nestahuje). |
| Volání | `POST https://api.sklik.cz/v1/user/token` (formulář `grant_type=client_credentials`, `Authorization: Bearer <klíč>`) → `access_token` na hodinu; endpoint je sám omezený, adaptér token drží v paměti nejvýš 55 minut pod otiskem klíče a při 401 u dat ho jednou obnoví. `GET https://api.sklik.cz/v1/sklik/campaigns/?statisticsDateFrom=A&statisticsDateTo=B&statisticsGranularity=daily&a=id&a=name&a=type&a=clicks&a=impressions&a=totalMoney&a=conversions&a=conversionValue&limit=1000&offset=0` — statistiky se musí **vyžádat atributy `a`**; odpověď `{ items: [...] }` je **plochá**: každá kampaň se opakuje jednou na den a řádek nese statistiky dne a `firstDate`. `limit`/`offset` počítají tyto řádky, ne kampaně; odpověď nenese celkový počet, stránkuje se, dokud stránka vrací plný limit (opakovaná stránka se nezapočítá a stránkování skončí s varováním). |
| Co se ukládá | rozpad `campaign` (segment = název kampaně) + součet dne pro každou platformu: `impressions`, `clicks`, `cost` = `totalMoney / 100`, `conversions`, `conversion_value` = `conversionValue / 100`. Typ `zbozi` → platforma `zbozi`, všechno ostatní (fulltext, context, combined, video, product, social, simple, smart, audio) → `sklik`. |
| Jednotky, pásmo | statistiky **v haléřích bez DPH → Kč** („in hellers“ ve specifikaci); kredit Peněženky naopak **v Kč** (`credit` bez DPH, `creditWithVat` s DPH); den pražský. |
| Přepis | 30 dní (konverze se připisují ke dni kliku 30 dní). Kus okna nejvýš 30 dní (nejvýš 60 bucketů na kampaň, denně „do 1 měsíce“). |
| Limity | 5 požadavků za sekundu — mezi voláními 250 ms; `/nakupy/statistics/*` (nepoužívá se) 5 za 30 s. `/sklik/campaigns/` vrací 422 na neplatný dotaz (příliš dlouhé okno) — trvalá chyba. |
| Ověření | `GET /user/me` → `userName`, `userId`, `actor` (kdo jedná za koho) a `scope` — bez scope `campaign` je ověření ok: false (sync by padal na 403); `GET /user/me/credit` → `credit` v Kč, nebo u klienta agentury jen `agencyStatus` (`client-agency` / `bill-agency`) → „bez vlastní Peněženky“. |
| **Ověřeno proti specifikaci** | tvar volání i odpovědí podle `https://api.sklik.cz/v1/openapi.json` z 29. 10. 2026 (schémata `CampaignListResponseBody`, `FulltextCampaignResponse`/`ZboziCampaignResponse`, `AccessTokenResponse`, `CurrentUserResponse`, `CreditResponse`), ne proti živému účtu. Neznámý zůstává přesný formát `firstDate` (`datumZOdpovedi()` bere `YYYY-MM-DD` i ISO čas) a jak API vypisuje kampaň bez statistik (`showEntityWithZeroStatistic` necháváme výchozí; řádek bez `firstDate` se přeskočí s varováním). První ostrý běh porovnat s UI Skliku. |

---

## Heureka (`heureka`)

| | |
|---|---|
| U Heureky | administrace → **Statistiky a reporty → API měření konverzí** (nebo Nastavení → API klíče, typ *Měření konverzí*) → klíč. Report funguje jen s **novým dvouskriptovým měřením konverzí** (`//www.heureka.cz/ocm/sdk.js?version=2`, stránka produktu + děkovná stránka), které e-shop Toneráčku má. |
| V One SEIL | token = **klíč API**; `external_id` nepovinné (obchod určuje klíč). |
| Volání | `GET https://api.heureka.group/v1/reports/conversions?date=YYYY-MM-DD` s hlavičkou `x-heureka-api-key: <klíč>` — **jedno volání na den**, bez stránkování, mezi dny 200 ms. Oficiální dokumentace (`https://api.heureka.group/v1/reports/docs`, 29. 10. 2026) zná jen tuto hlavičku a stavy 403 (klíč), 422 (datum), 500; `x-hg-portal: heureka.cz` se posílá navíc podle brány Heureka Group (neznámou hlavičku server ignoruje) a hlavičky `RateLimit-Remaining` / `RateLimit-Reset` se čtou jen, když přijdou (při 0 se čeká do resetu, nejvýš minutu); 429 s `Retry-After` se opakuje. Slovenská Heureka se nepodporuje. |
| Co se ukládá | součet dne: `clicks` = Σ `visits.total`, `cost` = Σ `costs_without_vat.total`, `cost_with_vat` = Σ `costs_with_vat.total`, `conversions` = Σ `orders.total`, `conversion_value` = Σ `revenue.total`; rozpad `product` (segment = `shop_item.id` + název) sečtený přes zdroje kliku a ořezaný na **50 produktů s nejvyššími náklady na den**. **Imprese Heureka neposílá** (CTR „—“). |
| Jednotky, pásmo | Kč, obě varianty DPH; `date` je podle dokumentace pražský kalendářní den („treated as a Europe/Prague calendar day“), statistiky se aktualizují průběžně. Den bez dat vrací prázdné `conversions` a nedá žádný řádek. |
| Přepis | 30 dní (konverze ke dni kliku, 30denní okno). Heureka tedy **není** ruční náklad — ruční náklad se zadává jen do napojení nebo při výpadku. |
| Ověření | stáhne včerejšek (pražský) a ohlásí počet řádků, návštěvy, objednávky a náklady bez DPH; 0 řádků může znamenat i to, že report za včerejšek ještě není hotový. |

---

## Meta (`meta`)

| | |
|---|---|
| U Mety | Business Settings → **Users → System Users** → systémový uživatel s přístupem k reklamnímu účtu → **Generate token** s oprávněním **`ads_read`**; aplikace typu Business s produktem Marketing API (úroveň *Limited access* bez App Review pro vlastní účet). Token platí **60 dní** (nebo zvolit „Never“) — po vypršení sync hlásí trvalou chybu s návodem a stačí uložit nový token. |
| V One SEIL | token = **System User token**; `external_id` = **ID reklamního účtu** (číslo za `act_` v Ads Manageru). |
| Volání | `GET https://graph.facebook.com/v26.0/act_{id}/insights?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,actions,action_values,purchase_roas&time_increment=1&time_range={"since":"A","until":"B"}&limit=500&access_token=…`, sleduje se `paging.next`. Verze `v26.0` je konstanta `VERZE` v adaptéru (verze žijí ~rok). |
| Co se ukládá | rozpad `campaign` (segment = název kampaně) + součet dne: `cost` = `spend`, `impressions`, `clicks` = **`inline_link_clicks`** (kliky na odkaz = návštěvy webu, srovnatelné s kliky Skliku a Ads; „clicks“ Mety počítají i reakce — vezmou se jen, když `inline_link_clicks` chybí), `conversions` = `actions[].value` pro `omni_purchase` (náhradně `offsite_conversion.fb_pixel_purchase`), `conversion_value` obdobně z `action_values`. |
| Jednotky, pásmo | `spend` v **měně účtu — předpokládá se CZK** bez DPH (reverse charge); `overit()` měnu vypisuje a varuje, když není CZK. Den `date_start` v pásmu účtu (`timezone_name`). |
| Přepis | 30 dní (atribuční okno 7d_click / 1d_view se dopočítává zpětně). |
| Limity | 600 + 400 × počet aktivních reklam volání za hodinu na účet; Meta vrací limity a dočasné chyby jako **HTTP 400** s `error.code` 1/2/4/17/32/613 (platforma) nebo 80000/80004 (Business Use Case: Ads Insights / Ads Management, subcode 2446079) nebo `is_transient` — adaptér je bere jako přechodné; `code 190` = neplatný/vypršelý token (trvalá). |
| Ověření | `GET /v26.0/act_{id}?fields=name,currency,timezone_name` → „Účet act_123456789 (Toneráček), měna CZK, pásmo Europe/Prague“. |

---

## E-shop (`eshop`)

Vlastní endpoint e-shopu, stejný kontrakt pro Toneráček i další e-shopy:
hledání (celkem, bez výsledku, nejčastější) a opuštěné košíky (počet,
hodnota, dokončené, připomenuté, nejčastější zboží) za posledních N pražských
dnů včetně dneška, s rozpadem po dnech.

| | |
|---|---|
| U e-shopu | `WEBHOOK_SECRET` v prostředí e-shopu (totéž tajemství jako pro podání balíku). Endpoint `GET /api/marketing/statistika` musí být nasazený (Toneráček od říjnové verze; bez něj 404 = trvalá chyba s návodem). |
| V One SEIL | nic navíc: adresa se bere z **URL e-shopu** v jeho nastavení; tajemství podle pravidla pro `x-webhook-secret` — **Toneráček jen `SHOP_WEBHOOK_SECRET` z prostředí One SEIL, ostatní e-shopy jen vlastní `shops.webhook_secret`** (Nastavení → Eshopy → Napojení e-shopu). Sync ho adaptéru předá v `tajemstvi`; bez něj platí totéž pravidlo nad záznamem e-shopu. |
| Volání | `GET {url}/api/marketing/statistika?dni=N` s hlavičkou `x-webhook-secret`, `N = dnes − from + 1` (1–90). Odpověď `{od, do, hledani: {celkem, bezVysledku: [{dotaz, n, posledni}], nejcastejsi: [...]}, kosiky: {pocet, hodnota, dokonceno, pripomenuto, top: [...]}, poDnech: [{datum, hledani, hledaniBezVysledku, kosiky, kosikyHodnota}]}`. |
| Co se ukládá | součet dne z `poDnech` jen pro dny v okně (dnešek je neúplný): `searches`, `searches_no_result`, `carts_abandoned`, `carts_value`; seznam `bezVysledku` jako rozpad `query` (segment = dotaz, `searches_no_result` = `n`) **na poslední den okna** — e-shop ho neumí rozložit do dnů a `n` je celkový počet hledání dotazu naposledy hledaného v okně. |
| Jednotky, pásmo | `carts_value` v Kč **s DPH**, jak je měl košík; dny pražské. |
| Přepis | 14 dní; kus okna až 90 dní. E-shop umí vrátit nejvýš 90 dní zpět — starší kus okna (první běh 400 dní) se bez volání přeskočí a zaloguje. |
| Chyby | **401** = tajemství nesedí s `WEBHOOK_SECRET` e-shopu (trvalá); **503 s JSON chybou** = e-shop nemá `WEBHOOK_SECRET` v prostředí (trvalá, s návodem); 503 bez JSON = výpadek proxy (přechodná). |
| Ověření | `dni=1` → „E-shop odpovídá (https://…/api/marketing/statistika): dnes 41 hledání, 3 dotazů bez výsledku, 3 opuštěných košíků za 3 290 Kč“. |

---

## Co je hotové a co ne

- Hotové: osm adaptérů (`src/marketing/adapters/*.js`), společné chyby
  a pomocníci, rejstřík `index.js` se seznamem pro nastavení, fixtury
  a testy (`test/marketing-adaptery.test.js`).
- Noční sync (`src/marketing/sync.js`), stránky `/marketing*` a karta
  v nastavení vznikají zvlášť a adaptéry volají přes rozhraní v hlavičce
  `index.js`.
- **Ověřeno proti specifikacím, ne proti živému API** (29. 10. 2026):
  Sklik podle `openapi.json` (plochá odpověď, atributy `a`, haléře,
  kredit v Kč), Heureka podle `reports/docs` (jen `x-heureka-api-key`,
  pražský den, bez stránkování), Merchant podle discovery dokumentů
  (`aggregateProductStatuses`, `productPerformanceView`), GA4 metriky
  podle schématu Data API, Meta kódy limitů podle dokumentace. Neověřené
  zůstává: formát `firstDate` Skliku, chování `x-hg-portal`, měna účtu
  Mety. Fixtury jsou psané podle těchto specifikací; první ostrý běh každé
  platformy je potřeba porovnat s UI platformy (pravidlo ±10 % z 90denního
  plánu) a případný rozdíl opravit v `parsuj()` a ve fixtuře.
