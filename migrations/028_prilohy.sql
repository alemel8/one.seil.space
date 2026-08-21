-- ============================================================
-- one.seil.space — přílohy k záznamům (1..N na doklad)
-- ============================================================
-- Doposud uměl systém právě JEDNU přílohu na doklad, uloženou ve sloupcích
-- attachment_path/_mime/_size přímo na tabulce (migrace 022). Mzdový balíček
-- od účetní má ale 4 až 17 souborů a fakturační podklad až devět, takže se
-- to do jednoho sloupce nevejde.
--
-- Vlastník se drží „výlučným obloukem": jeden sloupec z pěti je vyplněný,
-- ostatní NULL. Proti dvojici (entity_type, entity_id) to má skutečné cizí
-- klíče a kaskádu — smazaný mzdový list po sobě nenechá 17 osiřelých řádků.
-- Cenou je jeden sloupec navíc při každé nové entitě; u pěti entit je to
-- levnější než ztráta integrity u mzdových dokladů.
--
-- Účtenky a faktury se sem NEpřevádějí. Fungují, mají vlastní UI i AI
-- vytěžování a dvojí evidence by rozbila počty v checkAttachments().

CREATE TABLE IF NOT EXISTS attachments (
  id              BIGSERIAL PRIMARY KEY,

  path            TEXT NOT NULL,              -- název souboru v data/media
  original_name   TEXT NOT NULL DEFAULT '',   -- jak se jmenoval u zdroje
  mime            TEXT NOT NULL DEFAULT 'application/octet-stream',
  size            INTEGER NOT NULL DEFAULT 0,
  sha256          TEXT,

  -- 'rozpis_prace' | 'vydajovy_doklad' | 'vystavena_faktura'
  -- | 'vyplatni_paska' | 'mzdovy_rozpis' | 'epodani_cssz' | 'prikaz_k_uhrade'
  -- | 'smluvni_dokument' | 'doklad_o_nakupu' | 'priloha_ukolu'
  category        TEXT NOT NULL DEFAULT '',
  sort_order      INTEGER NOT NULL DEFAULT 0,

  work_report_id  TEXT REFERENCES hr_work_reports(id)  ON DELETE CASCADE,
  payroll_run_id  TEXT REFERENCES hr_payroll_runs(id)  ON DELETE CASCADE,
  payroll_item_id TEXT REFERENCES hr_payroll_items(id) ON DELETE CASCADE,
  document_id     TEXT REFERENCES hr_documents(id)     ON DELETE CASCADE,
  task_id         TEXT REFERENCES tasks(id)            ON DELETE CASCADE,

  airtable_id     TEXT,
  uploaded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT attachments_jeden_vlastnik CHECK (
      (work_report_id  IS NOT NULL)::int
    + (payroll_run_id  IS NOT NULL)::int
    + (payroll_item_id IS NOT NULL)::int
    + (document_id     IS NOT NULL)::int
    + (task_id         IS NOT NULL)::int = 1
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS attachments_airtable_idx
  ON attachments (airtable_id) WHERE airtable_id IS NOT NULL;
-- Dva řádky nad jedním souborem znamenají, že si někdo přepsal doklad.
CREATE UNIQUE INDEX IF NOT EXISTS attachments_path_idx ON attachments (path);

CREATE INDEX IF NOT EXISTS attachments_work_report_idx
  ON attachments (work_report_id, sort_order)  WHERE work_report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attachments_payroll_run_idx
  ON attachments (payroll_run_id, sort_order)  WHERE payroll_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attachments_payroll_item_idx
  ON attachments (payroll_item_id)             WHERE payroll_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attachments_document_idx
  ON attachments (document_id)                 WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attachments_task_idx
  ON attachments (task_id)                     WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attachments_sha_idx
  ON attachments (sha256) WHERE sha256 IS NOT NULL;

-- ── Jedno místo, kde se hledají všechny soubory ───────────────
-- checkAttachments() dnes UNIONuje tři tabulky natvrdo v JS. S další entitou
-- by to bylo pět větví a při každé příští by se na to zapomnělo — pohled
-- drží ten kontrakt v databázi.
CREATE OR REPLACE VIEW attachment_files AS
  SELECT 'receipts'::text AS entita, id::text AS entita_id, attachment_path AS path
    FROM receipts            WHERE attachment_path IS NOT NULL
  UNION ALL
  SELECT 'accounting_invoices', id, attachment_path
    FROM accounting_invoices WHERE attachment_path IS NOT NULL
  UNION ALL
  SELECT 'users', id::text, photo
    FROM users               WHERE photo IS NOT NULL
  UNION ALL
  SELECT 'attachments', id::text, path
    FROM attachments;
