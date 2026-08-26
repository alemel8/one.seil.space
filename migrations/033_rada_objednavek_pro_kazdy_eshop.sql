-- ============================================================
-- one.seil.space — číselná řada objednávek nezávisle na slugu
-- ============================================================
-- Migrace 031 zakládala řadu typu 'objednavka' podmíněně na `slug =
-- 'toneracek'`. Ukázalo se, že se to netrefilo: první objednávka po nasazení
-- dostala číslo 260819926, tedy devět číslic z nouzové větve "poslední + 1"
-- v toneracek.js, ne osmiznakové YYMMXXXX z řady. Zálohová faktura přitom
-- nový formát dostala — migrace 032 ji hledá přes entity_type, ne přes slug.
--
-- Slug je konfigurace, ne identita. Řadu proto dostane každý e-shop, který
-- ji nemá, a pojmenuje se podle sebe. Druhý e-shop tak nemůže zůstat bez
-- vlastní řady a srazit se s Toneráčkem, což byl původní důvod celé změny.

INSERT INTO invoice_number_series (name, prefix, format, current_number, start_number, padding, shop_id, entity_type, active)
SELECT 'Objednávky ' || s.name, '', 'YYMMXXXX', 0, 1, 4, s.id, 'objednavka', TRUE
FROM shops s
WHERE NOT EXISTS (
  SELECT 1 FROM invoice_number_series x
  WHERE x.shop_id = s.id AND x.entity_type = 'objednavka'
);

-- Totéž pro doklady: bez vlastní řady spadne e-shop na nouzový tvar
-- v generateProformaForOrder()/generateInvoiceForOrder().
INSERT INTO invoice_number_series (name, prefix, format, current_number, start_number, padding, shop_id, entity_type, active)
SELECT 'Zálohové faktury ' || s.name, 'ZF', 'ZF-YYYYNNNN', 0, 1, 4, s.id, 'zalohova_faktura', TRUE
FROM shops s
WHERE NOT EXISTS (
  SELECT 1 FROM invoice_number_series x
  WHERE x.shop_id = s.id AND x.entity_type = 'zalohova_faktura'
);

INSERT INTO invoice_number_series (name, prefix, format, current_number, start_number, padding, shop_id, entity_type, active)
SELECT 'Vydané faktury ' || s.name, '', 'YYYYNNNN', 0, 1, 4, s.id, 'faktura', TRUE
FROM shops s
WHERE NOT EXISTS (
  SELECT 1 FROM invoice_number_series x
  WHERE x.shop_id = s.id AND x.entity_type = 'faktura'
);
