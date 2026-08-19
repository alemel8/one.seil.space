-- Ukládání naskenovaných/vyfocených dokladů, ze kterých vytěžujeme data.
-- Doposud se soubor poslal Claudovi na vytěžení a zahodil — účtenka po sobě
-- nezanechala žádný obrazový doklad, což účetní při kontrole potřebuje.

-- ── Účtenky: příloha (foto / PDF paragonu) ───────────────────
-- Sloupec pdf_path z 005 zůstává nepoužitý (historie), nový název odpovídá
-- konvenci u přijatých faktur, aby se obojí dalo obsloužit jedním kódem.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS attachment_path TEXT;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS attachment_mime TEXT;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS attachment_size INTEGER;

-- ── Přijaté faktury: dopočet metadat k už existující příloze ──
ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS attachment_mime TEXT;
ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS attachment_size INTEGER;

-- U dřív nahraných příloh odvodíme typ z přípony; velikost doplní až přeuložení
UPDATE accounting_invoices
SET attachment_mime = CASE
      WHEN attachment_path ILIKE '%.pdf'  THEN 'application/pdf'
      WHEN attachment_path ILIKE '%.png'  THEN 'image/png'
      WHEN attachment_path ILIKE '%.webp' THEN 'image/webp'
      ELSE 'image/jpeg'
    END
WHERE attachment_path IS NOT NULL AND attachment_mime IS NULL;
