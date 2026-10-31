# API dokumentace

API pro e-shopy: `/api/toneracek` (Toneráček) a `/api/eshop` (ostatní e-shopy,
stejný kontrakt). Starší multi-shop API `/api/v1` (hlavička `X-API-Key`,
klíče v tabulce `api_keys`) a veřejný Swagger na `/api/docs` jsou od
26. 10. 2026 pryč: nikdo je nepoužíval a klíč z `api_keys` otevíral čtení
i úpravy všech kontaktů v CRM. Tabulka `api_keys` v databázi zůstala, kód
ji nečte.

---

## Autentizace API

### Bearer token (Toneráček)
```
Authorization: Bearer <TONERACEK_API_KEY>
```
Hodnota z env proměnné `TONERACEK_API_KEY`.

### Bearer klíč e-shopu (`/api/eshop`)
```
Authorization: Bearer <klíč e-shopu, 64 hex znaků>
```
Klíč vydává Nastavení → Eshopy → detail e-shopu → záložka *Napojení e-shopu* — jiné
místo pro klíče už není. Ukáže se jednou, v databázi (`eshop_api_keys`) je
jen jeho SHA-256 otisk. Klíč **určuje e-shop** — viz
[E-shop API](#e-shop-api-apieshop).

---

## Toneráček API (`/api/toneracek`)

### POST /api/toneracek/orders
Příjem objednávky.

**Body:**
```json
{
  "orderNumber": "12345",
  "paymentMethod": "card",
  "currency": "CZK",
  "totalPrice": 1490.00,
  "ipAddress": "1.2.3.4",
  "notes": "Poznámka k objednávce",
  "isRegistered": false,
  "customer": {
    "firstName": "Jan",
    "lastName": "Novák",
    "email": "jan@example.com",
    "phone": "+420123456789",
    "company": "",
    "ic": "",
    "dic": "",
    "address": "Hlavní 1",
    "city": "Praha",
    "zip": "11000",
    "country": "Česká republika"
  },
  "shipping": {
    "method": "Zásilkovna",
    "firstName": "Jan",
    "lastName": "Novák",
    "address": "Hlavní 1",
    "city": "Praha",
    "zip": "11000",
    "pickupPointId": "12345",
    "pickupPointName": "Zásilkovna Praha 1"
  },
  "items": [
    {
      "sku": "TN-001",
      "supplierCode": "11208",
      "name": "Toner HP 12A",
      "quantity": 2,
      "price": 745.00,
      "productId": "prod-001",
      "costPrice": 210.5,
      "costPriceVatIncluded": false
    }
  ],
  "marketing": {
    "consent": "all",
    "first": {
      "source": "google", "medium": "cpc", "campaign": "tonery-hp", "term": "hp 12a", "content": "",
      "clickIdKind": "gclid", "clickId": "Cj0KCQ…", "referrerHost": "google.com",
      "landingPage": "/produkty/hp-12a", "at": "2026-10-20T09:15:00.000Z"
    },
    "last": {
      "source": "seznam", "medium": "cpc", "campaign": "sklik-tonery",
      "clickIdKind": "sznclid", "clickId": "…", "referrerHost": "seznam.cz",
      "landingPage": "/", "at": "2026-10-28T18:02:11.000Z"
    }
  }
}
```

Volitelné `status` nastaví výchozí stav objednávky (bez něj „Přijata“).
E-shop ho posílá jako `"Čeká na platbu"` u plateb kartou — objednávka je do
potvrzení platby jen rezervací.

**Response 200:**
```json
{
  "orderId": "lx7k9abc123",
  "orderNumber": "10001",
  "invoiceNumber": ""
}
```

`invoiceNumber` je vždy prázdné — faktura vzniká až vyřízením objednávky a číslo
dostane z řady (např. `20260001`). Pak ho vrací `GET /api/toneracek/orders`
(i `…/by-number/:orderNumber`) v `invoice_number` — vždy číslo vydané faktury,
bez ní prázdné, i u starších objednávek, které mají v databázi uložené vymyšlené
`FV-<rok>-<objednávka>`. K tomu žádný doklad neexistoval; e-shop má řádek
„Faktura" při prázdné hodnotě skrýt, a to dřív nebo současně s nasazením Seilu.

---

`supplierCode` je nepovinný kód dodavatele, podle kterého vychystává sklad
(v Toneráčku Airtable pole „ID Dodavatele"). Ranní expedice ho tiskne do
seznamu pro sklad; když chybí, vytiskne se místo něj `sku` s poznámkou.
**`sku` kód dodavatele není** — je to interní kód e-shopu.

### Zdroj objednávky a nákupní cena (od migrace 042)

`marketing` i `items[].costPrice` jsou **nepovinné** — e-shop, který je
neposílá, projde beze změny a objednávka dostane výchozí hodnoty (prázdné
texty, `NULL`). Kontrakt je společný pro všechny e-shopy a platí doslova
na obou stranách:

```
marketing: { consent: "none"|"analytics"|"marketing"|"all", first?: Dotyk, last?: Dotyk }
Dotyk = { source, medium, campaign?, term?, content?, clickIdKind?, clickId?,
          referrerHost?, landingPage?, at }
items[]: { …, costPrice: number|null, costPriceVatIncluded: boolean|null }
```

| Pole | Pravidlo | Sloupec v One SEIL |
|---|---|---|
| `consent` | kategorie souhlasu z lišty e-shopu při objednávce | `shop_orders.attribution_consent` (`''` = objednávka před nasazením) |
| `first` / `last` | první dotyk (paměť 90 dní, jen s marketingovým souhlasem) a poslední dotyk před objednávkou; kanál objednávky se počítá z posledního | sloupce s příponou `_first` / `_last` |
| `source`, `medium` | malými písmeny, max 120 znaků | `utm_source_*`, `utm_medium_*` |
| `campaign`, `term`, `content` | max 120 znaků | `utm_campaign_*`, `utm_term_*`, `utm_content_*` |
| `clickIdKind` | jen `gclid`, `gbraid`, `wbraid`, `fbclid`, `sznclid`, `sznaiid`, `hgtid`, `aku` | `click_id_kind_*` |
| `clickId` | max 200 znaků; One SEIL ho uloží jen s `consent` `marketing` nebo `all`, jinak zahodí i druh | `click_id_*` |
| `referrerHost` | jen hostitel bez `www.`, max 100 znaků | `referrer_host_*` |
| `landingPage` | jen cesta bez query stringu, max 200 znaků | `landing_page_*` |
| `at` | ISO 8601 **s pásmem** (`Z` nebo `±HH:MM`; e-shop posílá `toISOString()`); bez pásma, nečitelný nebo mimo ±1 rok od přijetí → čas přijetí objednávky (dotyk bez jediného údaje → `NULL`) | `touch_first_at` / `touch_last_at` |
| `costPrice` | nákupní cena za kus, `0 ≤ n < 1 000 000`, **na haléře** (ne celé koruny jako `price`); pseudo-položky `SLEVA-REG`, `DOPRAVA`, `DOBIRKA` posílají `null` | `shop_order_items.cost_price` |
| `costPriceVatIncluded` | `true` / `false`, jinak `NULL` (neznámo) | `shop_order_items.cost_price_vat_included` |

Všechny texty One SEIL ořízne, zbaví řídicích znaků (C0 i C1), neviditelných
formátovacích znaků Unicode (nulová šířka, bidi, BOM) a ``<>"'`\`` a nikdy
kvůli nim objednávku neodmítne — e-shop má vlastní validaci (400), One SEIL
jen čistí (`src/atribuce-objednavky.js`, společné pro obě API). Neznámá
hodnota `consent` nebo `clickIdKind` se uloží jako prázdná.

**Nákupní cena se nikdy nevrací.** `GET …/orders` ani `…/by-number`
`cost_price` a `cost_price_vat_included` neposílají (položky se vybírají po
sloupcích, ne `SELECT *`): je to interní údaj pro marži v sekci Marketing
a do prohlížeče zákazníka nepatří. Atribuční sloupce `by-number` vrací
spolu s ostatními sloupci objednávky.

Opačným směrem bude One SEIL (sekce Marketing, další krok) číst
`GET {shops.url}/api/marketing/statistika?dni=30` s hlavičkou
`x-webhook-secret` (tatáž jako u podání balíku): `{ od, do, hledani: { celkem,
bezVysledku, nejcastejsi }, kosiky: { pocet, hodnota, dokonceno, pripomenuto, top },
poDnech: [{ datum, hledani, hledaniBezVysledku, kosiky, kosikyHodnota }] }`,
data pražská, částky v CZK s DPH; `401` při špatném tajemství, `503` bez něj.

---

### PATCH /api/toneracek/orders/:id/payment-status
Změna stavu platby. E-shop sem zapisuje „Zaplaceno“ / „Platba se nezdařila“
podle Stripe webhooků.

**Body:** `{ "status": "Zaplaceno" }`

První „Zaplaceno“ uloží okamžik do `shop_orders.paid_at`; další potvrzení
(retry webhooku) ho nepřepíší. Z toho okamžiku je den přijetí úplaty na faktuře,
proto má e-shop volat hned po potvrzení platby, ne až dávkově.

---

### PATCH /api/toneracek/orders/:id/payment-method
Změna způsobu platby u už založené objednávky. Volá e-shop, když zákazník po
neúspěšné platbě kartou přepne na QR / převod / dobírku.

**Body:**
```json
{
  "paymentMethod": "transfer",
  "totalPrice": 1085,
  "status": "Přijata"
}
```

`paymentMethod` je `card` | `transfer` | `cod`. `totalPrice` a `status` jsou
volitelné — bez nich se nemění. Přepnutí na převod vystaví a odešle zálohovou
fakturu stejně jako objednávka, která s převodem přišla rovnou z pokladny
(druhou zálohovku k téže objednávce nevystaví). `status: "Zaplaceno"` zapíše
okamžik platby do `paid_at` stejně jako `payment-status`.

> Mění se stávající objednávka, ne nová: každá objednávka spotřebuje číslo
> v účetní řadě a DELETE endpoint neexistuje, takže „objednej znovu jinou
> platbou“ by po každé odmítnuté kartě nechalo v účetnictví mrtvou duplicitu.

---

### GET /api/toneracek/orders/:id/payment-details
Platební údaje k objednávce placené převodem. Jediný zdroj pravdy o tom, jak má
zákazník zaplatit — e-shop je vykresluje do potvrzení objednávky, na děkovnou
stránku i do QR kódu.

`?pdf=1` přidá zálohovou fakturu v base64. Bez něj se PDF nerenderuje (děkovná
stránka ho nepotřebuje a puppeteer render při každém načtení by byl drahý).

**Response 200:**
```json
{
  "variableSymbol": "2026010042",
  "amount": 684,
  "currency": "CZK",
  "dueDate": "2026-09-01",
  "bankAccount": "2800828200/2010",
  "iban": "CZ65...",
  "swift": "FIOBCZPP",
  "bankName": "Fio banka",
  "proformaNumber": "ZF-2026-10042",
  "pdf": null
}
```

`409 {"error":"not-transfer"}` u objednávky placené kartou nebo dobírkou —
zálohová faktura se u nich nevystavuje. Když proforma ještě neexistuje,
endpoint ji vystaví.

> Variabilní symbol je `invoiceVs()` z čísla zálohové faktury, tedy přesně to,
> co tiskne PDF a podle čeho páruje `POST /api/banka` příchozí platbu. Dokud si
> ho e-shop vymýšlel sám (číslo objednávky), platba se nespárovala.

---

### PATCH /api/toneracek/orders/:id/tracking
Aktualizace čísla zásilky.

**Body:**
```json
{
  "trackingNumber": "Z123456789",
  "labelUrl": "https://toneracek.cz/labels/Z123456789.pdf"
}
```

---

## E-shop API (`/api/eshop`)

Pro další e-shopy napojené stejně jako Toneráček (první je Dílna Vlněnka).
**Stejných 11 endpointů, těla, stavové kódy i tvary odpovědí** jako
`/api/toneracek/*` výš — e-shop, který je kopií Toneráčku, mění jen předponu
cesty a klíč. Shodu hlídá `test/toneracek-kontrakt.test.js` (jeden scénář
přes obě API, porovnání se vzorem z doby před zásahem).

| Metoda a cesta | Jako u Toneráčku |
|---|---|
| `GET /api/eshop/users?email=[&withNote=1]` | registrovaný zákazník; `poznamka` (záložní hash hesla) jen s `withNote=1` |
| `GET /api/eshop/users/:id` | |
| `POST /api/eshop/users` | registrace; `201` nový kontakt, `200` kontakt už v CRM byl, `409` účet v tomhle e-shopu už je |
| `PATCH /api/eshop/users/:id` | profil, souhlasy, `posledniPrihlaseni`, `poznamka` |
| `GET /api/eshop/orders?email=` | posledních 50 objednávek s položkami a číslem vydané faktury |
| `GET /api/eshop/orders/by-number/:orderNumber[?email=]` | `403` při cizím e-mailu |
| `PATCH /api/eshop/orders/:id/payment-status` | první „Zaplaceno“ uloží `paid_at` |
| `POST /api/eshop/orders` | číslo z řady e-shopu, zálohovka u převodu, CRM, push |
| `PATCH /api/eshop/orders/:id/payment-method` | `card` \| `transfer` \| `cod`; přepnutí na převod vystaví zálohovku |
| `PATCH /api/eshop/orders/:id/tracking` | |
| `GET /api/eshop/orders/:id/payment-details[?pdf=1]` | `409 not-transfer` mimo převod |

Rozdíly proti `/api/toneracek` (žádný nemění tvar odpovědi):

- **E-shop se bere z klíče** a každý dotaz je omezený na jeho `shop_id`,
  včetně uživatelů a platebních údajů. Cizí objednávka nebo účet vrací `404`.
  Bez klíče, se špatným, zrušeným klíčem nebo s klíčem vypnutého e-shopu
  (`shops.active = FALSE`) `401 {"error":"Unauthorized"}` — ještě před
  čtením těla požadavku.
- **Účty jsou po e-shopech** (`crm_contact_shops`). Kontakt v CRM je jeden na
  e-mail; registrace, záložní hash hesla, souhlasy (marketing, notifikace,
  GDPR) a poslední přihlášení jsou zvlášť pro každý e-shop. Zákazník
  Toneráčku tedy na e-shopu dostane `404`, dokud se tam nezaregistruje, a
  heslo z e-shopu Toneráček neotevře. `crm_contacts.is_registered`, `notes`,
  `marketing_consent` ani `gdpr_consent_at` se odsud nezapisují (čte je
  Toneráček) a kontakt, který je účtem Toneráčku (`is_registered = TRUE`),
  se odsud nemění vůbec. Profil z registrace a z `PATCH` jde jen do účtu
  e-shopu — co zákazník napíše na e-shopu, vidí jen tam. Sdílený kontakt
  (host, obchodní partner) doplní jen objednávka: prázdné jméno a telefon.
- `datumRegistrace` je den registrace v tomhle e-shopu, ne vznik kontaktu.
- Registrace (`POST /users`) vymaže případný starý záložní hash hesla —
  e-shop hned po ní zapíše nový přes `PATCH … { poznamka }`.
- Objednávka účet nezakládá ani nezvedá: `isRegistered` v těle se ignoruje,
  zákazník se k e-shopu jen přihlásí jako host. CRM zdroj = název e-shopu,
  titulek push notifikace „Nová objednávka — <název e-shopu>“.
- `POST /orders` vrátí `503`, dokud e-shop nemá vyplněnou identitu e-mailů
  (Nastavení → Eshopy) — jinak by nešla vyrenderovat zálohovka a zákazník by
  dostal potvrzení bez variabilního symbolu.

Postup napojení nového e-shopu je v [druhy-eshop.md](druhy-eshop.md).

> `GET /api/toneracek/orders/:id/payment-details` je od téže změny omezený
> na objednávky Toneráčku jako ostatní jeho endpointy (dřív jediný nebyl).
> `PATCH /api/toneracek/users/:id` bez polí vrací jen registrovaný účet
> Toneráčku jako `GET /users/:id`, jinak `404` (dřív kterýkoli kontakt v CRM
> podle id, na neznámé id `500`).

---

## Push API (`/api/push`)

Vyžaduje přihlášeného uživatele (session).

### GET /api/push/vapid-key
Vrátí VAPID public key pro registraci v prohlížeči.

```json
{ "publicKey": "BLZkYZPp-Bic..." }
```

### POST /api/push/subscribe
Registrace subscription (data z `pushManager.subscribe()`).

```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "keys": {
    "p256dh": "BBHo...",
    "auth": "tB3..."
  }
}
```

### POST /api/push/unsubscribe
```json
{ "endpoint": "https://fcm.googleapis.com/..." }
```

### POST /api/push/status
Ověření, zda je toto zařízení registrováno.
```json
{ "endpoint": "https://..." }
```
Response: `{ "subscribed": true }`

### POST /api/push/test
Zkušební notifikace na zařízení přihlášeného uživatele. Bez těla.

Response: `{ "odeslano": 1, "selhalo": 0, "duvod": "" }` — `duvod` je vyplněný jen
když neodešlo nic (chybí VAPID klíče, účet nemá registrované zařízení, push
službu odmítla). Jediný jiný spouštěč notifikace je skutečná objednávka, takže
tudy se registrace ověří, aniž by se na ni čekalo.

---

## Interní API (pro UI)

| Route | Popis |
|---|---|
| `GET /api/hledat?q=` | Našeptávač globálního hledání: `{ q, skupiny: [{ klic, nazev, odkazSeznam, polozky: [{ titulek, popis, url, stitek }] }] }`, 5 položek na skupinu, jen skupiny podle práv přihlášeného |
| `GET /api/banka/doklady` | Faktury a účtenky pro autocomplete párování |
| `GET /api/cashflow` | Data cash flow pro grafy |
| `GET /api/accounting-chart` | Účetní osnova pro autocomplete |
| `POST /api/invoice-series/:id/next` | Generování čísla faktury |
| `GET /api/healthchecks/status` | Poslední výsledky healthchecků |
| `GET /api/latest` | VPS stats snapshot (JSON) |
| `GET /api/history` | VPS stats 72h historie (JSON) |
