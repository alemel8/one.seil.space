-- ============================================================
-- one.seil.space — zdroj u kontaktů a firem
-- ============================================================
-- CRM sbírá kontakty z víc míst najednou: z e-shopu Toneráček, ručním
-- zadáním v administraci a časem z dalších e-shopů. Dosud se to nedalo
-- rozlišit — jediná stopa byla poznámka „Zákazník Toneráček.cz", kterou
-- zapisoval `upsertCustomerToCRM()` do sloupce `notes`.
--
-- Na `notes` se ale spolehnout nejde. E-shop si do téhož sloupce ukládá
-- záložní kopii bcrypt hashe hesla (`PWDHASH:…`, zapisuje registrace a reset
-- hesla), takže u registrovaného zákazníka poznámka o zdroji zanikne. Filtr
-- postavený na `notes` by tyhle kontakty tiše vynechával.
--
-- Zdroj proto dostává vlastní sloupec. Hodnota je název e-shopu tak, jak ho
-- zná zákazník („Toneráček.cz"); u ručně založených záznamů zůstává prázdný.

ALTER TABLE crm_contacts  ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS source TEXT;

-- Zpětné doplnění podle staré poznámky. Bere i kontakty, jejichž `notes`
-- mezitím přepsal PWDHASH — ty se poznají podle vazby na objednávku
-- Toneráčku.
UPDATE crm_contacts SET source = 'Toneráček.cz'
WHERE source IS NULL AND notes = 'Zákazník Toneráček.cz';

UPDATE crm_contacts c SET source = 'Toneráček.cz'
WHERE c.source IS NULL
  AND EXISTS (SELECT 1 FROM shop_orders o WHERE o.crm_contact_id = c.id);

UPDATE crm_companies co SET source = 'Toneráček.cz'
WHERE co.source IS NULL
  AND EXISTS (SELECT 1 FROM shop_orders o WHERE o.crm_company_id = co.id);

-- Filtruje se přes ně ve výpisech CRM.
CREATE INDEX IF NOT EXISTS idx_crm_contacts_source  ON crm_contacts (source);
CREATE INDEX IF NOT EXISTS idx_crm_companies_source ON crm_companies (source);
