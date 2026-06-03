ALTER TABLE accounting_invoices
  ADD COLUMN IF NOT EXISTS supplier_ico TEXT;
