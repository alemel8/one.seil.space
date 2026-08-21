-- ============================================================
-- one.seil.space — personální a fakturační agenda
-- ============================================================
-- Přebírá to, co dosud žilo v Airtable základnách „Lukáš Trojek"
-- a „SEIL s.r.o.", které se ruší. Tři toky kolem jednoho člověka:
-- co se za jeho práci vyfakturovalo, co se mu vyplatilo na mzdě
-- a co dostal mimo mzdu. Rozdíl je jeho zůstatek.
--
-- Konvence: TEXT PK z generateId() jako u projects a accounting_invoices,
-- peníze NUMERIC(12,2), FK na users s RESTRICT — mzdový list se archivuje
-- 30 let a nesmí zmizet se smazaným uživatelem.

-- ── Zaměstnanecký poměr ──────────────────────────────────────
-- Vlastní tabulka, ne sloupce na users: sazba i typ úvazku se v čase mění
-- (Trojek má tři mzdové výměry, hrubá 21 300 → 23 000 → 35 000) a mzdový
-- list se musí odkázat na to, co platilo tehdy.
CREATE TABLE IF NOT EXISTS hr_employments (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL DEFAULT 'hpp'
                CHECK (kind IN ('hpp','dpp','dpc','osvc','jednatel')),
  position      TEXT NOT NULL DEFAULT '',
  started_on    DATE,
  ended_on      DATE,
  monthly_gross NUMERIC(12,2),
  hourly_rate   NUMERIC(10,2),
  currency      TEXT NOT NULL DEFAULT 'CZK',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  modified_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hr_employments_obdobi_chk
    CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on)
);
CREATE INDEX IF NOT EXISTS hr_employments_user_idx ON hr_employments (user_id, started_on DESC);

-- ── Fakturační podklad ───────────────────────────────────────
-- Jedna služební cesta nebo zakázka, ze které vznikla vydaná faktura.
CREATE TABLE IF NOT EXISTS hr_work_reports (
  id             TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  report_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  title          TEXT NOT NULL DEFAULT '',

  -- Volný rozpad hodin a výdajů, u každého záznamu jinak formátovaný
  -- („Práce 135h x 320 = 43 200,-"). Ukládá se doslova — parsovat ho
  -- by u části záznamů tiše zkomolilo čísla.
  breakdown      TEXT NOT NULL DEFAULT '',

  total_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'CZK',
  status         TEXT NOT NULL DEFAULT 'rozpracovano'
                 CHECK (status IN ('rozpracovano','k_fakturaci','odeslano','fakturovano','storno')),

  -- Vydaná faktura v systému už je; podklad se na ni odkáže, nekopíruje se.
  -- invoice_number zůstává i bez vazby, aby šlo spárovat později.
  invoice_id     TEXT REFERENCES accounting_invoices(id) ON DELETE SET NULL,
  invoice_number TEXT NOT NULL DEFAULT '',

  crm_company_id TEXT REFERENCES crm_companies(id) ON DELETE SET NULL,
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,

  notes          TEXT NOT NULL DEFAULT '',
  airtable_id    TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  modified_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS hr_work_reports_airtable_idx
  ON hr_work_reports (airtable_id) WHERE airtable_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_work_reports_user_idx    ON hr_work_reports (user_id, report_date DESC);
CREATE INDEX IF NOT EXISTS hr_work_reports_invoice_idx ON hr_work_reports (invoice_id);

-- Čísla zakázek a lokality jsou v Airtable vícehodnotová (jeden podklad
-- pokrývá i tři projekty ve dvou zemích). Nejsou to projekty SEIL, ale
-- zakázková čísla odběratele — proto vlastní tabulka, ne vazba na projects.
CREATE TABLE IF NOT EXISTS hr_work_report_projects (
  report_id    TEXT NOT NULL REFERENCES hr_work_reports(id) ON DELETE CASCADE,
  project_code TEXT NOT NULL,
  PRIMARY KEY (report_id, project_code)
);
CREATE INDEX IF NOT EXISTS hr_work_report_projects_code_idx ON hr_work_report_projects (project_code);

CREATE TABLE IF NOT EXISTS hr_work_report_locations (
  report_id TEXT NOT NULL REFERENCES hr_work_reports(id) ON DELETE CASCADE,
  city      TEXT NOT NULL,
  country   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (report_id, city, country)
);
CREATE INDEX IF NOT EXISTS hr_work_report_locations_country_idx ON hr_work_report_locations (country);

-- ── Mzdový list za jeden měsíc ───────────────────────────────
-- Jedna tabulka pro HPP i dohody: liší se vyplněná pole, ne rytmus.
-- Bez unikátního klíče na (user_id, period) — Airtable vede na některé
-- měsíce dva řádky (jeden s hodinami, druhý jen s hrubou mzdou) a sloučit
-- je při importu by byla interpretace, ne převod. UI takový měsíc označí.
CREATE TABLE IF NOT EXISTS hr_payroll_runs (
  id                 TEXT PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  employment_id      TEXT REFERENCES hr_employments(id) ON DELETE SET NULL,
  period             DATE NOT NULL,          -- vždy 1. den měsíce, ZA který mzda je

  -- dohody (u HPP zůstává NULL)
  hours              NUMERIC(8,2),
  hourly_rate        NUMERIC(10,2),
  earned             NUMERIC(12,2),          -- hodiny × sazba
  cash_paid          NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- mzdový list
  gross              NUMERIC(12,2) NOT NULL DEFAULT 0,
  net                NUMERIC(12,2) NOT NULL DEFAULT 0,
  social             NUMERIC(12,2) NOT NULL DEFAULT 0,  -- zaměstnanec i zaměstnavatel dohromady
  health             NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax                NUMERIC(12,2) NOT NULL DEFAULT 0,
  insolvency         NUMERIC(12,2) NOT NULL DEFAULT 0,
  garnishment        NUMERIC(12,2) NOT NULL DEFAULT 0,
  accident_insurance NUMERIC(12,2) NOT NULL DEFAULT 0,  -- Kooperativa

  -- Skutečný náklad zaměstnavatele (hrubá + odvody firmy). Ukládá se tak,
  -- jak přišel z mzdové účtárny, a NEDOPOČÍTÁVÁ se — u části měsíců se
  -- s dopočtem rozchází a je to skutečnost, ne chyba. Tohle číslo jde
  -- do nákladů a hrubého zisku.
  company_cost       NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Airtable „UHRAZENO" — co reálně odešlo z účtu. Generovaný sloupec se
  -- nemůže rozejít se svými složkami, takže kontrolní součet ověřuje všech
  -- sedm částek naráz. Tohle číslo jde do osobního zůstatku, ne do nákladů.
  paid_total         NUMERIC(12,2) GENERATED ALWAYS AS (
                       net + social + health + garnishment
                       + tax + insolvency + accident_insurance
                     ) STORED,

  paid               BOOLEAN NOT NULL DEFAULT FALSE,
  paid_on            DATE,
  notes              TEXT NOT NULL DEFAULT '',
  airtable_id        TEXT,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  modified_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hr_payroll_runs_period_chk CHECK (EXTRACT(DAY FROM period) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS hr_payroll_runs_airtable_idx
  ON hr_payroll_runs (airtable_id) WHERE airtable_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_payroll_runs_user_idx   ON hr_payroll_runs (user_id, period DESC);
CREATE INDEX IF NOT EXISTS hr_payroll_runs_period_idx ON hr_payroll_runs (period DESC);

-- ── Platby mimo mzdu ─────────────────────────────────────────
-- Sjednocuje Trojkovy „Extra výdaje" (zálohy, DPPO, O2 tarif) a Heříkovy
-- řádky s Extra Bonusem (tablet, sluchátka), které Airtable míchal mezi
-- mzdy. Částka je vždy kladná, směr nese kind.
--
-- Rozlišení kind je zásadní pro účetnictví: záloha není náklad, je to
-- pohledávka za zaměstnancem (335). Kdyby zálohy vstupovaly do nákladů,
-- nafoukly by je o statisíce a hrubý zisk by byl nesmysl.
CREATE TABLE IF NOT EXISTS hr_payroll_items (
  id             TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  employment_id  TEXT REFERENCES hr_employments(id)  ON DELETE SET NULL,
  payroll_run_id TEXT REFERENCES hr_payroll_runs(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL DEFAULT 'zaloha'
                 CHECK (kind IN ('zaloha','proplaceny_naklad','odmena','srazka','jine')),
  paid_on        DATE NOT NULL,
  period         DATE,
  amount         NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency       TEXT NOT NULL DEFAULT 'CZK',
  description    TEXT NOT NULL DEFAULT '',
  receipt_id     INTEGER REFERENCES receipts(id) ON DELETE SET NULL,
  account_debit  TEXT NOT NULL DEFAULT '',
  account_credit TEXT NOT NULL DEFAULT '',
  airtable_id    TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  modified_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS hr_payroll_items_airtable_idx
  ON hr_payroll_items (airtable_id) WHERE airtable_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_payroll_items_user_idx ON hr_payroll_items (user_id, paid_on DESC);
CREATE INDEX IF NOT EXISTS hr_payroll_items_kind_idx ON hr_payroll_items (kind);

-- ── Osobní a smluvní dokumenty ───────────────────────────────
-- Kategorie je volný text, ne CHECK: v Airtable je vyplněná u tří záznamů
-- z deseti a zbytek by CHECK odmítl. Odvozuje se z názvu dokumentu.
CREATE TABLE IF NOT EXISTS hr_documents (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  employment_id TEXT REFERENCES hr_employments(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT '',
  document_date DATE,
  valid_from    DATE,
  valid_to      DATE,
  signed        BOOLEAN NOT NULL DEFAULT FALSE,
  notes         TEXT NOT NULL DEFAULT '',
  airtable_id   TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  modified_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS hr_documents_airtable_idx
  ON hr_documents (airtable_id) WHERE airtable_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_documents_user_idx ON hr_documents (user_id, document_date DESC);
