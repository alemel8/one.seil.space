-- ============================================================
-- one.seil.space — rozšíření tabulky users o HR sloupce
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS title        TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone        TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS position     TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio          TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS address      TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS city         TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS zip          TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS country      TEXT DEFAULT 'Česká republika';
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_account TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_name    TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS iban         TEXT DEFAULT '';
