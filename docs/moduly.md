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
| `POST /ucetnictvi/vydane-faktury/:id/stav` | Změnit stav faktury |
| `GET /ucetnictvi/prijate-faktury` | Seznam přijatých faktur |
| `POST /ucetnictvi/prijate-faktury/vytvorit` | Vytvořit přijatou fakturu |
| `GET /ucetnictvi/prijate-faktury/:id` | Detail přijaté faktury |
| `GET /ucetnictvi/export/pohoda.xml` | POHODA XML export |
| `GET /ucetnictvi/opakujici-se-faktury` | Správa šablon opakujících se faktur |
| `POST /ucetnictvi/opakujici-se-faktury/vytvorit` | Nová šablona |
| `POST /ucetnictvi/opakujici-se-faktury/:id/toggle` | Aktivovat / deaktivovat |

---

## Účtenky (`src/routes/receipts.js`)

| Route | Popis |
|---|---|
| `GET /ucetnictvi/uctenky` | Seznam účtenek |
| `POST /ucetnictvi/uctenky/nahrat` | Upload a AI analýza (Claude) |
| `GET /ucetnictvi/uctenky/:id` | Detail účtenky |
| `POST /ucetnictvi/uctenky/:id/stav` | Změnit stav (Nezaúčtována/Zaúčtována/Storno) |
| `POST /ucetnictvi/uctenky/:id/upravit` | Ruční úprava dat |

AI analýza extrahuje z obrázku/PDF: prodejce, datum, celkovou částku, DPH, kategorii.

Kategorie: Kancelář, Cestovné, Stravné, IT & Software, Marketing, Provoz, Ostatní.

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
| `GET /lide/tym/:id` | Detail člena týmu |
| `POST /lide/tym/:id/upravit` | Úprava (jméno, role, heslo) |
| `POST /lide/tym/:id/deaktivovat` | Deaktivace účtu |

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
