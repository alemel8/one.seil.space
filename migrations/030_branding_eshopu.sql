-- ============================================================
-- one.seil.space — identita e-shopu v e-mailech
-- ============================================================
-- Zákazník Toneráčku dostával nejdůležitější zprávu celé objednávky —
-- „vyřízena, faktura v příloze, tady je sledovací číslo" — od SEIL s.r.o.
-- <noreply@seil.cz>, tedy od firmy, o které nikdy neslyšel. Odesílatel
-- e-shopu byl přitom v kódu na čtyřech místech natvrdo (src/email.js:8, 40,
-- 96 a src/routes/toneracek.js), takže druhý e-shop by posílal svá storna
-- jako Toneráček.
--
-- Identita e-mailu je vlastnost e-shopu, ne konstanta v kódu. Tahle migrace
-- z ní dělá řádek v databázi, takže přidat Dílnu Vlněnku znamená vyplnit
-- formulář, ne forkovat šablony.
--
-- Konvence: typované sloupce, ne shops.config JSONB. Ten je od migrace 001
-- prázdný a nikdo ho nečte — a nejvíc na očích viditelný obsah v celém
-- systému není místo, kde tuhle tradici začínat. Přes HTTP to čtou dvě
-- aplikace a `config->>'colorPrimary'` místo `color_primary` je tichý NULL,
-- který se projeví až prázdným přechodem v cizí schránce. TEXT NOT NULL
-- DEFAULT '' dává definované „nevyplněno", nad kterým jde postavit formulář
-- i tvrdá kontrola.
--
-- Bankovní účet, IBAN ani formát variabilního symbolu tu schválně nejsou.
-- To je účetnictví, ne branding — patří vystavovateli (company_settings),
-- a právě proto, že je e-shop měl vlastní, chodily zákazníkovi dva různé
-- variabilní symboly k jedné platbě.

-- ── Identita odesílatele ─────────────────────────────────────
ALTER TABLE shops ADD COLUMN IF NOT EXISTS email_from_name     TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS email_from_address  TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS email_reply_to      TEXT NOT NULL DEFAULT '';

-- ── Kontakt v patičce a v textech ────────────────────────────
ALTER TABLE shops ADD COLUMN IF NOT EXISTS support_email       TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS support_phone       TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS support_phone_link  TEXT NOT NULL DEFAULT '';

-- ── Vzhled ───────────────────────────────────────────────────
-- Tři odstíny, protože hlavička e-shopu je přechod přes tři body
-- (linear-gradient(135deg,#0e7490,#0891b2,#06b6d4)) a e-mail ze Seilu
-- musí vypadat stejně, ne podobně.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS tagline               TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS claim                 TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS logo_mark_url         TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS logo_wordmark_url     TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS color_primary         TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS color_primary_dark    TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS color_primary_light   TEXT NOT NULL DEFAULT '';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS color_on_primary_soft TEXT NOT NULL DEFAULT '';

-- ── Pojistka proti prosáknutí firemní identity ───────────────
-- Zákaznický e-mail se nikdy nesmí odeslat z domény SEILu. V kódu to hlídá
-- ještě jedno hrdlo (deliver() v src/email.js), tohle je druhá pojistka pro
-- případ, že někdo hodnotu přepíše přímo v databázi. ADD CONSTRAINT
-- IF NOT EXISTS u CHECK Postgres neumí, proto DO blok.
DO $$ BEGIN
  ALTER TABLE shops ADD CONSTRAINT shops_email_from_not_seil_chk
    CHECK (email_from_address = '' OR email_from_address NOT ILIKE '%@seil.cz');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Toneráček ────────────────────────────────────────────────
-- Hodnoty odpovídají tomu, co dnes vykresluje src/lib/email.ts e-shopu,
-- aby se po nasazení nic nezměnilo vizuálně — mění se jen to, odkud se berou.
-- Výjimka je odesílatel: z ahoj@toneracek.cz se stává noreply@toneracek.cz
-- a ahoj@ zůstává jako reply-to, aby odpověď zákazníka měla kam dojít.
INSERT INTO shops (slug, name, url) VALUES ('toneracek', 'Toneráček.cz', 'https://toneracek.cz')
ON CONFLICT (slug) DO NOTHING;

UPDATE shops SET
  email_from_name       = 'Toneráček.cz',
  email_from_address    = 'noreply@toneracek.cz',
  email_reply_to        = 'ahoj@toneracek.cz',
  support_email         = 'ahoj@toneracek.cz',
  support_phone         = '728 749 931',
  support_phone_link    = '+420728749931',
  tagline               = 'Správná náplň pro vaši tiskárnu',
  claim                 = 'Nenechte tiskárnu žíznit',
  logo_mark_url         = 'https://toneracek.cz/images/logo.png',
  logo_wordmark_url     = 'https://toneracek.cz/images/header_logo.jpeg',
  color_primary         = '#0891b2',
  color_primary_dark    = '#0e7490',
  color_primary_light   = '#06b6d4',
  color_on_primary_soft = '#cffafe'
WHERE slug = 'toneracek';
