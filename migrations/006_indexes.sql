-- Výkonnostní indexy pro časté dotazy

-- Účtenky: filtrování dle data
CREATE INDEX IF NOT EXISTS idx_receipts_date     ON receipts(receipt_date DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_status   ON receipts(status);

-- Faktury: kombinovaný index pro homepage agregace
CREATE INDEX IF NOT EXISTS idx_invoices_type_date ON accounting_invoices(type, issue_date DESC);

-- Faktury: status pro overdue dotaz
-- (idx_invoices_status_idx již existuje z migration 001)

-- Bank transactions: datum pro pořadí výpisu
-- (bank_tx_date_idx již existuje)
