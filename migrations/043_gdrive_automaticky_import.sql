-- Automatický import přijatých faktur z Google Disku: co už aplikace na Disku
-- viděla a jak to dopadlo. První kontrola zapíše všechno, co ve složce je, jako
-- 'vychozi' a nic z toho neimportuje – to jsou doklady z doby před automatikou,
-- které jsou v systému z POHODY a přiřazují se k nim ručně.
CREATE TABLE IF NOT EXISTS gdrive_soubory (
  file_id        TEXT PRIMARY KEY,
  nazev          TEXT NOT NULL DEFAULT '',
  slozka         TEXT NOT NULL DEFAULT '',
  stav           TEXT NOT NULL CHECK (stav IN ('vychozi', 'cekajici', 'naimportovano', 'chyba')),
  invoice_id     TEXT REFERENCES accounting_invoices(id) ON DELETE SET NULL,
  pokusy         INT  NOT NULL DEFAULT 0,
  chyba          TEXT NOT NULL DEFAULT '',
  posledni_pokus TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Složka, pro kterou je výchozí stav zapsaný. Po změně ID složky se zapíše
-- znovu, jinak by se její celý obsah bral jako nové doklady.
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS gdrive_vychozi_slozka    TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS gdrive_posledni_kontrola TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdrive_posledni_chyba    TEXT NOT NULL DEFAULT '';
