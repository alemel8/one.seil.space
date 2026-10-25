-- ============================================================
-- one.seil.space — druhý e-shop: vlastní klíče, webhook a účty po e-shopech
-- ============================================================
-- Dílna Vlněnka má jezdit přes One SEIL přesně jako Toneráček, jen pod
-- vlastním klíčem a s vlastními zákaznickými účty. Toneráček přitom zůstává
-- beze změny: dál chodí na /api/toneracek s klíčem z TONERACEK_API_KEY a jeho
-- účty dál žijí v crm_contacts. Nic tu proto nepřepisuje existující data
-- ani výchozí hodnoty existujících sloupců — jen přidává.
--
-- Bezpečné na živé databázi: jen CREATE … IF NOT EXISTS a ADD COLUMN
-- IF NOT EXISTS s konstantní (nebo stabilní) výchozí hodnotou, což Postgres
-- od verze 11 zapíše do katalogu bez přepisu tabulky. lock_timeout hlídá, ať
-- se ALTER na `shops` nezařadí za dlouhou transakci a nezablokuje za sebou
-- každý dotaz Toneráčku — radši ať start spadne a zkusí se znovu.

SET LOCAL lock_timeout = '5s';

-- ── Klíče pro /api/eshop ──────────────────────────────────────
-- Schválně ne `api_keys`. Starší /api/v1 přijme kterýkoli aktivní klíč
-- z `api_keys` a jeho zákaznické endpointy čtou a mění všechny kontakty
-- v CRM — klíč Dílny uložený tam by tedy otevřel i zákazníky Toneráčku
-- a obchodní partnery SEILu.
--
-- Ukládá se jen SHA-256 otisk. Klíč se ukáže jednou při vygenerování;
-- kdo má přístup k databázi nebo k zálohám, z otisku klíč nezíská.

CREATE TABLE IF NOT EXISTS eshop_api_keys (
  id           SERIAL PRIMARY KEY,
  shop_id      INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL DEFAULT '',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  CONSTRAINT eshop_api_keys_hash_chk CHECK (key_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS eshop_api_keys_shop_idx ON eshop_api_keys (shop_id);

COMMENT ON TABLE eshop_api_keys IS
  'Klíče pro /api/eshop/* — jen SHA-256 otisk (hex). Klíč určuje e-shop, každý dotaz API je omezený na jeho shop_id.';

-- ── Tajemství pro volání One SEIL → e-shop ────────────────────
-- Podání balíku (POST {shops.url}/api/orders/podat-balik) se podepisuje
-- hlavičkou x-webhook-secret. Dosud jedna globální SHOP_WEBHOOK_SECRET pro
-- všechny e-shopy, takže by Dílna musela znát tajemství Toneráčku a únik
-- z jednoho e-shopu by otevřel podávání balíků u druhého.
-- Prázdné = platí globální SHOP_WEBHOOK_SECRET (Toneráček tak jede dál).

ALTER TABLE shops ADD COLUMN IF NOT EXISTS webhook_secret TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN shops.webhook_secret IS
  'x-webhook-secret pro volání e-shopu (podat-balik). Prázdné = globální SHOP_WEBHOOK_SECRET.';

-- ── Zákaznické účty po e-shopech ──────────────────────────────
-- crm_contact_shops existuje od migrace 001 a nikdo ho nečte ani nepíše.
-- Účty Toneráčku žijí v crm_contacts (is_registered, notes = záložní hash
-- hesla, marketing_consent, gdpr_consent_at) a /api/toneracek je odtamtud
-- čte. Kdyby Dílna psala do týchž sloupců, heslo z Dílny by fungovalo na
-- Toneráčku, registrace na Dílně by skončila 409 u každého zákazníka
-- Toneráčku a souhlas daný Dílně by platil i pro Toneráček.
--
-- Účet e-shopu na /api/eshop je proto řádek (kontakt, e-shop) tady. Kontakt
-- v CRM zůstává jeden na e-mail, registrace, souhlasy a heslo jsou po
-- e-shopech.
--
-- POZOR: is_registered má od migrace 001 výchozí TRUE. Výchozí hodnota se
-- tu schválně nemění (zásah do existujícího sloupce); kód /api/eshop zapisuje
-- is_registered vždy výslovně — FALSE u hosta z objednávky, TRUE jen při
-- registraci.

ALTER TABLE crm_contact_shops ADD COLUMN IF NOT EXISTS password_backup TEXT NOT NULL DEFAULT '';
ALTER TABLE crm_contact_shops ADD COLUMN IF NOT EXISTS gdpr_consent_at TIMESTAMPTZ;
ALTER TABLE crm_contact_shops ADD COLUMN IF NOT EXISTS active          BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE crm_contact_shops ADD COLUMN IF NOT EXISTS modified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Profil, jak ho zákazník vidí v účtu tohohle e-shopu. NULL = převzít údaj
-- z crm_contacts. Sdílený kontakt se z /api/eshop jen doplňuje tam, kde je
-- prázdný — jinak by úprava profilu na Dílně přepsala, co zákazník vidí na
-- Toneráčku. Bez vlastních sloupců by ale zákazník Dílny nemohl změnit
-- ani vlastní telefon.
ALTER TABLE crm_contact_shops ADD COLUMN IF NOT EXISTS first_name   TEXT;
ALTER TABLE crm_contact_shops ADD COLUMN IF NOT EXISTS last_name    TEXT;
ALTER TABLE crm_contact_shops ADD COLUMN IF NOT EXISTS phone        TEXT;
ALTER TABLE crm_contact_shops ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE crm_contact_shops ADD COLUMN IF NOT EXISTS address      TEXT;
ALTER TABLE crm_contact_shops ADD COLUMN IF NOT EXISTS city         TEXT;
ALTER TABLE crm_contact_shops ADD COLUMN IF NOT EXISTS zip          TEXT;

-- Úklid a výpisy hledají zákazníky jednoho e-shopu; PK začíná contact_id.
CREATE INDEX IF NOT EXISTS crm_contact_shops_shop_idx ON crm_contact_shops (shop_id);

COMMENT ON COLUMN crm_contact_shops.is_registered IS
  'Má účet v tomhle e-shopu (/api/eshop). Výchozí TRUE je z migrace 001 — kód vždy zapisuje výslovně. Účty Toneráčku jsou v crm_contacts.is_registered.';
COMMENT ON COLUMN crm_contact_shops.password_backup IS
  'Záložní kopie bcrypt hashe hesla z e-shopu (PWDHASH:…), obdoba crm_contacts.notes u Toneráčku. Ven jen přes ?withNote=1.';
COMMENT ON COLUMN crm_contact_shops.gdpr_consent_at IS
  'Kdy zákazník potvrdil souhlas se zpracováním údajů v tomhle e-shopu. NULL = nemáme záznam.';
