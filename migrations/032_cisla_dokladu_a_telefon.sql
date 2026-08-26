-- ============================================================
-- one.seil.space — formáty čísel dokladů e-shopu a kontaktní telefon
-- ============================================================
-- Číslo dokladu se skládalo z prefixu, roku a pořadí oddělených pomlčkami
-- (ZF-2026-0042). Pomlčky nesou nulovou informaci, ale rozbíjejí variabilní
-- symbol: banka bere jen číslice, takže z "ZF-2026-0042" vznikalo 20260042,
-- kdežto na dokladu stálo něco jiného. Bez pomlček je číslo dokladu a jeho
-- variabilní symbol totéž.
--
--   zálohová faktura   ZF-20260042   (prefix ZF zůstává, ať je typ poznat)
--   vydaná faktura     20260001      (rok + pořadí od jedné)
--
-- Rozsah: záměrně jen řady e-shopu (shop_id vyplněné). Řady, kterými SEIL
-- fakturuje mimo e-shop (shop_id IS NULL), zůstávají beze změny — změna
-- číslování B2B faktur uprostřed roku je účetní rozhodnutí, ne důsledek
-- úprav e-mailů e-shopu.

UPDATE invoice_number_series
SET format = 'ZF-YYYYNNNN'
WHERE entity_type = 'zalohova_faktura' AND shop_id IS NOT NULL;

UPDATE invoice_number_series
SET format = 'YYYYNNNN'
WHERE entity_type = 'faktura' AND shop_id IS NOT NULL;

-- Kdyby e-shop některou z řad neměl, doklady by spadly na nouzový tvar
-- v generateProformaForOrder()/generateInvoiceForOrder() a čísla by se
-- s Toneráčkem srazila, jakmile přibude druhý e-shop.
INSERT INTO invoice_number_series (name, prefix, format, current_number, start_number, padding, shop_id, entity_type, active)
SELECT 'Zálohové faktury Toneráček', 'ZF', 'ZF-YYYYNNNN', 0, 1, 4, s.id, 'zalohova_faktura', TRUE
FROM shops s
WHERE s.slug = 'toneracek'
  AND NOT EXISTS (SELECT 1 FROM invoice_number_series x
                  WHERE x.shop_id = s.id AND x.entity_type = 'zalohova_faktura');

INSERT INTO invoice_number_series (name, prefix, format, current_number, start_number, padding, shop_id, entity_type, active)
SELECT 'Vydané faktury Toneráček', '', 'YYYYNNNN', 0, 1, 4, s.id, 'faktura', TRUE
FROM shops s
WHERE s.slug = 'toneracek'
  AND NOT EXISTS (SELECT 1 FROM invoice_number_series x
                  WHERE x.shop_id = s.id AND x.entity_type = 'faktura');

-- ── Kontaktní telefon ────────────────────────────────────────
UPDATE shops
SET support_phone = '721 012 685', support_phone_link = '+420721012685'
WHERE support_phone = '728 749 931' OR support_phone_link = '+420728749931';
