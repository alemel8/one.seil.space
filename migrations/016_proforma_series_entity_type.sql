-- Třetí typ číselné řady: zálohová faktura (proforma)
ALTER TABLE invoice_number_series DROP CONSTRAINT IF EXISTS invoice_number_series_entity_type_check;
ALTER TABLE invoice_number_series ADD CONSTRAINT invoice_number_series_entity_type_check
  CHECK (entity_type IN ('faktura', 'objednavka', 'zalohova_faktura'));
