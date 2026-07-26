-- Nastavení exportu do POHODY (účetní jednotka = IČO z company_settings)
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS pohoda_cash_account TEXT NOT NULL DEFAULT 'Pokladna',
  ADD COLUMN IF NOT EXISTS pohoda_predkontace  TEXT NOT NULL DEFAULT '';
