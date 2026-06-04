-- Šablony opakujících se faktur
CREATE TABLE IF NOT EXISTS recurring_invoices (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  series_id      INTEGER REFERENCES invoice_number_series(id) ON DELETE SET NULL,
  client_name    TEXT NOT NULL DEFAULT '',
  client_ico     TEXT NOT NULL DEFAULT '',
  client_dic     TEXT NOT NULL DEFAULT '',
  client_address TEXT NOT NULL DEFAULT '',
  client_email   TEXT NOT NULL DEFAULT '',
  items          JSONB NOT NULL DEFAULT '[]',
  frequency      TEXT NOT NULL DEFAULT 'monthly',  -- 'monthly' | 'quarterly' | 'yearly'
  day_of_month   INTEGER NOT NULL DEFAULT 1,
  due_days       INTEGER NOT NULL DEFAULT 14,       -- splatnost ve dnech
  next_run_date  DATE NOT NULL,
  last_run_date  DATE,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  send_email     BOOLEAN NOT NULL DEFAULT FALSE,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
