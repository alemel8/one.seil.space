ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS supplier_dic     TEXT NOT NULL DEFAULT '';
ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS supplier_address TEXT NOT NULL DEFAULT '';
ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS supplier_city    TEXT NOT NULL DEFAULT '';
ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS supplier_zip     TEXT NOT NULL DEFAULT '';
ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS supplier_country TEXT NOT NULL DEFAULT 'Česká republika';
ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS attachment_path  TEXT;
