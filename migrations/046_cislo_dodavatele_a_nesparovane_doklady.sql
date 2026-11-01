-- Číslo dokladu od dodavatele. U faktur z POHODY je v number její interní číslo,
-- číslo dodavatele má POHODA ve sloupci Doklad. Podle něj se doklad z Google Disku
-- spáruje i bez IČO a v cizí měně.
SET LOCAL lock_timeout = '2s';

ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS supplier_number TEXT NOT NULL DEFAULT '';

-- nesparovano: starý doklad ze složky, ke kterému se nenašla faktura. Automatika ho
-- nezkouší znovu a sám nezaloží novou fakturu, rozhodne člověk.
ALTER TABLE gdrive_soubory DROP CONSTRAINT IF EXISTS gdrive_soubory_stav_check;
ALTER TABLE gdrive_soubory ADD CONSTRAINT gdrive_soubory_stav_check
  CHECK (stav IN ('vychozi', 'cekajici', 'naimportovano', 'chyba', 'nesparovano'));
