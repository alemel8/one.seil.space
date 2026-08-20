-- ============================================================
-- one.seil.space — veřejné ID uživatele + přístupová matice
-- ============================================================

-- ── Veřejné ID ───────────────────────────────────────────────
-- V URL (/lide/tym/<public_id>) místo pořadového čísla, aby se
-- uživatelé nedali procházet inkrementem a ID zůstalo stabilní.

ALTER TABLE users ADD COLUMN IF NOT EXISTS public_id TEXT;

-- Výchozí hodnota na úrovni databáze, aby na ni nemohl zapomenout žádný
-- INSERT (routy, create-superuser, importní skripty).
ALTER TABLE users ALTER COLUMN public_id
  SET DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);

UPDATE users
   SET public_id = substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
 WHERE public_id IS NULL OR public_id = '';

CREATE UNIQUE INDEX IF NOT EXISTS users_public_id_idx ON users (public_id);

ALTER TABLE users ALTER COLUMN public_id SET NOT NULL;

-- ── Přístupová matice ────────────────────────────────────────
-- Řádek = konkrétní sekce/záložka pro konkrétního uživatele.
-- Chybějící řádek znamená „vidí“ (viz src/access.js), takže
-- nasazení migrace nikomu nic neodebere.

CREATE TABLE IF NOT EXISTS user_access (
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_key TEXT        NOT NULL,
  allowed    BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, access_key)
);

CREATE INDEX IF NOT EXISTS user_access_user_idx ON user_access (user_id);
