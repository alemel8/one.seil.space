-- ── Projekty: obálka nad klientem z CRM ─────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id                      TEXT PRIMARY KEY,
  company_id              TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'Aktivní',
  primary_contact_id      TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
  start_date              DATE,

  -- Brand identita
  brand_primary_color     TEXT NOT NULL DEFAULT '',
  brand_secondary_color   TEXT NOT NULL DEFAULT '',
  brand_fonts             TEXT NOT NULL DEFAULT '',
  brand_assets_url        TEXT NOT NULL DEFAULT '',
  brand_notes             TEXT NOT NULL DEFAULT '',

  -- Fakturace
  billing_payment_terms_days INT,
  billing_currency        TEXT NOT NULL DEFAULT 'CZK',
  billing_hourly_rate     DECIMAL(10,2),
  billing_notes           TEXT NOT NULL DEFAULT '',

  notes       TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  modified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id);

-- ── Podprojekty: dílčí zakázky pod projektem (Web, ERP, Eshop...) ──
CREATE TABLE IF NOT EXISTS project_items (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'V přípravě',
  description       TEXT NOT NULL DEFAULT '',
  hosting_provider  TEXT NOT NULL DEFAULT '',
  production_url    TEXT NOT NULL DEFAULT '',
  staging_url       TEXT NOT NULL DEFAULT '',
  repo_url          TEXT NOT NULL DEFAULT '',
  tech_stack        TEXT NOT NULL DEFAULT '',
  shop_id           INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  healthcheck_id    INTEGER REFERENCES healthchecks(id) ON DELETE SET NULL,
  go_live_date      DATE,
  notes             TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  modified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_items_project ON project_items(project_id);
