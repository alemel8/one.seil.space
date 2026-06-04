-- Číselník účtů (spravovatelný adminem)
CREATE TABLE IF NOT EXISTS accounting_chart (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Výchozí účty z české účetní osnovy
INSERT INTO accounting_chart (code, name) VALUES
  ('211', 'Pokladna'),
  ('221', 'Bankovní účty'),
  ('261', 'Peníze na cestě'),
  ('311', 'Pohledávky z obchodního styku'),
  ('314', 'Poskytnuté zálohy'),
  ('321', 'Závazky z obchodního styku'),
  ('324', 'Přijaté zálohy'),
  ('335', 'Pohledávky za zaměstnanci'),
  ('343', 'Daň z přidané hodnoty'),
  ('395', 'Vnitřní zúčtování'),
  ('431', 'Výsledek hospodaření ve schvalovacím řízení'),
  ('501', 'Spotřeba materiálu'),
  ('502', 'Spotřeba energie'),
  ('511', 'Opravy a udržování'),
  ('512', 'Cestovné'),
  ('513', 'Náklady na reprezentaci'),
  ('518', 'Ostatní služby'),
  ('521', 'Mzdové náklady'),
  ('527', 'Zákonné sociální náklady'),
  ('528', 'Ostatní sociální náklady'),
  ('549', 'Manka a škody'),
  ('562', 'Úroky'),
  ('568', 'Ostatní finanční náklady'),
  ('596', 'Daň z příjmů'),
  ('601', 'Tržby za vlastní výrobky'),
  ('602', 'Tržby z prodeje služeb'),
  ('604', 'Tržby za zboží'),
  ('648', 'Ostatní provozní výnosy'),
  ('662', 'Úroky'),
  ('668', 'Ostatní finanční výnosy')
ON CONFLICT (code) DO NOTHING;

-- Předkontace na fakturách
ALTER TABLE accounting_invoices
  ADD COLUMN IF NOT EXISTS account_debit  TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS account_credit TEXT NOT NULL DEFAULT '';

-- Předkontace na účtenkách
ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS account_debit  TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS account_credit TEXT NOT NULL DEFAULT '';
