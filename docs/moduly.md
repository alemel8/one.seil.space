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

## Hledání (`src/hledani.js`, `src/routes/hledani.js`)

| Route | Popis |
|---|---|
| `GET /hledat` | Výsledky hledání po skupinách (`?q=`, min. 2, max. 100 znaků) |
| `GET /api/hledat` | Totéž jako JSON pro našeptávač v liště (`public/js/hledani.js`), 5 položek na skupinu |

Pole v horní liště (`Ctrl+K` / `⌘K`) našeptává od dvou znaků (debounce
250 ms, šipky a Enter, Esc zavře; Enter bez výběru odešle na stránku),
na mobilu ho nahrazuje lupa vedoucí na stránku.
Hledá se `ILIKE '%q%'` ve skupinách Stránky (položky menu bez diakritiky),
Firmy (`name`, `city`, `country`, `ico`), Kontakty (`first_name`,
`last_name`, `email`, `phone`), Objednávky (`order_number`, jméno, `email`,
`phone`, `invoice_number`, `company`, všechny e-shopy), Vydané faktury
(`number`, `client_name`; i zálohové — ty seznam neukáže, proto štítek
„Zálohová“), Přijaté faktury (`number`, `supplier`), Účtenky (`vendor`,
`number`, `notes`), Projekty (název projektu i firmy), Úkoly (`code`,
`summary` — jako seznam, všem všechny) a Tým (jméno, e-mail).

**Smlouva „hledání = seznam“:** skupina hledá přesně v těch sloupcích, ve
kterých filtruje seznam, na který odkazuje „Všechny v seznamu →“. Kdo přidá
sloupec do `SKUPINY`, přidá ho i do `?q=` filtru seznamu (a naopak), jinak
hledání najde, co seznam neukáže.

**Práva:** `/hledat` není v katalogu přístupové matice — nemá vlastní data.
Každá skupina má klíč položky z `ACCESS_SECTIONS` (`pravo`) a dotáže se jen
tomu, kdo na její seznam smí (`isAllowed`); modul při startu odmítne klíč
mimo katalog, protože neznámý klíč by skupinu otevřel všem. `%`, `_` a `\`
v dotazu se escapují, NUL se odstraní, pod dva znaky se do databáze nejde.

**Výkon:** sekvenční čtení bez indexu, nejvýš 10 tabulek paralelně
s limitem 10 na skupinu a bez `COUNT(*)` — při objemech SEIL desítky ms.
Trigramové indexy (`pg_trgm`) až kdyby data nebo logy ukázaly potřebu;
`CREATE EXTENSION` chce práva na databázi a migrace běží při startu.

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

**Párování plateb.** Webhook `POST /api/webhook/banka` páruje jen příchozí
platby, podle variabilního symbolu: nejdřív jako podřetězec čísla faktury
nebo zálohovky, a když nic, podle čísla objednávky (zálohovka e-shopu se platí
pod ním). Faktury k dobírce se podle čísla nepárují — peníze posílá Zásilkovna
souhrnně pod vlastním symbolem — a stornované doklady taky ne. Páruje se jen
jednoznačná shoda: když symbol sedí na víc dokladů (20260042, ZF-20260042
i FV-2026-0042 mají týž VS), platba zůstane nespárovaná a rozhodne obsluha —
ani shoda částky nerozhoduje (`vyberDokladKPlatbe()` v `src/routes/accounting.js`).
Den úhrady (`paid_date`) je den pohybu na účtu (`transaction_date`), i při
ručním spárování (`zaplatDokladPohybem()`) — u zálohovky z něj vystavená
faktura bere DUZP.

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

### Faktura k objednávce e-shopu

Vzniká přepnutím objednávky na „Vyřízena" (nebo záchrannou akcí
`POST /ucetnictvi/objednavky/:id/generovat-fakturu`) v `generateInvoiceForOrder()`. Stav, den úhrady a DUZP (`taxable_date`) určuje
`uhradaFakturyObjednavky()` v `src/danovy-doklad.js`:

| Platba | Stav | `paid_date` = `taxable_date` |
|---|---|---|
| Platba kartou | Zaplacena | pražský den `shop_orders.paid_at`; bez něj (zaplaceno před migrací 039) pražský den založení objednávky, je-li ve stavu „Zaplaceno" nebo „Vyřízena"; jinak den vystavení |
| Bankovní převod | Zaplacena | den úhrady zálohové faktury |
| Dobírka | **Nezaplacena** | `paid_date` prázdné, DUZP = den vystavení (plnění = odeslání) |
| cokoli jiného | Zaplacena | den vystavení (dosavadní chování) |

**Datum na dokladu není den vystavení.** Faktura vzniká dny po platbě, ale daňový
doklad musí nést den přijetí úplaty (§ 29 odst. 1 písm. h ZDPH). Dřív dostala
karta zaplacená 1. 9. na fakturu „zaplaceno 7. 9.". Data dokladů k objednávce
— vystavení, splatnost, DUZP i rok a měsíc v čísle z řady — se počítají
v pražském čase (`src/prazsky-cas.js`): kontejner běží v UTC a platba ve 0:30
by jinak spadla do předchozího dne. Výjimkou je přepnutí na „Po splatnosti"
(`CURRENT_DATE` databáze) — proběhne o hodinu dvě později, na dokladu to nic
nemění.

**Karta zaplacená před migrací 039** nemá `paid_at`. Karta se platí rovnou
v pokladně, takže za den přijetí úplaty se bere pražský den založení objednávky
— jen u objednávky vedené jako zaplacená („Zaplaceno", „Vyřízena"). Počítá se
při vystavení (`denPlatbyKartou()`), do databáze se nic nedopisuje.

**Den úhrady zálohovky je den, kdy přišly peníze.** Automatické i ruční
spárování s bankou ho bere z pohybu na účtu; ruční změna stavu na „Zaplacena"
ho chce ve formuláři (předvyplněný už zapsaným dnem úhrady, jinak pražským
dneškem; bez něj pražský dnešek, ne `CURRENT_DATE`). Den kliknutí by posunul
DUZP vystavené faktury, klidně do jiného měsíce DPH.

**Potvrdil majitel 20. 10. 2026:** u karty a převodu se den přijetí úplaty
tiskne pod nadpisem „Datum uskutečnění zdanitelného plnění"; DUZP dobírky je
den vystavení faktury (ne předání dopravci ani doručení); starší karty bez
`paid_at` berou den založení objednávky. Měnit jen po dohodě s účetní.

**DUZP jde opravit** v úpravě vydané faktury (pole DUZP, prázdné = datum
vystavení). Je to cesta pro karty zaplacené jindy než v den založení objednávky
(před migrací 039) a pro potvrzení platby, které dorazilo po půlnoci.

**Dobírka zaplacená není.** Zákazník platí dopravci při převzetí; „zaplacená"
faktura by u nevyzvednuté zásilky zůstala bez peněz. Za zaplacenou ji označí
obsluha (změnou stavu s datem úhrady), až Zásilkovna peníze pošle — automatické
párování podle čísla faktury ji vynechává.

Číslo vystavené faktury se zapíše do `shop_orders.invoice_number`. Do vystavení
je sloupec prázdný; dřív v něm od založení objednávky leželo vymyšlené
`FV-<rok>-<objednávka>`. E-shopu (`GET /api/toneracek/orders`, `…/by-number`)
jde v `invoice_number` číslo vydané faktury z `accounting_invoices`, ne obsah
sloupce — u starších objednávek by to bylo to vymyšlené. Bez vydané faktury
prázdné.

### PDF a odeslání

PDF vykresluje `src/pdf.js` přes headless Chromium ze šablony
`views/pdf/invoice.ejs`. Variabilní symbol počítá `invoiceVs()` v
`src/series-format.js` — z čísla vezme posledních 10 číslic, aby se vešel do
limitu banky a zároveň zůstal podřetězcem čísla faktury, na kterém stojí
auto-párování plateb.

Co doklad říká o úhradě, rozhoduje `zobrazeniUhrady()` v `src/danovy-doklad.js`
— jedno místo pro šablonu i e-mail:

- **Vydaná faktura vždy tiskne „Datum uskutečnění zdanitelného plnění"** —
  `taxable_date`, bez něj datum vystavení. Zálohová faktura ho netiskne, daňovým
  dokladem není.
- **Zaplacená** má razítko ZAPLACENO a žádné platební instrukce ani QR kód.
- **Dobírka** (podle `payment_method` objednávky, faktura ho nenese) nemá razítko
  ZAPLACENO ani PO SPLATNOSTI, číslo účtu ani QR — místo nich štítek DOBÍRKA,
  splatnost „Při převzetí" (ne datum +14 dní z databáze, to slouží jen
  hlídání nespárovaných dobírek), součet „K úhradě dobírkou" a „Úhrada
  dobírkou při převzetí zásilky". Volající proto předává `paymentMethod`.
- „Forma platby" je způsob platby objednávky; u faktur mimo e-shop „Bankovní převod".
- Data tiskne `ceskeDatum()`, ne `toLocaleDateString()` — nezávisle na pásmu
  procesu. Totéž splatnost v e-mailu a data v detailu faktury v administraci.

`renderInvoiceHtml()` vrací totéž HTML bez prohlížeče — na něm stojí test
`test/danovy-doklad.test.js`.

Odeslání e-mailem předvyplní adresu z faktury, jinak ji dohledá v CRM (kontakt →
firma → IČO). Každý pokus se zapíše do `invoice_emails` včetně chyby, odeslané
PDF se archivuje do `data/pdfs` a cesta se uloží do `pdf_path`. E-mail říká
o úhradě totéž co PDF: platební údaje jen tam, kde je má i PDF, zaplacená faktura
není „k úhradě" a dobírka nemá splatnost, ale „K úhradě při převzetí".

CSV export vydaných faktur má DUZP v posledním sloupci (bez `taxable_date` datum
vystavení), ať dosavadní sloupce zůstaly na svých místech.

### Hlídání splatnosti a upomínky

`checkOverdueInvoices()` v `src/healthcheck-worker.js` běží každých 5 minut a:

1. `markOverdueInvoices()` — přepne prošlé faktury z „Nezaplacena" na „Po splatnosti",
2. `prepareReminders()` — podle prahů v `company_settings.reminder_levels`
   (výchozí 3 / 14 / 30 dní) založí upomínku ve stavu `ceka`; vždy jen nejvyšší
   dosažený stupeň, ať klientovi nechodí tři naráz. **Faktury k dobírce
   vynechá** — zákazník platí dopravci a peníze posílá Zásilkovna, takže „po
   splatnosti" znamená nespárovanou dobírku, ne dluh zákazníka,
3. jednou denně pošle souhrn do nastavených notifikačních kanálů — dobírky v něm
   zůstávají, ať je obsluha spáruje.

**Upomínky se nikdy neodesílají automaticky.** Worker je jen připraví do fronty na
`/ucetnictvi/upominky`, odeslání spouští člověk. Tři stupně důrazu (upozornění →
upomínka → předžalobní výzva) definuje `sendReminderEmail()` v `src/email.js`.
**Upomínku k dobírce nejde poslat ani ručně** — detail faktury místo tlačítka
radí spárovat ji s platbou od Zásilkovny a `deliverReminder()` ji odmítne
a důvod zapíše do historie odeslání.

### Lhůta pro daňový doklad

Faktura k objednávce vzniká jen ručním vyřízením, ale povinnost přiznat daň
vzniká dnem přijetí úplaty (u dobírky plněním) a doklad se má vystavit do
15 dnů (§ 28 odst. 8 ZDPH). `checkUninvoicedPaidOrders()` v
`src/healthcheck-worker.js` proto jednou za pražský den po 8:00 pošle správcům
push o objednávkách bez vydané faktury (a ne stornovaných), u kterých lhůta
běží 10 dní a víc (zbývá nejvýš pět). Den, od kterého běží, určuje
`denVznikuPovinnosti()` v `src/danovy-doklad.js` podle způsobu platby — tytéž
dny, které jdou na fakturu:

| Platba | Lhůta běží od |
|---|---|
| Platba kartou | pražského dne `paid_at`; bez něj (před migrací 039) pražského dne založení, je-li objednávka „Zaplaceno" nebo „Vyřízena". Objednávky přenesené z Airtable (`id` začíná `rec`) se takhle nehlídají — jsou z doby před spuštěním e-shopu |
| Bankovní převod | dne úhrady zálohové faktury |
| Dobírka | pražského dne `warehouse_sent_at` — ranní expedice ji do skladu pošle sama, fakturu vystaví až „Vyřízena" |

U každé objednávky uvede, do kdy lhůta běží nebo kdy uplynula. Dedupe je řádek
v `notification_log` (`faktura_lhuta`, klíč = pražské datum). Jen interní push
— zákazník ani sklad nic nedostanou.

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

**`dateTax` vydané faktury je `taxable_date`**, ne datum vystavení — do přiznání
musí jít tentýž DUZP, který tiskne PDF (karta zaplacená 30. 9. s fakturou
z 7. 10. patří do září). Bez `taxable_date` (starší a ruční doklady) zůstává
datum vystavení. `date` a `dateAccounting` nesou dál datum vystavení.

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

**Servírování.** `/media/` je za přihlášením — dřív veřejné nebylo záměrem, ale
skutečností: mířilo do stejného adresáře jako doklady, takže kdo znal název
souboru, stáhl cizí paragon bez přihlášení. Profilové fotky, kvůli kterým to
veřejné bylo, se zobrazují jen na stránkách za přihlášením, takže uzavření nic
nerozbilo.

Soubory chodí dvěma cestami:

| Cesta | Kdo se dostane | K čemu |
|---|---|---|
| `GET /doklady/soubor/:filename` | kdokoli přihlášený | účtenky a faktury |
| `GET /doklady/priloha/:id` | rozhoduje se podle záznamu v DB | mzdy, dokumenty, přílohy úkolů |

Druhá cesta je nutná proto, že u výplatní pásky nestačí „je přihlášen" — jeden
zaměstnanec by dosáhl na pásku druhého. Mzdové a osobní přílohy dostane jen
správce nebo vlastník.

`?download=1` vynutí stažení místo náhledu. Inline se otevírá jen PDF a rastrové
obrázky; XML, ZIP, HTML i SVG jdou vždy ke stažení s `X-Content-Type-Options:
nosniff`, takže archivní režim může brát libovolný typ souboru.

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
| `GET /api/toneracek/orders/by-number/:n` | Detail objednávky (autorizace přes `?email=`) |
| `PATCH /api/toneracek/orders/:id/payment-status` | Stav platby ze Stripe webhooků |
| `PATCH /api/toneracek/orders/:id/payment-method` | Změna způsobu platby po neúspěšné kartě |
| `GET /api/toneracek/orders/:id/payment-details` | Variabilní symbol, účet a zálohová faktura pro e-shop |
| `PATCH /api/toneracek/orders/:id/tracking` | Aktualizace tracking čísla |
| `GET /ucetnictvi/objednavky` | Seznam objednávek Toneráček |
| `GET /ucetnictvi/objednavky/:id` | Detail objednávky |
| `POST /ucetnictvi/objednavky/:id/stav` | Změna stavu + automatická faktura |
| `POST /ucetnictvi/objednavky/:id/poznamka` | Přidat poznámku |
| `GET /ucetnictvi/objednavky/:id/stitek` | Štítek Zásilkovny v PDF (stahuje se z Packety při každém načtení) |
| `POST /ucetnictvi/objednavky/expedice` | Ruční spuštění expedice do skladu |
| `POST /ucetnictvi/objednavky/:id/sklad` | Označit / odznačit odeslání do skladu |
| `GET /ucetnictvi/migrace` | Migrace dat z Airtable (jednorázové) |

Stavy v administraci: Přijata → Vyřízena / Stornována. Přechod do „Vyřízena"
automaticky vytvoří fakturu (pravidla viz *Faktura k objednávce e-shopu*)
a pošle ji zákazníkovi; u dobírky PDF i e-mail říkají, že se platí při
převzetí. Do `status` píše i e-shop („Čeká na platbu", „Zaplaceno", „Platba
se nezdařila"), takže sloupec obsahuje víc hodnot, než nabízí formulář.

První „Zaplaceno" — z `PATCH …/payment-status`, z `PATCH …/payment-method`
nebo rovnou při založení objednávky — zapíše do `shop_orders.paid_at` okamžik
platby (`COALESCE`, opakovaný webhook ho nepřepíše) — faktura z něj bere den
přijetí úplaty. `POST /api/toneracek/orders` vrací `invoiceNumber` prázdné:
faktura v tu chvíli neexistuje, číslo se do objednávky zapíše až při vystavení.
`GET /api/toneracek/orders` a `…/by-number` vrací v `invoice_number` číslo
vydané faktury, bez ní prázdné.

Od migrace 042 nese objednávka i **zdroj** (první a poslední dotyk: UTM,
druh a hodnota click-id, hostitel referreru, vstupní stránka, čas, kategorie
souhlasu — sloupce `*_first`, `*_last`, `attribution_consent`) a položka
**nákupní cenu** (`cost_price`, `cost_price_vat_included`). Obojí přichází
v těle `POST …/orders` jako nepovinné `marketing` a `items[].costPrice`
(kontrakt v [api.md](api.md)); čistí je sdílený `src/atribuce-objednavky.js`
(bez nich výchozí `''` a `NULL`, nikdy 400) a obě order API ho používají
stejně. Nákupní cena se e-shopu nikdy nevrací — `by-number` vybírá sloupce
položek výslovně. Na těchto datech staví sekce Marketing (PNO, ROAS, marže
po kanálech); její tabulky popisuje [databaze.md](databaze.md#marketing).

### Ranní expedice do skladu

Každý všední den po šesté hodině pražského času odejde skladu jeden e-mail se
zaplacenými objednávkami, které ještě nedostal, a se štítky Zásilkovny
v příloze. Data žijí v migraci 037 (`shop_orders.warehouse_sent_at`,
`warehouse_dispatches`, `shops.warehouse_email`), logiku má `src/expedice.js`,
adresu skladu záložka *Expedice do skladu* v detailu e-shopu. Tentýž formulář drží i adresu pro
skrytou kopii (`shops.warehouse_email_bcc`, migrace 038) — kopie chodí skrytě,
aby sklad neodpovídal i tomu, kdo zásilky nevyřizuje, a s `EMAIL_BCC` nemá nic
společného: to je kopie zákaznické pošty.

Čtyři pravidla, na kterých to stojí:

- **Zaplaceno se nepozná ze `shop_orders.status` samotného.** U karty platí
  „Zaplaceno"/„Vyřízena" nebo vyplněný tracking (e-shop podává balík až po
  potvrzení Stripem, a obsluha může stav v administraci přepsat). U převodu
  jedině zálohová faktura ve stavu „Zaplacena" — tracking u převodu nic
  neznamená, protože e-shop podá balík i nezaplacené objednávce, když zákazník
  po neúspěšné kartě přepne na převod. Dobírka jde vždy, balík má od založení.
- **Jeden běh na e-shop a pražský den hlídá unikátní index, ne cooldown.**
  Druhý index dovolí nejvýš jeden rozběhnutý běh, takže se automat a ruční
  spuštění nikdy nepotkají.
- **Pozastavená objednávka se nikdy nerazítkuje.** Když chybí výdejní místo,
  balík se nepodaří podat nebo štítek stáhnout, objednávka do e-mailu nejde,
  dostane důvod do `warehouse_hold_reason` a správci push (jednou za sedm dní
  na objednávku). Zbytek expedice odejde normálně.
- **Pořadí zápisů se nemění.** Razítko na objednávkách vzniká *před* odesláním
  a `email_sent_at` hned po něm. Kdyby se to obrátilo, pád procesu mezi
  odesláním a zápisem (deploy v 06:02) by skladu poslal totéž podruhé.

Kód dodavatele, podle kterého sklad vychystává, posílá e-shop v položce
objednávky (`supplierCode` → `shop_order_items.supplier_code`). Když chybí,
řádek vytiskne interní SKU s poznámkou — `sku` **není** kód dodavatele.

---

## Marketing (`src/routes/marketing.js`, `src/marketing/`)

Přehled účinnosti reklamy po e-shopech: tržby bez DPH z vlastních objednávek
(zdroj pravdy), náklady stažené z reklamních platforem nebo zadané ručně,
PNO, ROAS, cena za objednávku, marže a zisk po reklamě, kanály podle zdroje
objednávky, cesta zákazníka z GA4, organika ze Search Console, stav položek
v Merchant Center a statistiky e-shopu (hledání bez výsledku, opuštěné košíky).
Všechno per e-shop (`?eshop=<slug>`, výchozí Toneráček), nikdy se nemíchá.

| Route | Popis |
|---|---|
| `GET /marketing` | Přehled za období (`?obdobi=tento-mesic\|minuly-mesic\|30-dni\|vlastni&od=&do=`) |
| `GET /marketing/naklady` | Ruční náklady e-shopu (platformy bez API, období před napojením) |
| `POST /marketing/naklady/vytvorit` | Založí ruční náklad (bez DPH, rozpočítá se po dnech) |
| `POST /marketing/naklady/:id/smazat` | Smaže ruční náklad — jen vlastního e-shopu |
| `GET /marketing/sync` | Napojené platformy, poslední úspěch, chyby, posledních 50 běhů |
| `POST /marketing/sync/spustit` | Ruční stažení (jen správce — čerpá kvóty API); `platform=vse` nebo jedna |
| `POST /nastaveni/eshopy/:id/marketing` | Odhad marže a práh PNO e-shopu (jen správce; záložka *Marketing* v detailu e-shopu) |
| `POST /nastaveni/eshopy/:id/marketing/zdroj` | Napojení platformy: aktivní, ID, od kdy, token (jen správce) |
| `POST /nastaveni/eshopy/:id/marketing/zdroj/:platform/overit` | Zkusí platformu zavolat a výsledek ukáže na záložce *Marketing* |

**Definice čísel** jsou na jednom místě, v hlavičce `src/marketing/kpi.js`:
tržby = Σ `total_price` / 1,21 bez stavů Stornována a Platba se nezdařila
(Čeká na platbu se počítá, storno ji zpětně vyřadí; vedle toho „z toho
zaplaceno“); náklady bez DPH = denní součty `marketing_daily_stats`
(`segment_kind = ''`) + ruční náklady rozpočítané na překryv s obdobím;
PNO = náklady / tržby × 100; ROAS = tržby / náklady; CPA = náklady / objednávky;
marže z `shop_order_items.cost_price`, bez ní odhadem `shops.marketing_margin_pct`;
zisk = marže − náklady; ROI = zisk / náklady. Kanál objednávky je poslední
dotyk (`kanalObjednavky`: click-id → placené médium → zdroj → referrer →
přímý; bez `touch_last_at` „neznámý“). Konverze hlášené platformou se
ukazují jen k porovnání — do ±10 % sedí, do ±25 % varování, dál chyba.

Období se počítá řetězcově v pražském čase (`src/marketing/obdobi.js`) —
`new Date(y, m, 0).toISOString()` pod `TZ=Europe/Prague` vrací o den míň.

**Napojení platforem** (`src/marketing/zdroje.js`, tabulka `marketing_sources`):
Google (GA4, Google Ads, Search Console, Merchant Center) přes firemní service
account z `GOOGLE_SERVICE_ACCOUNT_JSON` — e-shop si uloží jen ID a jeho e-mail
přidá jako čtenáře; Sklik (API Fénix, zapisuje i Zboží.cz), Heureka a Meta mají
token, který leží v databázi šifrovaný AES-256-GCM klíčem `MARKETING_SECRETS_KEY`
(`src/marketing/tajemstvi.js`) a ukazuje se jen otiskem; platforma `eshop`
čte `{url}/api/marketing/statistika` s `x-webhook-secret` (Toneráček
`SHOP_WEBHOOK_SECRET`, ostatní `shops.webhook_secret`). Čisté moduly
(`obdobi`, `normalizace`, `http`, `tajemstvi`, `sync-pravidla`, `kpi`,
`prehled`) mají testy bez databáze (`test/marketing-*.test.js`); stránky
testují `test/marketing-route.test.js` a `test/marketing-nastaveni.test.js`
proti lokální databázi.

## API e-shopů

`/api/toneracek/*` (`src/routes/toneracek.js`, klíč `TONERACEK_API_KEY`)
a `/api/eshop/*` (`src/routes/eshop-api.js`, klíč z detailu e-shopu →
*Napojení e-shopu*), popis v [api.md](api.md). Starší multi-shop API
`/api/v1` (`src/routes/api.js`, hlavička `X-API-Key`) a Swagger na
`/api/docs` byly 26. 10. 2026 odstraněny — nikdo je nepoužíval a klíč
z `api_keys` otevíral všechny kontakty v CRM.

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

Přehled toho, co konkrétní člověk vidí, je na `/lide/tym/:id?tab=pristupy`.

### Detail člena — serverové záložky

Detail běží na `?tab=` se serverovým renderem (vzor z `views/pages/projects/detail.ejs`),
ne na klientském přepínání. Každá záložka si nese vlastní dotaz, takže se
načítá jen ta otevřená, a počty do popisků jdou spočítat jen na serveru.

| Záložka | Obsah |
|---|---|
| `detail`, `banka` | osobní údaje, bankovní spojení |
| `ekonomika` | příjmy − výdaje − platby = zůstatek + poslední pohyby ze všech tří zdrojů |
| `podklady` | fakturační podklady s vazbou na vydanou fakturu |
| `mzdy` | mzdové listy; měsíc se dvěma listy je označený |
| `vydaje` | platby mimo mzdu (zálohy, proplacené nákupy) |
| `dokumenty` | osobní a smluvní dokumenty |

**Pozor:** `POST /lide/tym/:id` přepisuje všech šestnáct sloupců uživatele
naráz. Nové formuláře proto **musí mít vlastní routu**
(`/lide/tym/:id/platby/vytvorit`, `/dokumenty/vytvorit`, …), jinak osobní
údaje vynulují.

### Osobní účet

Dotazy nad ním jsou v `src/hr.js`. Airtable to nepojmenoval, ale je to běžný
účet jednoho člověka: co se za jeho práci vyfakturovalo, minus co se mu
vyplatilo. Pozor na dvě různá čísla se stejným jménem — do zůstatku patří
`paid_total + cash_paid` (co odešlo z účtu), do nákladů firmy `company_cost`.

Zůstatek se ukazuje jen tomu, kdo má fakturační podklady. U dohodáře žádná
příjmová strana není a rozdíl by byl jen záporným součtem výplat; místo něj
je odpracovaný čas a odměna.

Záložka **Hodiny** staví naměřený čas vedle hodin ve mzdě za tentýž měsíc.
Rozdíl se **nedopočítává na nulu** — u Heříka chybí měření za 5–7/2025
a naopak 4–6/2026 není vyúčtované, a schovat to by znamenalo tvářit se, že
evidence sedí, když nesedí.

---

## Práce — úkoly a stopky (`src/prace.js`, `src/routes/work.js`)

Jediná nesprávcovská sekce v menu: kdo si měří čas, musí se ke svým úkolům
dostat. Že vidí jen svoje, řeší routy, ne přístupová matice — ta umí jen
„vidí / nevidí URL". Parametr osoby se běžnému uživateli ignoruje, místo aby
padalo 403.

**Zdrojem pravdy o běžících stopkách je řádek v databázi s prázdným koncem.**
Žádný stav v prohlížeči: zavření okna ani restart telefonu měření neztratí
a napříč zařízeními vidí člověk totéž. Start i stop jsou obyčejné formuláře
s přesměrováním, prohlížeč jen dopočítává vteřiny z času spuštění
(`public/js/stopky.js`, ~40 řádků).

Že běží nejvýš jedny stopky, hlídá částečný unikátní index
`time_entries_running_idx`. Spuštění jiného úkolu to předchozí samo zastaví —
jinak by INSERT spadl na indexu a uživatel by viděl jen chybu.

Běžící měření se veze na `request.user`, takže pilulka v topbaru je vidět na
každé stránce, aniž by ji musela předávat každá routa.

**Zapomenuté stopky se samy neukončují.** Vymyšlený čas ve výkazu je horší než
chybějící. Měření delší než deset hodin se nabídne k dořešení s konkrétním
časem. Není to teorie: v datech z Airtable je pět měsíců, kde běželo jediné
měření dvacet i třicet hodin.

Výkaz ukazuje čas po dnech i po úkolech a před uzávěrkou upozorní na to, co je
potřeba dořešit: běžící měření, nulové délky a záznamy bez úkolu, které nepůjde
vyfakturovat. Nulová délka je legitimní hodnota, ne chyba — 56 z 366
importovaných měření má shodný začátek i konec.

---

## Náklady firmy (`src/finance.js`)

Jediné místo, kde se sčítají náklady. Dokud šlo jen o součet přijatých faktur,
vešel se vzorec do šablony; se čtyřmi zdroji by se kopie rozešly.

| Zdroj | Do nákladů |
|---|---|
| přijaté faktury | ano |
| účtenky | ano — dosud se nepočítaly vůbec, takže zisk byl nadhodnocený |
| mzdy (`company_cost`) | ano |
| proplacené nákupy zaměstnancům | ano |
| **zálohy zaměstnanci** | **ne** — je to pohledávka (335), ne náklad |

Do cashflow se nepřidává nic: mzdy i zálohy z účtu už odešly a banka je vidí,
takže by se počítaly dvakrát. Mzda se řadí do měsíce, **za který je**, ne podle
data výplaty.

Konzumuje to `/ucetnictvi/prehled` (`src/routes/accounting.js`) i domovská
stránka (`src/routes/dashboard.js`). Dlaždice Náklady si nese popisek, z čeho
se skládá — bez něj by přehled lhal.

---

## Přílohy k záznamům

`src/attachments.js` má dvě vrstvy: práci se soubory (komprese, MIME, mazání)
a nad ní pár funkcí nad tabulkou `attachments` (`loadAttachments`,
`addAttachment`, `removeAttachment`). `ATTACHMENT_OWNERS` je jediné místo, kde
se překládá název entity na FK sloupec.

**Archivní režim** — `saveAttachment(buf, mime, base, { archive: true })`
přijme XML, DOCX, XLSX i ZIP, neprožene je kompresí a nepustí se do formulářů
dokladů (tam má být sken). Potřebuje ho import: mzdové balíčky obsahují XML
pro e-podání na ČSSZ.

**Servírování** — `/doklady/soubor/:filename` pro účtenky a faktury (stačí být
přihlášen) a `/doklady/priloha/:id` pro personální přílohy, kde se autorizuje
**podle záznamu, ne podle názvu souboru**: mzdy a osobní dokumenty vidí jen
správce nebo jejich vlastník.

`data/media` **není veřejná cesta** — `/media` bylo do srpna 2026 v seznamu
veřejných cest, takže kdo znal název souboru, stáhl si doklad bez přihlášení.

---

## Migrace z Airtable (`scripts/migrate-airtable-hr.js`)

Jednorázový přenos personální agendy. Jádro převodu je v `src/airtable-map.js`
jako čisté funkce, takže se dá otestovat na skutečných odpovědích z API
(`test/fixtures/airtable.json`).

Přenáší dvě základny. Fáze první (`podklady`, `mzdy`, `extra`, `dokumenty`)
patří Trojkovi a potřebují `--trojek=<e-mail>`; fáze druhé (`ukoly`, `cas`,
`payroll`) si uživatele najdou samy podle e-mailu v tabulce Users.

```
npm run import:airtable -- --dry-run --trojek=luke3ova@email.cz
npm run import:airtable -- --trojek=luke3ova@email.cz
npm run import:airtable -- --jen=ukoly,cas,payroll     # jen druhá základna
npm run import:airtable -- --overit
```

Vyžaduje `AIRTABLE_API_KEY` v `.env`. **Pouštět v kontejneru**, ne lokálně
přes tunel — soubory musí přistát na persistent volume `/app/data`. Když token
k základně nemá práva, jde ji vyexportovat jinudy a skript pustit nad soubory:
`--z-souboru=<adresář>` čte `<tabulka>.json` místo API (odkazy na přílohy
v exportu ale platí jen dvě hodiny).

`--overit` kontroluje součty vázané na člověka, ne na tabulku — jakmile
v tabulkách sedí víc zaměstnanců, globální součet by hlásil chybu i u bezvadné
migrace. Trojek: příjmy 1 488 721,70 / výdaje 1 036 044 / platby 433 045,47 /
zůstatek 19 632,23. Heřík: 434,95 h / odměna 217 475 / hrubá 136 800 /
hotovost 83 500 / nákupy 29 310,78 / 366 měření / 467 úkolů.

Mzdová tabulka druhé základny mísila mzdu za odpracované hodiny s proplaceným
nákupem (tablet, sluchátka, tarif). Rozhoduje se podle dat, ne podle seznamu
názvů, a rozpadá se to do `hr_payroll_runs` a `hr_payroll_items`. U pěti měsíců
jsou dva mzdové řádky — jeden s hodinami, druhý jen s hrubou mzdou. **Nesluč
je:** součty jsou tak, jak jsou, správné a slučování by rozbilo idempotenci
(dvě `airtable_id` na jeden řádek).

Idempotence stojí na `airtable_id` u řádku i u každého souboru; opakovaný běh
nic nezdvojí a nestahuje znovu. Odkazy na přílohy v Airtable expirují po dvou
hodinách, takže se stránka záznamů zpracuje hned a při propadlém odkazu si
klient vyžádá čerstvý záznam.

---

## Nastavení (`src/routes/settings.js`)

Vše admin-only.

| Route | Popis |
|---|---|
| `GET/POST /nastaveni/firma` | Údaje firmy (ICO, DIČ, adresa, banka, fakturační poznámka) |
| `GET/POST /nastaveni/ciselne-rady` | Číselné řady pro faktury (prefix, rok, padding) |
| `GET/POST /nastaveni/eshopy` | Seznam e-shopů, založení nového |
| `GET /nastaveni/eshopy/:id` | Detail e-shopu po záložkách (`?tab=zakladni\|identita\|napojeni\|expedice\|marketing\|healthchecky`) |
| `POST /nastaveni/eshopy/:id/zakladni` | Název, URL a stav e-shopu; slug je neměnný |
| `POST /nastaveni/eshopy/:id/identita` | Identita e-shopu v e-mailech |
| `POST /nastaveni/eshopy/:id/eshop-klic/vytvorit`, `…/eshop-klic/:keyId/zrusit` | Klíče pro `/api/eshop` (ne pro Toneráček) |
| `POST /nastaveni/eshopy/:id/webhook-secret` | Tajemství pro podání balíku (`akce=vygenerovat\|nastavit\|vymazat`; ne pro Toneráček) |
| `POST /nastaveni/eshopy/:id/expedice` | Adresa skladu a datum, od kterého se posílá |
| `GET /nastaveni/eshopy/:id/nahled-emailu` | Náhled šablony bez odeslání |
| `GET/POST /nastaveni/ucetni-osnova` | Číselník účtů (MD/D pro předkontaci) |
| `GET /api/accounting-chart` | API: účty pro autocomplete |
| `POST /api/invoice-series/:id/next` | API: generování čísla faktury |

### Detail e-shopu — serverové záložky

Detail běží na `?tab=` se serverovým renderem (stejně jako detail člena
a projektu) a načítá jen data otevřené záložky; ostatní dostává šablona
prázdná. Záložky: `zakladni` (název, URL, stav; slug jen pro čtení),
`identita`, `napojeni` (klíče `/api/eshop`, tajemství pro balík),
`expedice` (adresa skladu, poslední běhy), `marketing` (marže, práh PNO,
platformy, poslední stažení), `healthchecky` (healthchecky, alerty při
výpadku, „+ Healthcheck“). Neznámý klíč otevře `zakladni`.

Konvence: každý POST se vrací na svou záložku —
`/nastaveni/eshopy/:id?tab=<záložka>&saved=1` nebo `…&error=<kód>`; POSTy,
které vykreslují přímo (nový klíč, nové tajemství, ověření platformy),
předávají `vykresliDetail()` záložku v `extra.tab`. Healthchecky a alerty
jdou přes routy monitoringu a vrací se hodnotou `returnTo`
(`…?tab=healthchecky`). Pruh záložek je sdílená CSS komponenta
`.tabs`/`.tab` v `public/css/components.css` — používají ji i detail firmy,
projektu a člena týmu.

**Toneráček se nevypíná.** Jeho API klíč z prostředí stav `shops.active`
nečte, ale expedice a noční stahování ano — přepínač je proto zašedlý
a routa u něj `active` z těla ignoruje.

### Identita e-shopu v e-mailech

Odesílatel, barvy, loga a kontakty pro zákaznické e-maily jsou sloupce tabulky
`shops` (migrace 030), čte je `shopBrand()` v `src/brand.js`. Přidat další
e-shop tak znamená vyplnit formulář, ne sáhnout do šablon.

Dvě pravidla, na kterých to stojí:

- **`company_settings` je vystavovatel dokladu, ne identita e-mailu.** SEIL
  s.r.o. se zákazníkovi ukáže v hlavičce PDF faktury a jako drobná řádka
  o prodávajícím pod patičkou. Odesílatelem zákaznického e-mailu není nikdy.
- **Chybějící identita znamená neodeslat.** `shopBrand()` vyhodí
  `BrandIncompleteError` a e-mail neodejde. Neodeslaný jde poslat ručně
  z administrace; prozrazenou cizí identitu vzít zpět nejde. Hlídá to jednak
  hrdlo `deliver()` v `src/email.js`, jednak CHECK constraint v migraci 030.

Zákazníkovi e-shopu chodí ze Seilu tři e-maily: faktura po vyřízení objednávky
(s sledovacím číslem), storno a upomínka. Všechny v identitě e-shopu a přes
společnou šablonu v `src/email-templates.js`, která kopíruje tvar e-mailů
z e-shopu — zákazník nemá poznat, který systém zprávu odeslal.

Upomínka má u zákazníka e-shopu mírnější dvoustupňový text. Předžalobní výzva
spotřebiteli kvůli neuhrazené záloze za toner je právně neobratná; nezaplacená
záloha se u B2C řeší stornem objednávky.

---

## Backend workery

### Recurring scheduler (`src/recurring.js`)
Spouští se jednou při startu serveru, pak každých 24 hodin. Prochází `recurring_invoices` se `next_run_date <= NOW()`, generuje faktury, aktualizuje `next_run_date`.

### Healthcheck worker (`src/healthcheck-worker.js`)
Pinguje registrované URL v nastaveném intervalu. Zapisuje výsledky do `healthcheck_results`. Pokud selže, spouští notifikační pravidla. Ve stejném pětiminutovém tiku hlídá splatnost faktur a lhůtu pro daňový doklad k zaplaceným objednávkám a odeslaným dobírkám (viz *Faktury*).

### Expedice do skladu (`src/expedice.js`)
Tiká každých 5 minut (poprvé 20 s po startu). Ve všední den po 6:00 pražského
času založí jeden běh na e-shop s vyplněnou adresou skladu, dožádá chybějící
balíky u e-shopu, stáhne štítky z Packety a odešle jeden e-mail. Po přechodné
chybě opakuje s lineárním odstupem (10, 20, 30… minut, nejvýš šestkrát), pak
si řekne o obsluhu pushem a tlačítkem „Odeslat expedici teď". Pražský čas
počítá přes `Intl` — kontejner nemá nastavené `TZ`.

### Marketing — noční stahování statistik (`src/marketing/sync.js`)
Tiká každých 10 minut (poprvé 45 s po startu). Po páté hodině pražského času
projde aktivní zdroje aktivních e-shopů (`marketing_sources`) a za každý zajistí
jeden automatický běh denně: řádek `marketing_sync_runs` vzniká před prací a je
zámkem (částečné unikátní indexy — jeden auto běh na zdroj a den, nejvýš jeden
rozběhnutý), takže se dva kontejnery při nasazení nepotkají. Stahuje se okno
`[dnes − prepisDni, včera]` (14 dní, u konverzí Skliku, Heureky a Mety 30 — platformy
dopočítávají zpětně), při prvním běhu od „stahovat od“ (nejvýš 400 dní), po kusech
podle adaptéru. Zápis je jedna transakce DELETE okna + INSERT. Trvalá chyba
(401/403/400, nerozšifrovatelný token) → běh `chyba` s `permanent`, hned
upozornění a žádné opakování; přechodná → backoff 10/20/30 min, po šestém pokusu
upozornění. Dvě zkratky zpět: po restartu procesu (redeploy, typicky s doplněným
klíčem v env) dostane každý dnešní neúspěšný běh jeden pokus navíc a úspěšné
„Ověřit připojení" v nastavení e-shopu rovnou spustí ruční běh té platformy. Po smyčce se mažou click-id objednávek starších 90 dní a po sedmé
hodině se jednou za den hlásí PNO měsíce nad prahem e-shopu
(`shops.marketing_pno_alert_pct`). Upozornění (`src/marketing/alerty.js`) jdou přes
pravidla notifikací (typy `marketing_sync_failed`, `marketing_pno_high`), bez
pravidla pushem všem; dedupe v `notification_log`. Ruční běh z /marketing/sync je
jen pro správce (čerpá kvóty API). Adaptéry platforem leží v
`src/marketing/adapters/` (rozhraní `fetchDaily`, `parsuj`, `overit`) a načítají se
líně — server startuje i bez nich.

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
