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
| `email` | TEXT UNIQUE | |
| `password_hash` | TEXT | bcryptjs, salt 10 |
| `first_name` | TEXT | |
| `last_name` | TEXT | |
| `is_admin` | BOOL | Přístup k admin sekcím |
| `is_active` | BOOL | Deaktivovaný účet se nemůže přihlásit |
| `photo` | TEXT | Název souboru v `data/media/` |
| `created_at` | TIMESTAMPTZ | |

### `session`
PostgreSQL session store (connect-pg-simple). Spravuje se automaticky.

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

### `api_keys`
API klíče pro příjem objednávek.

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
| `invoice_number` | TEXT | Vygenerované číslo faktury |
| `tracking_number`, `label_url` | TEXT | Sledování zásilky |
| `ip_address`, `notes` | TEXT | |
| `crm_contact_id` | INT → crm_contacts | Automaticky linkovaný kontakt |
| `crm_company_id` | INT → crm_companies | |
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

---

## CRM

### `crm_companies`
Firmy (zákazníci, dodavatelé, …).

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | TEXT | |
| `type` | TEXT | Zákazník / Dodavatel / Partner / Jiný |
| `ico`, `dic` | TEXT | |
| `address`, `city`, `zip`, `country` | TEXT | |
| `phone`, `email`, `web` | TEXT | |
| `notes` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

### `crm_contacts`
Fyzické osoby.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `first_name`, `last_name` | TEXT | |
| `email` | TEXT | |
| `phone` | TEXT | |
| `company_id` | INT → crm_companies | Volitelné |
| `address`, `city`, `zip`, `country` | TEXT | |
| `notes` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

### `crm_contact_shops`
Per-shop registrační data kontaktu (marketing consent, registrační datum).

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `contact_id` | INT → crm_contacts | |
| `shop_id` | INT → shops | |
| `registered_at` | TIMESTAMPTZ | |
| `marketing_consent` | BOOL | |
| `is_registered` | BOOL | |

---

## Účetnictví

### `accounting_invoices`
Vydané i přijaté faktury.

| Sloupec | Typ | Popis |
|---|---|---|
| `id` | SERIAL PK | |
| `type` | TEXT | `issued` / `received` |
| `number` | TEXT | Číslo faktury |
| `status` | TEXT | Vystavena / Odeslaná / Zaplacena / Storno |
| `issue_date`, `due_date` | DATE | |
| `customer_*` | TEXT | Fakturační údaje odběratele |
| `supplier_ico` | TEXT | IČO dodavatele (přijaté faktury) |
| `items_total`, `vat_total`, `total` | NUMERIC | Součty |
| `vat_rate` | NUMERIC | Sazba DPH |
| `payment_method` | TEXT | |
| `series_id` | INT → invoice_number_series | |
| `shop_order_id` | TEXT → shop_orders | Propojení s objednávkou |
| `account_debit`, `account_credit` | TEXT | Předkontace (MD/D) |
| `pdf_path` | TEXT | Cesta k vygenerovanému PDF |
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
| `file_path` | TEXT | Uložený soubor v `data/media/` |
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
