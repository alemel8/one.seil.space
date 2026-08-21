-- ============================================================
-- one.seil.space — mzdové účty do účetní osnovy
-- ============================================================
-- Osnova ze seedu v migraci 007 má nákladové účty 521, 527 a 528, ale
-- chybí jí rozvahové účty, na kterých mzda skutečně sedí: závazek vůči
-- zaměstnanci, odvody institucím a záloha na daň. Bez nich nejde
-- mzdový doklad předkontovat.

INSERT INTO accounting_chart (code, name) VALUES
  ('331', 'Zaměstnanci'),
  ('333', 'Ostatní závazky vůči zaměstnancům'),
  ('336', 'Zúčtování s institucemi sociálního zabezpečení a zdravotního pojištění'),
  ('342', 'Ostatní přímé daně'),
  ('379', 'Jiné závazky'),
  ('524', 'Zákonné sociální pojištění'),
  ('525', 'Ostatní sociální pojištění')
ON CONFLICT (code) DO NOTHING;
