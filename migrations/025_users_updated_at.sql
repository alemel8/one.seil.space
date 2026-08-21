-- ============================================================
-- one.seil.space — kdy se naposledy měnil profil člena
-- ============================================================
-- Detail člena chce „Poslední změna" zobrazit už od migrace 012
-- (views/pages/people/member-detail.ejs), jenže sloupec nikdy nevznikl,
-- takže se ten blok nikdy nevykreslil. Doplňujeme ho teď, protože
-- u mzdových a osobních údajů je stopa, kdy je někdo naposledy měnil,
-- to nejmenší, co má systém umět.
--
-- Existující řádky dostanou datum vzniku — je to nejbližší pravda,
-- kterou zpětně máme, a lepší než NULL, který by šablona ukázala jako prázdno.

ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE users SET updated_at = created_at WHERE updated_at IS NULL;
