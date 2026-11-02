-- ============================================================
-- one.seil.space – číselné řady SEIL a číslování po letech
-- ============================================================
-- Vydané faktury SEIL se dosud číslovaly v POHODĚ. Export FA.xlsx z 1. 11. 2026
-- ukazuje tři souběžné řady ve tvaru předčíslí + rok + čtyřmístné pořadí, každý
-- rok od jedničky: 21RRNNNN, 23RRNNNN a 25RRNNNN. One SEIL v nich pokračuje.
--
-- 20RRNNNN je Toneráček (formát YYYYNNNN má vlastní řadu) a RR04NNNNN opravné
-- daňové doklady, které One SEIL nevystavuje. Ty se tu nezakládají.

-- Rok, do kterého patří čítač. Řada s rokem i pořadím v čísle se v novém roce
-- vrátí na start_number (dalsiCisloRady v src/series-format.js).
ALTER TABLE invoice_number_series ADD COLUMN IF NOT EXISTS rok_citace INT;

UPDATE invoice_number_series
SET rok_citace = EXTRACT(YEAR FROM NOW() AT TIME ZONE 'Europe/Prague')::int
WHERE rok_citace IS NULL;

-- Čítač je vyšší z posledního čísla v databázi a v exportu: import čeká na
-- spuštění a v databázi nemusí být všechno, co už POHODA vystavila.
INSERT INTO invoice_number_series
  (name, prefix, format, current_number, start_number, padding, shop_id, entity_type, active, rok_citace)
SELECT v.nazev, '', v.uvod || 'YYNNNN',
       GREATEST(CASE WHEN r.rok = 2026 THEN v.z_exportu ELSE 0 END, COALESCE(m.posledni, 0)),
       1, 4, NULL, 'faktura', TRUE, r.rok
FROM (VALUES ('SEIL 21', '21', 23), ('SEIL 23', '23', 2), ('SEIL 25', '25', 11)) AS v(nazev, uvod, z_exportu)
CROSS JOIN (SELECT EXTRACT(YEAR FROM NOW() AT TIME ZONE 'Europe/Prague')::int AS rok) AS r
LEFT JOIN LATERAL (
  SELECT MAX(RIGHT(a.number, 4)::int) AS posledni
  FROM accounting_invoices a
  WHERE a.type = 'issued' AND a.number ~ ('^' || v.uvod || (r.rok % 100)::text || '[0-9]{4}$')
) AS m ON TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM invoice_number_series x WHERE x.shop_id IS NULL AND x.format = v.uvod || 'YYNNNN'
);
