-- Rozšíření párování bankovních transakcí o účtenky

-- Přidat odkaz z banky na účtenku (symetricky s matched_invoice_id)
ALTER TABLE accounting_bank_transactions
  ADD COLUMN IF NOT EXISTS matched_receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL;

-- Přidat odkaz z účtenky zpět na bankovní transakci
ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS bank_tx_id INTEGER REFERENCES accounting_bank_transactions(id) ON DELETE SET NULL;

-- Index
CREATE INDEX IF NOT EXISTS idx_bank_tx_receipt ON accounting_bank_transactions(matched_receipt_id);
