-- ============================================================
-- one.seil.space — číslo objednávky YYMMXXXX a DPH na dokladech
-- ============================================================
-- Objednávky Toneráčku se dosud číslovaly prostou sekvencí od 10001, protože
-- e-shop neměl založenou řadu typu 'objednavka' a toneracek.js spadl na
-- větev "poslední číslo + 1". Číslo tak neneslo žádnou informaci a u druhého
-- e-shopu by se s Toneráčkem srazilo hned na prvním záznamu.
--
-- Nový tvar YYMMXXXX (rok, měsíc, čtyři náhodné číslice) drží pořadí v čase
-- bez toho, aby prozrazoval, kolik objednávek e-shop má. Tokeny umí
-- renderSeriesNumber() od migrace 015, takže je to čistě otázka konfigurace.
--
-- Pozor: formát bez tokenu N nemá pořadové číslo, takže unikátnost stojí jen
-- na losování. Hlídá ji UNIQUE (shop_id, order_number) z migrace 001 a
-- přelosování v toneracek.js; deset tisíc kombinací na měsíc a e-shop je pro
-- současný objem řádově dost.

INSERT INTO invoice_number_series (name, prefix, format, current_number, start_number, padding, shop_id, entity_type, active)
SELECT 'Objednávky Toneráček', '', 'YYMMXXXX', 0, 1, 4, s.id, 'objednavka', TRUE
FROM shops s
WHERE s.slug = 'toneracek'
  AND NOT EXISTS (
    SELECT 1 FROM invoice_number_series x
    WHERE x.shop_id = s.id AND x.entity_type = 'objednavka'
  );

-- ── DPH ──────────────────────────────────────────────────────
-- SEIL s.r.o. je plátce DPH a generateInvoiceForOrder() vystavuje doklady
-- e-shopu s 21 % od začátku. company_settings ale drží ze seedu migrace 001
-- poznámku "Nejsme plátci DPH." a vat_payer se od té doby nikdo nedotkl —
-- na faktuře se tedy tiskla věta, která odporovala rozpisu DPH pár řádků nad
-- ní. Opravujeme jen hodnoty, které pořád sedí na seed; ručně vyplněné
-- nastavení zůstává, jak je.
UPDATE company_settings SET vat_payer = TRUE WHERE vat_payer = FALSE;
UPDATE company_settings SET invoice_note = '' WHERE invoice_note = 'Nejsme plátci DPH.';
