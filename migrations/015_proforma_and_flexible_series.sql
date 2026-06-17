-- Zálohové faktury (proforma)
ALTER TABLE accounting_invoices DROP CONSTRAINT IF EXISTS accounting_invoices_type_check;
ALTER TABLE accounting_invoices ADD CONSTRAINT accounting_invoices_type_check
  CHECK (type IN ('issued', 'received', 'proforma'));

-- Vazba finální faktury na zálohovou fakturu, ze které vznikla
ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS proforma_invoice_id TEXT
  REFERENCES accounting_invoices(id) ON DELETE SET NULL;

-- Flexibilní číselné řady: typ entity (objednávka/faktura) a vlastní formát s tokeny
-- YYYY/YY = rok, MM = měsíc, DD = den, X... = náhodné znaky, N... = pořadové číslo (zero-padded)
ALTER TABLE invoice_number_series ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'faktura'
  CHECK (entity_type IN ('faktura', 'objednavka'));
ALTER TABLE invoice_number_series ADD COLUMN IF NOT EXISTS format TEXT;
