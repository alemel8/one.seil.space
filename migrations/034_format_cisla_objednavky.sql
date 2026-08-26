-- ============================================================
-- one.seil.space — přepsat formát čísla objednávky na YYMMXXXX
-- ============================================================
-- Migrace 031 i 033 zakládaly řadu typu 'objednavka' jen tehdy, když ještě
-- žádná neexistovala. Toneráček ji ale měl už dřív, s formátem YYMMXXXDD
-- (rok, měsíc, tři náhodné číslice, den) — devět číslic, například
-- 260819926 pro 26. 8. 2026. Obě migrace ji proto tiše přeskočily a čísla
-- zůstala v původním tvaru.
--
-- Přeskočit existující řadu bylo správně: přepisovat cizí konfiguraci mimochodem
-- se nemá. Tady je to ale vědomé rozhodnutí, takže UPDATE, ne INSERT.
--
-- Den na konci čísla mizí schválně: prozrazuje, kdy objednávka vznikla, a
-- s YYMM na začátku je to zbytečná duplicita. Náhodná část se rozšiřuje ze
-- tří číslic na čtyři, tedy z tisíce na deset tisíc kombinací za měsíc.
-- Kolize hlídá UNIQUE (shop_id, order_number) a přelosování v toneracek.js.

UPDATE invoice_number_series
SET format = 'YYMMXXXX'
WHERE entity_type = 'objednavka'
  AND shop_id IS NOT NULL
  AND format IS DISTINCT FROM 'YYMMXXXX';
