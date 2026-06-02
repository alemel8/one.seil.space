-- ============================================================
-- one.seil.space — PostgreSQL schema v1
-- ============================================================

-- ── Uživatelé ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  first_name    TEXT NOT NULL DEFAULT '',
  last_name     TEXT NOT NULL DEFAULT '',
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  photo         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Session store (connect-pg-simple)
CREATE TABLE IF NOT EXISTS session (
  sid    TEXT NOT NULL PRIMARY KEY,
  sess   JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);

-- ── Eshopy ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shops (
  id         SERIAL PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL DEFAULT '',
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  config     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id         SERIAL PRIMARY KEY,
  key        TEXT UNIQUE NOT NULL,
  shop_id    INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Nastavení firmy (plátce) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS company_settings (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  ico             TEXT NOT NULL DEFAULT '',
  dic             TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  city            TEXT NOT NULL DEFAULT '',
  zip             TEXT NOT NULL DEFAULT '',
  country         TEXT NOT NULL DEFAULT 'Česká republika',
  phone           TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  bank_account    TEXT NOT NULL DEFAULT '',
  bank_name       TEXT NOT NULL DEFAULT '',
  iban            TEXT NOT NULL DEFAULT '',
  swift           TEXT NOT NULL DEFAULT '',
  vat_payer       BOOLEAN NOT NULL DEFAULT TRUE,
  invoice_note    TEXT NOT NULL DEFAULT 'Nejsme plátci DPH.',
  logo_url        TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: základní nastavení firmy (IČO 04245610, doplní se přes UI)
INSERT INTO company_settings (ico) VALUES ('04245610') ON CONFLICT DO NOTHING;

-- ── Číselné řady faktur ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS invoice_number_series (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  prefix         TEXT NOT NULL,
  year           INTEGER,
  current_number INTEGER NOT NULL DEFAULT 0,
  start_number   INTEGER NOT NULL DEFAULT 1,
  padding        INTEGER NOT NULL DEFAULT 4,
  shop_id        INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── CRM ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_companies (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  company_type   TEXT NOT NULL DEFAULT 'Zákazník',
  ico            TEXT NOT NULL DEFAULT '',
  dic            TEXT NOT NULL DEFAULT '',
  country        TEXT NOT NULL DEFAULT '',
  city           TEXT NOT NULL DEFAULT '',
  zip            TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  website        TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  ares_data      JSONB,
  ares_synced_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crm_contacts (
  id                    TEXT PRIMARY KEY,
  first_name            TEXT NOT NULL DEFAULT '',
  last_name             TEXT NOT NULL DEFAULT '',
  email                 TEXT UNIQUE,
  phone                 TEXT NOT NULL DEFAULT '',
  title                 TEXT NOT NULL DEFAULT '',
  company_id            TEXT REFERENCES crm_companies(id) ON DELETE SET NULL,
  company_name          TEXT NOT NULL DEFAULT '',
  address               TEXT NOT NULL DEFAULT '',
  city                  TEXT NOT NULL DEFAULT '',
  zip                   TEXT NOT NULL DEFAULT '',
  country               TEXT NOT NULL DEFAULT '',
  notes                 TEXT NOT NULL DEFAULT '',
  is_registered         BOOLEAN NOT NULL DEFAULT FALSE,
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  last_login            TIMESTAMPTZ,
  marketing_consent     BOOLEAN NOT NULL DEFAULT FALSE,
  notifications_consent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crm_contacts_email_idx ON crm_contacts (LOWER(email));

-- Per-shop registrační data zákazníka
CREATE TABLE IF NOT EXISTS crm_contact_shops (
  contact_id            TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  shop_id               INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  is_registered         BOOLEAN NOT NULL DEFAULT TRUE,
  marketing_consent     BOOLEAN NOT NULL DEFAULT FALSE,
  notifications_consent BOOLEAN NOT NULL DEFAULT FALSE,
  last_login            TIMESTAMPTZ,
  external_id           TEXT,
  registered_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, shop_id)
);

-- ── Objednávky ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shop_orders (
  id                  TEXT PRIMARY KEY,
  shop_id             INTEGER NOT NULL REFERENCES shops(id),
  order_number        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'Nová',
  -- fakturační adresa
  email               TEXT NOT NULL DEFAULT '',
  first_name          TEXT NOT NULL DEFAULT '',
  last_name           TEXT NOT NULL DEFAULT '',
  company             TEXT NOT NULL DEFAULT '',
  ic                  TEXT NOT NULL DEFAULT '',
  dic                 TEXT NOT NULL DEFAULT '',
  phone               TEXT NOT NULL DEFAULT '',
  address             TEXT NOT NULL DEFAULT '',
  city                TEXT NOT NULL DEFAULT '',
  zip                 TEXT NOT NULL DEFAULT '',
  country             TEXT NOT NULL DEFAULT 'Česká republika',
  -- doručení
  shipping_method     TEXT NOT NULL DEFAULT '',
  shipping_first_name TEXT NOT NULL DEFAULT '',
  shipping_last_name  TEXT NOT NULL DEFAULT '',
  shipping_company    TEXT NOT NULL DEFAULT '',
  shipping_phone      TEXT NOT NULL DEFAULT '',
  shipping_address    TEXT NOT NULL DEFAULT '',
  shipping_city       TEXT NOT NULL DEFAULT '',
  shipping_zip        TEXT NOT NULL DEFAULT '',
  pickup_point_id     TEXT NOT NULL DEFAULT '',
  pickup_point_name   TEXT NOT NULL DEFAULT '',
  -- finance
  payment_method      TEXT NOT NULL DEFAULT '',
  currency            TEXT NOT NULL DEFAULT 'CZK',
  total_price         DECIMAL(12,2) NOT NULL DEFAULT 0,
  invoice_number      TEXT NOT NULL DEFAULT '',
  -- tracking
  tracking_number     TEXT NOT NULL DEFAULT '',
  label_url           TEXT NOT NULL DEFAULT '',
  -- meta
  ip_address          TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',
  crm_contact_id      TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
  crm_company_id      TEXT REFERENCES crm_companies(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, order_number)
);

CREATE INDEX IF NOT EXISTS shop_orders_shop_id_idx    ON shop_orders (shop_id);
CREATE INDEX IF NOT EXISTS shop_orders_email_idx      ON shop_orders (LOWER(email));
CREATE INDEX IF NOT EXISTS shop_orders_created_at_idx ON shop_orders (created_at DESC);

CREATE TABLE IF NOT EXISTS shop_order_items (
  id           SERIAL PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  sku          TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 1,
  price        DECIMAL(10,2) NOT NULL DEFAULT 0,
  product_id   TEXT,
  multipack_id TEXT
);

-- ── Faktury ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounting_invoices (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('issued', 'received')),
  series_id        INTEGER REFERENCES invoice_number_series(id) ON DELETE SET NULL,
  number           TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'Nezaplacena',
  -- vazba na eshop/objednávku (vydané)
  shop_id          INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  order_id         TEXT REFERENCES shop_orders(id) ON DELETE SET NULL,
  crm_contact_id   TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
  crm_company_id   TEXT REFERENCES crm_companies(id) ON DELETE SET NULL,
  client_name      TEXT NOT NULL DEFAULT '',
  client_ico       TEXT NOT NULL DEFAULT '',
  client_dic       TEXT NOT NULL DEFAULT '',
  client_address   TEXT NOT NULL DEFAULT '',
  -- přijaté: dodavatel
  supplier         TEXT NOT NULL DEFAULT '',
  -- společné
  issue_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date         DATE,
  paid_date        DATE,
  amount           DECIMAL(12,2) NOT NULL DEFAULT 0,
  vat_amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_amount     DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'CZK',
  -- propojení s bankovní transakcí
  bank_transaction_id INTEGER,
  pdf_path         TEXT,
  notes            TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS accounting_invoices_type_idx   ON accounting_invoices (type);
CREATE INDEX IF NOT EXISTS accounting_invoices_status_idx ON accounting_invoices (status);

CREATE TABLE IF NOT EXISTS accounting_invoice_items (
  id             SERIAL PRIMARY KEY,
  invoice_id     TEXT NOT NULL REFERENCES accounting_invoices(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  quantity       DECIMAL(10,3) NOT NULL DEFAULT 1,
  unit           TEXT NOT NULL DEFAULT 'ks',
  price_per_unit DECIMAL(12,2) NOT NULL DEFAULT 0,
  vat_rate       DECIMAL(5,2) NOT NULL DEFAULT 21,
  amount         DECIMAL(12,2) NOT NULL DEFAULT 0,
  vat_amount     DECIMAL(12,2) NOT NULL DEFAULT 0,
  total          DECIMAL(12,2) NOT NULL DEFAULT 0
);

-- ── Banka ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounting_bank_accounts (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  bank_name      TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  iban           TEXT NOT NULL DEFAULT '',
  swift          TEXT NOT NULL DEFAULT '',
  currency       TEXT NOT NULL DEFAULT 'CZK',
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounting_bank_imports (
  id              SERIAL PRIMARY KEY,
  bank_account_id INTEGER NOT NULL REFERENCES accounting_bank_accounts(id),
  filename        TEXT NOT NULL,
  format          TEXT NOT NULL DEFAULT 'fio_csv',
  date_from       DATE,
  date_to         DATE,
  rows_imported   INTEGER NOT NULL DEFAULT 0,
  rows_skipped    INTEGER NOT NULL DEFAULT 0,
  rows_matched    INTEGER NOT NULL DEFAULT 0,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS accounting_bank_transactions (
  id                  SERIAL PRIMARY KEY,
  bank_account_id     INTEGER NOT NULL REFERENCES accounting_bank_accounts(id),
  import_id           INTEGER REFERENCES accounting_bank_imports(id) ON DELETE SET NULL,
  external_id         TEXT UNIQUE,
  type                TEXT NOT NULL DEFAULT 'credit' CHECK (type IN ('credit', 'debit')),
  amount              DECIMAL(12,2) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'CZK',
  counterparty_account TEXT NOT NULL DEFAULT '',
  counterparty_name   TEXT NOT NULL DEFAULT '',
  variable_symbol     TEXT NOT NULL DEFAULT '',
  constant_symbol     TEXT NOT NULL DEFAULT '',
  specific_symbol     TEXT NOT NULL DEFAULT '',
  message             TEXT NOT NULL DEFAULT '',
  transaction_date    DATE NOT NULL,
  matched_invoice_id  TEXT REFERENCES accounting_invoices(id) ON DELETE SET NULL,
  matched_at          TIMESTAMPTZ,
  matched_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes               TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bank_tx_date_idx     ON accounting_bank_transactions (transaction_date DESC);
CREATE INDEX IF NOT EXISTS bank_tx_vs_idx       ON accounting_bank_transactions (variable_symbol);
CREATE INDEX IF NOT EXISTS bank_tx_matched_idx  ON accounting_bank_transactions (matched_invoice_id);

-- FK zpět z faktur na transakce (přidáme až teď, po vytvoření tabulky)
ALTER TABLE accounting_invoices
  ADD CONSTRAINT fk_invoice_bank_tx
  FOREIGN KEY (bank_transaction_id)
  REFERENCES accounting_bank_transactions(id)
  ON DELETE SET NULL;

-- ── Interní účetní objednávky (nebankové, manuální záznamy) ───

CREATE TABLE IF NOT EXISTS accounting_orders (
  id         TEXT PRIMARY KEY,
  number     TEXT NOT NULL,
  subject    TEXT NOT NULL DEFAULT '',
  amount     DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency   TEXT NOT NULL DEFAULT 'CZK',
  status     TEXT NOT NULL DEFAULT 'Nová',
  company_id TEXT REFERENCES crm_companies(id) ON DELETE SET NULL,
  date       DATE NOT NULL DEFAULT CURRENT_DATE,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
