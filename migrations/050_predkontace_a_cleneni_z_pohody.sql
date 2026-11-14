-- Předkontace a členění DPH tak, jak je doklad vede POHODA.
--
-- POHODA má u dokladu zkratku předkontace (11Fp, 5Fv, …) a členění DPH
-- (PD, UD, bez, …). Doplňuje je import exportu z POHODY
-- (scripts/import-faktury-xlsx.js), export XML je posílá zpátky. Doklad, který
-- je ještě nemá, převezme při exportu zkratky z posledního dokladu téhož
-- dodavatele nebo odběratele (src/pohoda-vzor.js), takže další faktura
-- od Anthropicu odejde stejně jako ty, které účetní zaúčtovala ručně.
--
-- account_debit a account_credit z migrace 007 zůstávají účty MD a D,
-- zkratka předkontace POHODY to není.
ALTER TABLE accounting_invoices
  ADD COLUMN IF NOT EXISTS pohoda_predkontace TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pohoda_cleneni_dph TEXT NOT NULL DEFAULT '';
