# Moduly systému

Každý modul je Fastify plugin registrovaný v `src/server.js`. Většina modulů vyžaduje přihlášeného uživatele; admin-only sekce navíc ověřují `request.user.is_admin`.

---

## Autentizace (`src/routes/auth.js`)

| Route | Popis |
|---|---|
| `GET /prihlasit` | Přihlašovací formulář |
| `POST /prihlasit` | Ověření e-mailu + bcrypt hesla, zápis session |
| `POST /odhlasit` | Zničení session |
| `GET /profil` | Profil přihlášeného uživatele |
| `POST /profil` | Uložení jména / změna hesla |
| `POST /profil/foto` | Upload profilové fotky (JPG/PNG/WebP, max 5 MB) |
| `POST /profil/foto/smazat` | Smazání profilové fotky |

---

## Dashboard (`src/routes/dashboard.js`)

| Route | Popis |
|---|---|
| `GET /` | Domovská stránka s KPI kartičkami |
| `GET /monitoring` | VPS dashboard (grafy RAM, CPU, disk, Docker, SSL) |
| `GET /api/latest` | JSON snapshot z `latest.json` (VPS stats) |
| `GET /api/history` | JSON z SQLite (72h historie metrik) |

KPI na domovské stránce: počty faktur, objednávek, CRM kontaktů, členů týmu, účtenek.

---

## Účetnictví — banka (`src/routes/accounting.js`)

| Route | Popis |
|---|---|
| `GET /ucetnictvi/banka` | Seznam bankovních transakcí |
| `POST /ucetnictvi/banka/vytvorit` | Manuální transakce |
| `POST /ucetnictvi/banka/:id/parovat` | Spárovat s fakturou nebo účtenkou |
| `POST /ucetnictvi/banka/:id/zrusit-parovani` | Zrušit párování |
| `GET /ucetnictvi/banka/import` | Formulář pro import CSV |
| `POST /ucetnictvi/banka/import` | Zpracování Fio CSV souboru |
| `GET /ucetnictvi/prehled` | Přehled účetnictví (souhrn) |
| `GET /ucetnictvi/objednavky` | Seznam objednávek |
| `GET /ucetnictvi/objednavky/export.csv` | CSV export objednávek |
| `GET /api/banka/doklady` | API: doklady pro autocomplete párování |
| `GET /api/cashflow` | API: data cash flow |

---

## Faktury (`src/routes/invoices.js`)

| Route | Popis |
|---|---|
| `GET /ucetnictvi/vydane-faktury` | Seznam vydaných faktur |
| `GET /ucetnictvi/vydane-faktury/nova` | Formulář nové faktury |
| `POST /ucetnictvi/vydane-faktury/vytvorit` | Vytvořit fakturu |
| `GET /ucetnictvi/vydane-faktury/:id` | Detail faktury |
| `GET /ucetnictvi/vydane-faktury/:id/pdf` | Stáhnout PDF |
| `POST /ucetnictvi/vydane-faktury/:id/odeslat-email` | Odeslat fakturu e-mailem |
| `POST /ucetnictvi/vydane-faktury/:id/upravit` | Upravit hlavičku i položky |
| `POST /ucetnictvi/vydane-faktury/:id/stav` | Změnit stav faktury |
| `POST /ucetnictvi/vydane-faktury/:id/upominka` | Odeslat upomínku (ručně) |
| `GET /ucetnictvi/upominky` | Fronta připravených upomínek |
| `POST /ucetnictvi/upominky/:id/odeslat` | Odeslat upomínku ze seznamu |
| `POST /ucetnictvi/upominky/:id/zrusit` | Zrušit upomínku |
| `GET /ucetnictvi/prijate-faktury` | Seznam přijatých faktur |
| `POST /ucetnictvi/prijate-faktury/vytvorit` | Vytvořit přijatou fakturu |
| `GET /ucetnictvi/prijate-faktury/:id` | Detail přijaté faktury |
| `POST /ucetnictvi/vydane-faktury/pohoda-xml` | POHODA XML — agenda Vydané faktury |
| `POST /ucetnictvi/prijate-faktury/pohoda-xml` | POHODA XML — agenda Přijaté faktury |
| `GET /ucetnictvi/opakujici-se-faktury` | Správa šablon opakujících se faktur |
| `POST /ucetnictvi/opakujici-se-faktury/vytvorit` | Nová šablona |
| `POST /ucetnictvi/opakujici-se-faktury/:id/toggle` | Aktivovat / deaktivovat |

### Vystavení faktury

Ruční faktura se zadává po položkách (popis, množství, MJ, cena/MJ, sazba DPH).
Základ, DPH i celkovou částku počítá vždy server z odeslaných řádků — součty
ve formuláři jsou jen náhled. Server odmítne fakturu bez klienta, bez položek,
s nulovou částkou nebo s číslem, které už existuje (`accounting_invoices` má
unikátní index na dvojici typ + číslo).

### PDF a odeslání

PDF vykresluje `src/pdf.js` přes headless Chromium ze šablony
`views/pdf/invoice.ejs`. Variabilní symbol počítá `invoiceVs()` v
`src/series-format.js` — z čísla vezme posledních 10 číslic, aby se vešel do
limitu banky a zároveň zůstal podřetězcem čísla faktury, na kterém stojí
auto-párování plateb.

Odeslání e-mailem předvyplní adresu z faktury, jinak ji dohledá v CRM (kontakt →
firma → IČO). Každý pokus se zapíše do `invoice_emails` včetně chyby, odeslané
PDF se archivuje do `data/pdfs` a cesta se uloží do `pdf_path`.

### Hlídání splatnosti a upomínky

`checkOverdueInvoices()` v `src/healthcheck-worker.js` běží každých 5 minut a:

1. `markOverdueInvoices()` — přepne prošlé faktury z „Nezaplacena" na „Po splatnosti",
2. `prepareReminders()` — podle prahů v `company_settings.reminder_levels`
   (výchozí 3 / 14 / 30 dní) založí upomínku ve stavu `ceka`; vždy jen nejvyšší
   dosažený stupeň, ať klientovi nechodí tři naráz,
3. jednou denně pošle souhrn do nastavených notifikačních kanálů.

**Upomínky se nikdy neodesílají automaticky.** Worker je jen připraví do fronty na
`/ucetnictvi/upominky`, odeslání spouští člověk. Tři stupně důrazu (upozornění →
upomínka → předžalobní výzva) definuje `sendReminderEmail()` v `src/email.js`.

---

## Účtenky (`src/routes/receipts.js`)

| Route | Popis |
|---|---|
| `GET /ucetnictvi/uctenky` | Seznam účtenek |
| `GET /ucetnictvi/uctenky/:id` | Detail účtenky s dokladem a editací |
| `POST /ucetnictvi/uctenky/analyze-pdf` | AI vytěžení z fotky nebo PDF (Claude) |
| `POST /ucetnictvi/uctenky/vytvorit` | Vytvořit účtenku (multipart — veze i doklad) |
| `POST /ucetnictvi/uctenky/:id/upravit` | Ruční úprava dat, volitelně výměna dokladu |
| `POST /ucetnictvi/uctenky/:id/priloha` | Dofotit / nahradit doklad u existující účtenky |
| `POST /ucetnictvi/uctenky/:id/stav` | Změnit stav (Nezaúčtována/Zaúčtována/Storno) |
| `POST /ucetnictvi/uctenky/:id/smazat` | Smazat účtenku i její doklad |
| `POST /ucetnictvi/uctenky/pohoda-xml` | POHODA XML (Pokladna + Ostatní závazky) |
| `GET /ucetnictvi/uctenky/export.csv` | CSV export |

AI analýza extrahuje z obrázku/PDF: prodejce, datum, celkovou částku, DPH, kategorii.

Kategorie: Kancelář, Cestovné, PHM, Stravné, Reprezentace, IT & Software, Marketing,
Provoz, Ostatní.

Každá účtenka nese **formu úhrady** (Hotovost / Karta / Převodem) a příznak
**nároku na odpočet DPH**. Obojí řídí, kam a jak doklad odejde do POHODY —
viz „Export do POHODY“ níže.

Modal v seznamu účtenku **jen zakládá** (upload → vytěžení → kontrola polí).
Úpravy má detail: vlevo doklad ve velkém, vpravo formulář. `/:id/upravit`
proto rozlišuje klienta — formulář z detailu (`Accept: text/html`) dostane
přesměrování zpět na detail, `fetch` z modalu JSON.

---

## Export do POHODY (`src/pohoda.js`)

Jeden generátor obsluhuje všechny doklady; balíček `dat:dataPack` nese IČO
účetní jednotky z Nastavení → Firma, bez něj POHODA import odmítne.

| Doklad | Agenda v POHODĚ | Element |
|---|---|---|
| Vydaná faktura | Vydané faktury | `inv:invoice` / `issuedInvoice` |
| Přijatá faktura | Přijaté faktury | `inv:invoice` / `receivedInvoice` |
| Účtenka placená hotově | Pokladna (výdaj) | `vou:voucher` / `expense` |
| Účtenka placená kartou nebo převodem | Ostatní závazky | `inv:invoice` / `commitment` |

**Kartou zaplacená účtenka do pokladny nepatří** — peníze odešly z účtu, ne
z pokladní hotovosti. Účetní takové doklady z pokladny ručně vyhazovala
a zakládala mezi ostatní závazky, tak to dělá export rovnou za ni. Rozřazení
řídí sloupec `receipts.payment_method`, spočítat ho umí i `isCashReceipt()`.

**Evidenční čísla přijatých dokladů přiděluje POHODA** z vlastních číselných
řad. Kdybychom poslali `numberRequested` s cizím číslem, import padne na
duplicitě. Číslo od dodavatele proto jde do `originalDocument` (pole *Doklad*)
a jeho číslice do `symVar`, aby se dala spárovat platba. U vydaných faktur
je naopak autoritou naše řada, takže číslo posíláme.

**Bez nároku na odpočet DPH** (`vat_deductible = false`, u kategorie
Reprezentace vynuceně — § 72 odst. 4 ZDPH) jde do balíčku celá částka včetně
DPH jako `priceNone`, bez `dateTax` a s členěním DPH `nonSubsume`
(„Nezahrnovat do DPH“). Předkontaci takového dokladu lze přebít nastavením
*Předkontace bez nároku na odpočet DPH* (typicky 513).

Doklady ve stavu Storno se do balíčku nedostanou. Po exportu se zapíše
`pohoda_exported_at` — seznam pak u dokladu ukáže datum a hromadná lišta
varuje, že opakovaný import doklad v POHODĚ založí znovu.

Předkontace se berou v pořadí: předkontace z dokladu → předkontace
z Nastavení → Firma → nic (POHODA nastaví „Nevím“).

---

## Doklady k účtenkám a fakturám (`src/attachments.js`, `src/routes/documents.js`)

Vytěžený soubor se archivuje, ne zahazuje — účetní ho při kontrole potřebuje
vidět. Ukládá se do `data/media/` a v DB drží název + typ + velikost
(`attachment_path`, `attachment_mime`, `attachment_size`).

**Zmenšování.** Fotka z mobilu má 4–12 MB, archivovat ji v plné velikosti nemá
smysl. Zmenšuje se dvakrát:

1. **v prohlížeči** (`public/js/doklad-foto.js`) — přes canvas, ještě před
   nahráním, takže se velký soubor vůbec neposílá po síti a Claude vytěžuje
   stejný odlehčený obrázek, který se pak uloží,
2. **na serveru** (`src/attachments.js`) — pojistka pro soubory, které přijdou
   odjinud (import z Google Disku, API, prohlížeč bez canvasu). Používá `sharp`,
   který je nepovinný: když v runtime chybí, soubor se uloží tak, jak přišel.

Obě vrstvy jedou stejný žebřík (2400 px @ q78 → 1400 px @ q50) a končí, jakmile
se obrázek vejde pod 5 MB. Delší strana neklesne pod 1400 px, aby zůstalo
čitelné drobné písmo na paragonu. Server navíc srovná fotku podle EXIF orientace
a odstraní metadata. Malý PNG/WebP sken pod 1,5 MB se nepřekóduje — převod do
JPEGu by u drobného písma jen přidal artefakty.

PDF se nepřepočítává (je to už komprimovaný formát) a projde do stropu uploadu
20 MB — vícestránkový sken od účetní přes 5 MB radši uložíme, než odmítneme.

**Servírování.** `/media/` je veřejné (profilové fotky), účtenky a faktury tam
proto nepatří: chodí přes `GET /doklady/soubor/:filename`, kam se bez přihlášení
nedostane. `?download=1` vynutí stažení místo náhledu.

**Chybějící soubor.** `markMissingAttachments()` označí řádky, jejichž
`attachment_path` na disku není, a šablony místo rozbité miniatury ukážou
„Doklad chybí" s nabídkou nahrát ho znovu. Stane se to, když se `data/media`
ztratí — záznam v DB deploy přežije, soubor bez persistent volume ne
(viz `docs/nasazeni.md`).

**Náhled.** `public/js/doklad-nahled.js` ukáže doklad v popupu nad stránkou —
obrázek s přiblížením na 100 % (drobné písmo na paragonu je jinak nečitelné),
PDF v iframu, plus stažení a otevření v novém panelu. Napojuje se deklarativně,
obsluha je delegovaná, takže funguje i na dodatečně vykreslených řádcích:

```html
<a href="/doklady/soubor/x.jpg" data-nahled
   data-nahled-nazev="x.jpg" data-nahled-typ="image/jpeg" data-nahled-velikost="384000">…</a>
```

Zapojený je v seznamu účtenek, na detailu účtenky, v přehledu přijatých faktur
(nahraná příloha) i vydaných faktur (vygenerované PDF) a na detailu přijaté
faktury.

Ctrl/Cmd+klik nechá odkaz projít do nového panelu. Obsluha běží ve fázi
capture — v přehledech visí proklik na detail na celém řádku a buňky ho brzdí
přes `stopPropagation`, do bublání by se tedy klik na miniaturu nedostal.
V nainstalované PWA se skrývá „Otevřít v novém panelu": aplikace má vlastní
úložiště cookies, takže odkaz otevřený v systémovém prohlížeči skončí na
přihlašovací stránce. Z kódu jde popup otevřít i
ručně přes `dokladNahled.open({ url, name, mime, size })` — tak se ukazuje
i doklad, který ještě není nahraný (blob URL právě vybraného souboru).

Popup má vlastní vrstvu nad `.modal-backdrop`, aby šel doklad zvětšit
i z formuláře účtenky, který sám běží v modalu. Escape zachytává ve fázi
capture — bez toho by obsluha modalů v `app.js` zavřela i rozepsaný formulář
pod náhledem.

---

## CRM (`src/routes/crm.js`)

| Route | Popis |
|---|---|
| `GET /crm/firmy` | Seznam firem |
| `GET /crm/firmy/:id` | Detail firmy (kontakty, objednávky, faktury) |
| `POST /crm/firmy/vytvorit` | Nová firma |
| `POST /crm/firmy/:id/ares` | Sync dat z ARES (obchodní rejstřík) |
| `GET /crm/kontakty` | Seznam kontaktů |
| `GET /crm/kontakty/:id` | Detail kontaktu |
| `POST /crm/kontakty/vytvorit` | Nový kontakt |

Typy firem: Zákazník, Dodavatel, Partner, Jiný. Každý kontakt může mít marketing consent per e-shop.

---

## Objednávky — Toneráček (`src/routes/toneracek.js`)

| Route | Popis |
|---|---|
| `POST /api/toneracek/orders` | Příjem objednávky (Bearer token auth) |
| `PATCH /api/toneracek/orders/:id/tracking` | Aktualizace tracking čísla |
| `GET /ucetnictvi/objednavky` | Seznam objednávek Toneráček |
| `GET /ucetnictvi/objednavky/:id` | Detail objednávky |
| `POST /ucetnictvi/objednavky/:id/stav` | Změna stavu + automatická faktura |
| `POST /ucetnictvi/objednavky/:id/poznamka` | Přidat poznámku |
| `GET /ucetnictvi/migrace-airtable` | Migrace dat z Airtable (jednorázové) |

Stavy: Přijata → Ve zpracování → Vyřízena / Stornována. Přechod do „Vyřízena" automaticky vytvoří fakturu.

---

## Multi-shop API (`src/routes/api.js`)

| Route | Popis |
|---|---|
| `POST /api/v1/orders` | Příjem objednávky (X-API-Key header) |
| `GET /api/v1/orders` | Seznam objednávek e-shopu |
| `GET /api/v1/customers` | Zákazníci e-shopu |
| `GET /api/docs` | Swagger UI (OpenAPI dokumentace) |

Každý e-shop má vlastní API klíč. Dokumentace dostupná na `/api/docs`.

---

## Push notifikace (`src/routes/push.js`)

| Route | Popis |
|---|---|
| `GET /api/push/vapid-key` | Vrátí VAPID public key pro JS |
| `POST /api/push/subscribe` | Registrace push subscription |
| `POST /api/push/unsubscribe` | Odregistrace |
| `POST /api/push/status` | Stav subscription pro aktuální zařízení |

Uživatel zapíná notifikace v `/profil`. Každý uživatel/zařízení má vlastní subscription. Při nové objednávce `sendPushToAll()` odešle notifikaci všem registrovaným.

---

## VPS Monitoring (`src/routes/monitoring.js`)

| Route | Popis |
|---|---|
| `GET /nastaveni/healthchecky` | Správa healthchecků a notifikačních kanálů |
| `POST /nastaveni/healthchecky/vytvorit` | Nový healthcheck |
| `POST /nastaveni/healthchecky/:id/toggle` | Aktivovat / deaktivovat |
| `GET /api/healthchecks/status` | Poslední výsledky pingů (JSON) |

Notifikační kanály: Discord (webhook URL), E-mail (Resend). Notifikační pravidla definují event_type + threshold → kanál.

---

## Lidé & tým (`src/routes/people.js`)

| Route | Popis |
|---|---|
| `GET /lide/tym` | Seznam uživatelů systému |
| `POST /lide/tym/vytvorit` | Nový uživatel (admin only) |
| `GET /lide/tym/:id` | Detail člena týmu — `:id` je `users.public_id` |
| `POST /lide/tym/:id` | Úprava (osobní údaje, banka, role) |
| `POST /lide/tym/:id/foto` | Upload fotky člena |
| `GET /lide/pristupy` | Přístupová matice — sekce × uživatelé |
| `POST /lide/pristupy` | Uložení matice |

V URL detailu je `public_id` (12 hex znaků), ne pořadové číslo. Staré číselné
odkazy se přesměrují na kanonickou adresu, takže záložky v prohlížeči fungují dál.

### Přístupová matice

Katalog sekcí systému žije v `src/access.js` — jeden zdroj pravdy pro matici,
levé menu i strážce rout v `src/server.js`. **Kdo přidá sekci do sidebaru,
přidá ji i do katalogu**, jinak ji matice nezná a zůstane přístupná všem.

Pravidla vyhodnocení:

- Bez uloženého záznamu platí „vidí“ — nasazení migrace nikomu nic neodebere.
- Matice umí jen ubírat: `adminOnly` sekce zůstane nedostupná i zaškrtnutá.
- Správce nikdy nepřijde o `GET /lide/pristupy`, jinak by se zamkl.
- Skrytí položky z menu nestačí — `preHandler` v `src/server.js` vrací na
  zakázané cestě 403 (`views/pages/errors/403.ejs`), a to i pro POST.

Přehled toho, co konkrétní člověk vidí, je na `/lide/tym/:id#pristupy`.

---

## Nastavení (`src/routes/settings.js`)

Vše admin-only.

| Route | Popis |
|---|---|
| `GET/POST /nastaveni/firma` | Údaje firmy (ICO, DIČ, adresa, banka, fakturační poznámka) |
| `GET/POST /nastaveni/ciselne-rady` | Číselné řady pro faktury (prefix, rok, padding) |
| `GET/POST /nastaveni/eshopy` | E-shopy + správa API klíčů |
| `GET/POST /nastaveni/ucetni-osnova` | Číselník účtů (MD/D pro předkontaci) |
| `GET /api/accounting-chart` | API: účty pro autocomplete |
| `POST /api/invoice-series/:id/next` | API: generování čísla faktury |

---

## Backend workery

### Recurring scheduler (`src/recurring.js`)
Spouští se jednou při startu serveru, pak každých 24 hodin. Prochází `recurring_invoices` se `next_run_date <= NOW()`, generuje faktury, aktualizuje `next_run_date`.

### Healthcheck worker (`src/healthcheck-worker.js`)
Pinguje registrované URL v nastaveném intervalu. Zapisuje výsledky do `healthcheck_results`. Pokud selže, spouští notifikační pravidla.

### VPS kolektor (`src/collector.js`)
Běží jako cron přímo na VPS hostu (ne v Dockeru). Sbírá: RAM, CPU, disk, swap, uptime, PostgreSQL stats, Docker kontejnery, SSL certifikáty, stáří záloh. Výstup: `latest.json` + append do `history.sqlite`.

---

## Import faktur z POHODY (`scripts/import-faktury-xlsx.js`)

Ruční import Excel exportů z POHODY do `accounting_invoices`. Soubory se
nahrají do adresáře `import/`:

| Soubor | Cíl |
|---|---|
| `FA vyd.xlsx` | `type='issued'` |
| `FA prija.xlsx` | `type='received'` |

```bash
node --env-file=.env scripts/import-faktury-xlsx.js --dry-run    # náhled
node --env-file=.env scripts/import-faktury-xlsx.js              # import
node --env-file=.env scripts/import-faktury-xlsx.js --sync-status # + srovnání úhrad
```

**Hlídání duplicit** (skript je idempotentní, lze spouštět opakovaně):

1. podle čísla dokladu (POHODA `Číslo`) proti `number`,
2. podle variabilního symbolu proti `number` — zachytí faktury, které do
   systému přitekly importem z Disku a jsou vedené pod číslem dodavatele;
   ty se sloučí do existujícího záznamu (zůstane `id` i příloha),
   s `--no-merge` se jen přeskočí,
3. kontrolní shoda dodavatel + datum + částka → jen varování do logu.

**Mapování částek:** `amount` je součet všech sazeb (`Kč 0`, `Kč snížená`,
`Kč základní`, `Kč 2 snížená`), `vat_amount` součet všech DPH sazeb.
Doklady v cizí měně mají v POHODĚ korunový ekvivalent — ukládá se ten
(`currency='CZK'`) a původní částka jde do `notes`.

**Stav:** `K likvidaci = 0` → Zaplacena (`paid_date` = datum likvidace),
jinak po splatnosti / nezaplacena podle `Splatno`. `--sync-status` srovná
stav a datum úhrady i u faktur, které v DB už jsou — POHODA je zdroj
pravdy pro platby.

XLSX čte `scripts/lib/xlsx-lite.js` (rozbalení ZIP přes `zlib` + parsování
XML), aby projekt nemusel záviset na balíčku `xlsx` s otevřenými CVE.
