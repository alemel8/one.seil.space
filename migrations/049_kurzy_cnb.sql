-- ============================================================
-- one.seil.space – kurzy ČNB a přepočet cizích měn na koruny
-- ============================================================
-- Přehledy sčítaly total_amount bez ohledu na měnu, takže přijatá faktura
-- na 100 EUR přidala do nákladů 100 Kč. Teď se doklad v cizí měně přepočítá
-- denním kurzem devizového trhu ČNB ke dni dokladu: DUZP, a kde chybí,
-- datum vystavení. Tak to dělá i POHODA, čísla se proto dají porovnat.
--
-- Kurzy stahuje src/kurzy-cnb.js z ročního souboru ČNB. ČNB vyhlašuje jen
-- v pracovní dny po 14:30, pro víkend, svátek a dopoledne platí poslední
-- vyhlášený kurz, proto se hledá nejbližší datum <= den dokladu.

CREATE TABLE IF NOT EXISTS kurzy_cnb (
  mena   TEXT          NOT NULL,
  datum  DATE          NOT NULL,
  kurz   NUMERIC(14,6) NOT NULL CHECK (kurz > 0),
  PRIMARY KEY (mena, datum)
);

COMMENT ON TABLE kurzy_cnb IS
  'Denní kurzy devizového trhu ČNB. datum = den vyhlášení, jen pracovní dny.';
COMMENT ON COLUMN kurzy_cnb.kurz IS
  'Kč za 1 jednotku měny. ČNB u části měn (JPY, HUF, …) uvádí kurz za 100 nebo 1000 jednotek, tady je už vydělený.';

-- Kdy se který rok naposledy stáhl a jaký poslední den v souboru byl.
-- Podle toho src/kurzy-cnb.js pozná, jestli může přibýt nový kurz.
CREATE TABLE IF NOT EXISTS kurzy_cnb_stazeni (
  rok            INT         PRIMARY KEY,
  stazeno_at     TIMESTAMPTZ NOT NULL,
  posledni_datum DATE
);

-- Kód měny tak, jak se podle něj hledá kurz. Doklady z Disku čte model
-- a místo ISO kódu může vrátit „Kč“ nebo „€“; prázdná měna jsou koruny.
CREATE OR REPLACE FUNCTION mena_kod(m TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN v IN ('', 'CZK', 'KČ', 'Kč', 'KC') THEN 'CZK'
    WHEN v IN ('€', 'EURO')                 THEN 'EUR'
    WHEN v IN ('$', 'US$')                  THEN 'USD'
    ELSE v
  END
  FROM (SELECT UPPER(BTRIM(COALESCE(m, ''))) AS v) s
$$;

-- Kurz na koruny pro doklad v měně m ze dne d. Koruny mají 1, chybějící
-- kurz NULL. Starší kurz než 14 dní se nebere: nejdelší mezera ČNB jsou
-- Vánoce, a kdyby chyběl celý stažený rok, tiše by se použil kurz z jiného.
CREATE OR REPLACE FUNCTION kurz_czk(m TEXT, d DATE) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN mena_kod(m) = 'CZK' THEN 1::numeric ELSE (
    SELECT k.kurz FROM kurzy_cnb k
     WHERE k.mena = mena_kod(m) AND k.datum <= d AND k.datum >= d - 14
     ORDER BY k.datum DESC
     LIMIT 1
  ) END
$$;

-- Částka dokladu v korunách, zaokrouhlená na haléře. NULL, když kurz chybí:
-- SUM ho přeskočí a přehled to řekne (src/finance.js), místo aby přičetl
-- eura jako koruny.
CREATE OR REPLACE FUNCTION castka_czk(castka NUMERIC, m TEXT, d DATE) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT ROUND(castka * kurz_czk(m, d), 2)
$$;
