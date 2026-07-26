-- Import přijatých faktur z Google Disku
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS gdrive_root_folder_id TEXT NOT NULL DEFAULT '';

-- Dedup: ať se stejný soubor z Disku nenaimportuje dvakrát
ALTER TABLE accounting_invoices
  ADD COLUMN IF NOT EXISTS gdrive_file_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_invoices_gdrive_file_id_idx
  ON accounting_invoices (gdrive_file_id) WHERE gdrive_file_id IS NOT NULL;
