-- HTTP Healthchecks: konfigurace sledovaných URL
CREATE TABLE IF NOT EXISTS healthchecks (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  url         TEXT        NOT NULL,
  interval_s  INT         NOT NULL DEFAULT 300,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Výsledky jednotlivých pingů
CREATE TABLE IF NOT EXISTS healthcheck_results (
  id           SERIAL PRIMARY KEY,
  check_id     INT         NOT NULL REFERENCES healthchecks(id) ON DELETE CASCADE,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_code  INT,
  ok           BOOLEAN     NOT NULL,
  latency_ms   INT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_hcr_check_id ON healthcheck_results(check_id, checked_at DESC);

-- Notifikační kanály
CREATE TABLE IF NOT EXISTS notification_channels (
  id          SERIAL PRIMARY KEY,
  type        TEXT        NOT NULL, -- 'discord' | 'email'
  name        TEXT        NOT NULL,
  target      TEXT        NOT NULL, -- webhook URL nebo email adresa
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notifikační pravidla (co → kam posílat)
CREATE TABLE IF NOT EXISTS notification_rules (
  id          SERIAL PRIMARY KEY,
  event_type  TEXT        NOT NULL, -- 'app_down' | 'disk_high' | 'ram_high' | 'invoice_overdue'
  threshold   NUMERIC,               -- pro číselné prahy (85 = 85 %)
  channel_id  INT         NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Log odeslaných notifikací (deduplikace)
CREATE TABLE IF NOT EXISTS notification_log (
  id          SERIAL PRIMARY KEY,
  event_type  TEXT        NOT NULL,
  event_key   TEXT,                  -- unikátní klíč události (např. check_id nebo invoice_id)
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel_id  INT,
  message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_nlog_event ON notification_log(event_type, event_key, sent_at DESC);
