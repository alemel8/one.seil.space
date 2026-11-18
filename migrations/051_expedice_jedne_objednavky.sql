-- Ruční odeslání jedné objednávky do skladu z jejího detailu.
--
-- Běh je obyčejný ruční běh expedice (kind = 'rucni'), jen vybírá jedinou
-- objednávku. Sklad dostane tentýž e-mail se štítkem jako ráno. Sloupec
-- `order_id` ho odliší od ručního běhu celé expedice ze seznamu objednávek:
-- začátek takového běhu se nesmí stát začátkem období v příštím ranním
-- e-mailu – ten by pak tvrdil „od 14:32“, a přitom nesl i objednávky
-- zaplacené dopoledne.
--
-- Bez cizího klíče schválně: je to záznam v historii a smazaná objednávka
-- z něj nesmí udělat běh celé expedice.
ALTER TABLE warehouse_dispatches ADD COLUMN IF NOT EXISTS order_id TEXT;

COMMENT ON COLUMN warehouse_dispatches.order_id IS
  'Objednávka, kterou obsluha poslala do skladu sama z detailu. NULL = běh celé expedice (ranní nebo ruční ze seznamu).';
