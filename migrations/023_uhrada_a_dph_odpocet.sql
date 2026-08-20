-- Připomínky účetní k účtenkám (srpen 2026):
--
--  1. „vymazala jsem z pokladny doklady na repre a PHM — toto je hrazeno kartou
--     z banky, tedy v pokladně nemá být a navíc já už to měla nahrané
--     v ostatních závazcích“
--     → účtenka nese formu úhrady; do agendy Pokladna jde jen hotovost,
--       zbytek se exportuje jako Ostatní závazek (POHODA typ „commitment“).
--
--  2. „u repre jsi navíc dal odpočet DPH, což nelze“
--     → doklad umí být bez nároku na odpočet (§ 72 odst. 4 ZDPH); v exportu
--       jde celá částka včetně DPH do nákladů a členění DPH je „nonSubsume“.

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS payment_method     TEXT        NOT NULL DEFAULT 'Hotovost',
  ADD COLUMN IF NOT EXISTS vat_deductible     BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS pohoda_exported_at TIMESTAMPTZ;

ALTER TABLE accounting_invoices
  ADD COLUMN IF NOT EXISTS vat_deductible     BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS pohoda_exported_at TIMESTAMPTZ;

-- Reprezentace nárok na odpočet nikdy nemá — srovnáme i historii.
-- Repre se dosud zadávalo bez vlastní kategorie, proto i podle textu.
UPDATE receipts
SET vat_deductible = FALSE
WHERE category = 'Reprezentace'
   OR vendor ILIKE '%repre%'
   OR notes  ILIKE '%repre%';

-- Předkontace pro doklady, které se dosud vešly jen do „účtenek“
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS pohoda_predkontace_prijate TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pohoda_predkontace_repre   TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS receipts_payment_method_idx ON receipts (payment_method);
