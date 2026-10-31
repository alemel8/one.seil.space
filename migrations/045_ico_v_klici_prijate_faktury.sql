-- IČO v klíči přijaté faktury: 28115708, CZ28115708 a cz28115708 jsou tentýž dodavatel.
-- Do pole IČO se občas dostane DIČ a index z 044 bral tyhle zápisy jako různé
-- dodavatele, takže stejná faktura prošla dvakrát.
--
-- ico_klic je jediná definice klíče pro index i dotazy (src/prijata-faktura.js,
-- src/gdrive-import.js). Stejná pravidla drží v JS scripts/lib/dodavatel.js, shodu
-- hlídá test/migrace-045.test.js. Zahodí se všechno kromě písmen a číslic, písmena se
-- sjednotí na velká, odstraní se CZ na začátku a úvodní nuly; co nezbude, je bez IČO.
-- DIČ fyzické osoby je CZ + rodné číslo, s IČO se tedy nespáruje.
--
-- Od nasazení 044 mohly vzniknout dvojice, které nový klíč nepustí. Server bez
-- proběhlých migrací nenastartuje, proto při kolizi zůstane index z 044 a zapíše se
-- jen varování. Dotazy s ico_klic platí i tak.
--
-- Zámek a pořadí jako v 044: DROP bere výhradní zámek do COMMIT, stavba trvá kolem 20 ms
-- nad 5 000 řádků. lock_timeout 2 s: za cizí transakcí radši spadnout a zkusit to znovu.

SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ico_klic(ico text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT NULLIF(ltrim(regexp_replace(upper(regexp_replace(ico, '[^0-9A-Za-z]', '', 'g')), '^CZ', ''), '0'), '')
  $$;

DO $$
BEGIN
  DROP INDEX IF EXISTS accounting_invoices_received_number_supplier_idx;
  CREATE UNIQUE INDEX accounting_invoices_received_number_supplier_idx
    ON accounting_invoices (number, (COALESCE(ico_klic(supplier_ico), lower(btrim(supplier)))))
    WHERE type = 'received' AND number <> '';
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'Migrace 045: faktury se stejným číslem a IČO v jiném zápisu, index zůstává z migrace 044';
END $$;
