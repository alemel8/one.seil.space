# one.seil.space — Přehled systému

Interní webová aplikace pro správu e-shopů, účetnictví, CRM, týmu a infrastruktury seil.space.
Přístup je chráněn přihlášením; existuje role uživatel a administrátor.

## Co systém umí

| Oblast | Funkce |
|---|---|
| **Účetnictví** | vydané i přijaté faktury, PDF, e-mail, POHODA XML export |
| **Banka** | import Fio CSV, manuální transakce, párování faktura ↔ transakce |
| **Účtenky** | skenování, AI rozpoznání (Claude), párování s bankou |
| **Opakované faktury** | šablony, automatické generování dle plánu |
| **Objednávky** | příjem z Toneráček.cz a dalších e-shopů přes API |
| **CRM** | firmy, kontakty, propojení s objednávkami a fakturami |
| **Notifikace** | e-mail (Resend) + push notifikace v PWA na telefonu |
| **VPS monitoring** | RAM, CPU, disk, Docker, SSL, backupy, 72h grafy |
| **Healthchecky** | HTTP ping monitorovaných URL, notifikace při výpadku |
| **Marketing** | PNO, ROAS, marže a zisk po reklamě po e-shopech; náklady z GA4, Google Ads, Search Console, Merchant, Sklik/Zboží, Heureka, Meta a z e-shopu; ruční náklady; noční synchronizace |
| **Správa** | uživatelé, nastavení firmy, číselné řady, e-shopy (klíče pro API v detailu e-shopu) |

## Technologický stack

- **Backend:** Node.js 20+, Fastify 5, ES modules
- **Databáze:** PostgreSQL 16 (hlavní data), SQLite (VPS history read-only)
- **Šablony:** EJS
- **PDF:** Puppeteer + Chromium
- **E-mail:** Resend
- **AI:** Anthropic Claude API (analýza účtenek)
- **Push notifikace:** Web Push / VAPID
- **Grafy:** Chart.js 4.4.7 (vendorovaný UMD build `public/chart.umd.min.js`, MIT)
- **Deploy:** Docker, Coolify, VPS vps.seil.space

## Struktura repozitáře

```
one.seil.space/
├── src/
│   ├── server.js           # Fastify server, registrace pluginů a routes
│   ├── db.js               # PostgreSQL pool + SQLite, generateId()
│   ├── migrate.js          # Automatické SQL migrace při startu
│   ├── email.js            # Odesílání e-mailů přes Resend
│   ├── push.js             # Web Push notifikace (VAPID)
│   ├── pdf.js              # Generování PDF faktur přes Puppeteer
│   ├── pohoda.js           # Export do POHODA XML
│   ├── fio-parser.js       # Parser Fio CSV bankovních výpisů
│   ├── recurring.js        # Scheduler opakujících se faktur
│   ├── healthcheck-worker.js # Worker pro HTTP healthchecky
│   ├── collector.js        # VPS stats kolektor (cron na hostu)
│   ├── session-store.js    # PostgreSQL session store
│   ├── google-auth.js      # Service account Googlu (JWT → token), společný pro Disk i Marketing
│   ├── atribuce-objednavky.js # Zdroj objednávky a nákupní cena z těla POST …/orders
│   ├── hledani.js          # Globální hledání: skupiny výsledků podle přístupové matice (routa v routes/hledani.js)
│   └── routes/             # Fastify route pluginy (viz moduly.md)
├── views/                  # EJS šablony
│   ├── layouts/base.ejs    # Hlavní layout (navbar, sidebar)
│   ├── pages/              # Stránky jednotlivých modulů
│   └── pdf/invoice.ejs     # Šablona pro PDF faktury
├── public/
│   ├── sw.js               # Service Worker (PWA + push notifikace)
│   ├── chart.umd.min.js    # Chart.js 4.4.7 (UMD, MIT) pro grafy
│   └── manifest.json       # PWA manifest
├── migrations/             # Číslované SQL migrace (001–010)
├── docs/                   # Tato dokumentace
├── scripts/                # Pomocné skripty (migrace dat, superuser)
├── data/                   # Runtime data (media, PDF) — není v gitu
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## Datové toky

### Příchozí objednávka z e-shopu
```
E-shop → /api/toneracek/orders nebo /api/eshop/orders
  → INSERT shop_orders (+ zdroj objednávky z `marketing`) + shop_order_items (+ nákupní cena)
  → Upsert zákazník do CRM
  → Push notifikace všem uživatelům
  → (volitelně) e-mail zákazníkovi
```

### Faktura
```
Nová faktura (z objednávky nebo ručně)
  → Generování čísla z číselné řady
  → Výpočet DPH
  → PDF rendering (Puppeteer)
  → E-mail zákazníkovi (Resend)
  → POHODA XML export (pro účetní software)
```

### Bankovní import
```
Fio CSV import
  → Parsování fio-parser.js
  → INSERT accounting_bank_transactions
  → Ruční párování: transakce ↔ faktura nebo účtenka
  → Aktualizace stavu faktury (Zaplacena)
```

### Push notifikace
```
Uživatel zapne notifikace v /profil
  → Browser vyžádá permission
  → Subscription uložena do push_subscriptions
  → Při nové objednávce: sendPushToAll() → broadcast
  → Klik na notifikaci → otevření detailu objednávky
```
