-- Odesílání faktur klientovi (PDF e-mailem) a hlídání splatnosti s upomínkami

-- ── E-mail odběratele přímo na faktuře ───────────────────────
-- Bez něj se adresa musela při každém odeslání vypisovat ručně.
ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS client_email TEXT NOT NULL DEFAULT '';

-- Doplnění z CRM u faktur, které už v systému jsou
UPDATE accounting_invoices i
SET client_email = c.email
FROM crm_contacts c
WHERE i.crm_contact_id = c.id AND i.client_email = '' AND COALESCE(c.email, '') <> '';

UPDATE accounting_invoices i
SET client_email = co.email
FROM crm_companies co
WHERE i.crm_company_id = co.id AND i.client_email = '' AND co.email <> '';

-- ── Jedno číslo dokladu jen jednou v rámci typu ──────────────
CREATE UNIQUE INDEX IF NOT EXISTS accounting_invoices_type_number_idx
  ON accounting_invoices (type, number)
  WHERE number <> '';

-- ── Log odeslaných e-mailů (faktury i upomínky) ──────────────
CREATE TABLE IF NOT EXISTS invoice_emails (
  id             SERIAL PRIMARY KEY,
  invoice_id     TEXT NOT NULL REFERENCES accounting_invoices(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'faktura' CHECK (kind IN ('faktura', 'upominka')),
  reminder_level INTEGER,
  email          TEXT NOT NULL,
  subject        TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'odeslano' CHECK (status IN ('odeslano', 'chyba')),
  error          TEXT NOT NULL DEFAULT '',
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_by        INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS invoice_emails_invoice_idx ON invoice_emails (invoice_id, sent_at DESC);

-- ── Upomínky připravené k ručnímu odeslání ───────────────────
-- Worker je jen zakládá ve stavu 'ceka', odesílá je vždy člověk.
CREATE TABLE IF NOT EXISTS invoice_reminders (
  id           SERIAL PRIMARY KEY,
  invoice_id   TEXT NOT NULL REFERENCES accounting_invoices(id) ON DELETE CASCADE,
  level        INTEGER NOT NULL,
  days_overdue INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'ceka' CHECK (status IN ('ceka', 'odeslana', 'zrusena')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at      TIMESTAMPTZ,
  sent_to      TEXT NOT NULL DEFAULT '',
  UNIQUE (invoice_id, level)
);

CREATE INDEX IF NOT EXISTS invoice_reminders_status_idx ON invoice_reminders (status, generated_at DESC);

-- ── Prahy upomínek (dní po splatnosti) ───────────────────────
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS reminder_levels JSONB NOT NULL
  DEFAULT '[{"level":1,"days":3},{"level":2,"days":14},{"level":3,"days":30}]'::jsonb;
