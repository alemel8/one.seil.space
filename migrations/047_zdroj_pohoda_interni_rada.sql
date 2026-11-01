-- Zdroj dokladu, stav v POHODĚ a interní číselná řada přijatých dokladů.

-- ── Zdroj a evidence v POHODĚ ────────────────────────────────
-- source: odkud doklad přišel (rucne, gdrive, pohoda, eshop, sablona).
-- pohoda_v_evidenci: doklad v POHODĚ je, přišel z jejího exportu nebo ho v něm našel
-- import. pohoda_exported_at dál znamená, že jsme pro POHODU vygenerovali XML.
ALTER TABLE accounting_invoices
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'rucne'
    CHECK (source IN ('rucne', 'gdrive', 'pohoda', 'eshop', 'sablona')),
  ADD COLUMN IF NOT EXISTS pohoda_v_evidenci BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS internal_number TEXT;

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS internal_number TEXT;

-- Původ se dřív neukládal, u starých řádků se pozná podle stop. Číslo z POHODY má
-- u přijatých tvar RR11NNNNN, u vydaných 8 nebo 9 číslic; ověřeno na exportech
-- FA-pri.xlsx a FA.xlsx z 1. 11. 2026. U faktury z Disku je v number číslo dodavatele,
-- které může mít stejný tvar, a falešné V POHODĚ by ji vyřadilo z exportu. Spárovanou
-- s POHODOU pozná supplier_number a případně ji označí další běh importu.
UPDATE accounting_invoices SET source = CASE
    WHEN supplier_number <> '' OR (gdrive_file_id IS NULL AND number ~ '^[0-9]{2}11[0-9]{5}$') THEN 'pohoda'
    WHEN gdrive_file_id IS NOT NULL THEN 'gdrive'
    ELSE 'rucne'
  END
WHERE type = 'received';

UPDATE accounting_invoices SET source = CASE
    WHEN order_id IS NOT NULL THEN 'eshop'
    WHEN series_id IS NOT NULL THEN 'rucne'
    WHEN number ~ '^[0-9]{8,9}$' THEN 'pohoda'
    ELSE 'rucne'
  END
WHERE type IN ('issued', 'proforma');

UPDATE accounting_invoices SET pohoda_v_evidenci = TRUE WHERE source = 'pohoda';

-- ── Interní řada: PF26-0001 přijaté faktury, UC26-0001 účtenky ───
-- Rok je podle data dokladu, řada začíná 1. 1. 2026, starší doklady číslo nemají.
-- rok jsou poslední dvě číslice jako v čísle: překlep 2126 místo 2026 by jinak dal
-- znovu PF26-0001 a založení by spadlo na duplicitě.
CREATE TABLE IF NOT EXISTS interni_rady (
  druh     TEXT NOT NULL,
  rok      INT  NOT NULL,
  posledni INT  NOT NULL,
  PRIMARY KEY (druh, rok)
);

-- Čítač se mění ve stejné transakci jako doklad: nepovedené založení číslo nespotřebuje.
CREATE OR REPLACE FUNCTION dalsi_interni_cislo(p_druh TEXT, p_datum DATE) RETURNS TEXT AS $$
  INSERT INTO interni_rady AS r (druh, rok, posledni)
  VALUES (p_druh, EXTRACT(YEAR FROM p_datum)::int % 100, 1)
  ON CONFLICT (druh, rok) DO UPDATE SET posledni = r.posledni + 1
  RETURNING p_druh || to_char(p_datum, 'YY') || '-'
    || repeat('0', GREATEST(4 - length(posledni::text), 0)) || posledni::text;
$$ LANGUAGE sql;

-- Staré doklady chronologicky, ve shodě dne podle čísla, ať je pořadí opakovatelné.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id, issue_date FROM accounting_invoices
    WHERE type = 'received' AND issue_date >= DATE '2026-01-01' AND internal_number IS NULL
    ORDER BY issue_date, number, id
  LOOP
    UPDATE accounting_invoices SET internal_number = dalsi_interni_cislo('PF', r.issue_date) WHERE id = r.id;
  END LOOP;
  FOR r IN
    SELECT id, receipt_date FROM receipts
    WHERE receipt_date >= DATE '2026-01-01' AND internal_number IS NULL
    ORDER BY receipt_date, id
  LOOP
    UPDATE receipts SET internal_number = dalsi_interni_cislo('UC', r.receipt_date) WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_invoices_internal_number_idx
  ON accounting_invoices (internal_number) WHERE internal_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS receipts_internal_number_idx
  ON receipts (internal_number) WHERE internal_number IS NOT NULL;

-- Trigger, ne kód aplikace: faktury zakládá Disk, formulář i importní skripty a žádná
-- z těch cest na číslo nesmí zapomenout. Oprava data na rok 2026 číslo doplní,
-- přidělené číslo se opravou data nemění.
CREATE OR REPLACE FUNCTION prijata_faktura_interni_cislo() RETURNS trigger AS $$
BEGIN
  IF NEW.type = 'received' AND NEW.internal_number IS NULL AND NEW.issue_date >= DATE '2026-01-01' THEN
    NEW.internal_number := dalsi_interni_cislo('PF', NEW.issue_date);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION uctenka_interni_cislo() RETURNS trigger AS $$
BEGIN
  IF NEW.internal_number IS NULL AND NEW.receipt_date >= DATE '2026-01-01' THEN
    NEW.internal_number := dalsi_interni_cislo('UC', NEW.receipt_date);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prijata_faktura_interni_cislo ON accounting_invoices;
CREATE TRIGGER prijata_faktura_interni_cislo
  BEFORE INSERT OR UPDATE OF issue_date ON accounting_invoices
  FOR EACH ROW EXECUTE FUNCTION prijata_faktura_interni_cislo();

DROP TRIGGER IF EXISTS uctenka_interni_cislo ON receipts;
CREATE TRIGGER uctenka_interni_cislo
  BEFORE INSERT OR UPDATE OF receipt_date ON receipts
  FOR EACH ROW EXECUTE FUNCTION uctenka_interni_cislo();
