-- ============================================================
-- one.seil.space — úkoly a měření času (stopky)
-- ============================================================
-- Nahrazuje Airtable tabulky Tasks a Timetracker. Cílem není archiv,
-- ale živý nástroj: z naměřeného času se počítá měsíční odměna
-- u lidí na hodinovou sazbu.

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  code            TEXT,                       -- „GUK-467" z Airtable, nebo dopočtené
  seq             INTEGER,
  company_id      TEXT REFERENCES crm_companies(id) ON DELETE SET NULL,
  project_id      TEXT REFERENCES projects(id)      ON DELETE SET NULL,
  project_item_id TEXT REFERENCES project_items(id) ON DELETE SET NULL,
  parent_id       TEXT REFERENCES tasks(id)         ON DELETE SET NULL,

  kind            TEXT NOT NULL DEFAULT 'ukol',
  status          TEXT NOT NULL DEFAULT 'todo'
                  CHECK (status IN ('todo','in_progress','testing','on_hold','done')),
  -- Airtable mělo „6 | Needed " — číslo řadí, text popisuje.
  priority        SMALLINT CHECK (priority BETWEEN 1 AND 10),
  priority_label  TEXT NOT NULL DEFAULT '',

  summary         TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  start_date      DATE,
  due_date        DATE,
  done_at         TIMESTAMPTZ,
  billable        BOOLEAN NOT NULL DEFAULT TRUE,

  assignee_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- Naměřený čas se ZÁMĚRNĚ neukládá: dopočítá se z time_entries.
  -- Uložená kopie by se rozešla první spuštěnou stopkou a zabila by
  -- kontrolu „součet záznamů == rollup z Airtable".

  airtable_id     TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  modified_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_airtable_idx ON tasks (airtable_id) WHERE airtable_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_code_idx     ON tasks (code) WHERE code IS NOT NULL AND code <> '';
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assignee_id, status);
CREATE INDEX IF NOT EXISTS tasks_company_idx  ON tasks (company_id);
CREATE INDEX IF NOT EXISTS tasks_parent_idx   ON tasks (parent_id);

CREATE TABLE IF NOT EXISTS time_entries (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Bez úkolu měření povolujeme: člověk zapne stopky dřív, než ví, co to je.
  task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','meeting')),

  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ,                    -- NULL = běží

  -- V datech z Airtable jsou i záznamy se shodným startem a koncem
  -- (omylem spuštěné stopky), takže nula je legitimní hodnota.
  duration_seconds INTEGER GENERATED ALWAYS AS (
    CASE WHEN ended_at IS NULL THEN NULL
         ELSE GREATEST(0, EXTRACT(EPOCH FROM (ended_at - started_at))::integer) END
  ) STORED,

  note        TEXT NOT NULL DEFAULT '',
  billable    BOOLEAN NOT NULL DEFAULT TRUE,
  hourly_rate NUMERIC(10,2),                  -- sazba platná v době měření
  source      TEXT NOT NULL DEFAULT 'stopky'
              CHECK (source IN ('stopky','rucne','import')),
  airtable_id TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT time_entries_poradi_chk CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_airtable_idx
  ON time_entries (airtable_id) WHERE airtable_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS time_entries_user_idx ON time_entries (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS time_entries_task_idx ON time_entries (task_id);

-- Jedny běžící stopky na člověka. Hlídá to databáze, ne session — funguje
-- to napříč zařízeními a nejde to obejít dvojklikem ani druhou záložkou.
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_running_idx
  ON time_entries (user_id) WHERE ended_at IS NULL;
