-- Účtenky (pokladní doklady, paragony)
CREATE TABLE IF NOT EXISTS receipts (
  id            SERIAL PRIMARY KEY,
  number        TEXT,
  vendor        TEXT        NOT NULL DEFAULT '',
  vendor_ico    TEXT,
  amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency      TEXT        NOT NULL DEFAULT 'CZK',
  receipt_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
  category      TEXT        NOT NULL DEFAULT 'Ostatní',
  notes         TEXT,
  status        TEXT        NOT NULL DEFAULT 'Nezaúčtována',
  pdf_path      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
