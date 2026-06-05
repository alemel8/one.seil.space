-- ── CRM Companies: ARES rozšíření ────────────────────────────
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS legal_form        TEXT NOT NULL DEFAULT '';
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS founded_date      DATE;
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS registration_info TEXT NOT NULL DEFAULT '';
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS company_status    TEXT NOT NULL DEFAULT '';

-- ── CRM Contracts (Smlouvy) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_contracts (
  id          TEXT PRIMARY KEY,
  company_id  TEXT REFERENCES crm_companies(id) ON DELETE SET NULL,
  contact_id  TEXT REFERENCES crm_contacts(id)  ON DELETE SET NULL,
  title       TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'Aktivní',
  signed_date DATE,
  end_date    DATE,
  amount      DECIMAL(12,2),
  currency    TEXT NOT NULL DEFAULT 'CZK',
  notes       TEXT NOT NULL DEFAULT '',
  file_path   TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  modified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Audit metadata: kdo vytvořil / naposledy editoval ─────────
-- crm_companies
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS modified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- crm_contacts
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS modified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- accounting_invoices
ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS modified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- shop_orders
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS modified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- receipts
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS modified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- accounting_bank_transactions
ALTER TABLE accounting_bank_transactions ADD COLUMN IF NOT EXISTS created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE accounting_bank_transactions ADD COLUMN IF NOT EXISTS modified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
