CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify_new_order BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
