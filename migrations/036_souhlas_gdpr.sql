-- ============================================================
-- one.seil.space — kdy zákazník dal souhlas se zpracováním údajů
-- ============================================================
-- Registrační formulář e-shopu souhlas vyžaduje a bez zaškrtnutí nepustí dál
-- (`AuthModal.tsx`: „Souhlas se zpracováním osobních údajů je povinný"), ale
-- do Seilu se ta hodnota nikdy neposílala. Souhlas se tedy vybíral a hned
-- zahazoval — doložit ho nešlo.
--
-- Ukládá se čas, ne ano/ne. Samotné „ano" je slabý důkaz; u souhlasu je
-- podstatné, kdy byl dán, protože se váže na tehdejší znění podmínek.
-- Prázdná hodnota znamená „nemáme záznam", ne „nesouhlasil".
--
-- Zpětně se nedoplňuje. U kontaktů založených dřív souhlas doložit neumíme
-- a vymýšlet si datum by bylo horší než přiznat, že chybí.

ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS gdpr_consent_at TIMESTAMPTZ;

COMMENT ON COLUMN crm_contacts.gdpr_consent_at IS
  'Kdy zákazník potvrdil souhlas se zpracováním osobních údajů. NULL = nemáme záznam.';
