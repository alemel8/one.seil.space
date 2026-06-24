-- Provázání healthchecků s konkrétním eshopem (pro detail stránku aplikace)
ALTER TABLE healthchecks ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_healthchecks_shop_id ON healthchecks(shop_id);

-- Výchozí systémový notifikační kanál (browser push všem přihlášeným uživatelům)
INSERT INTO notification_channels (type, name, target)
SELECT 'push', 'Systémové notifikace (push)', '*'
WHERE NOT EXISTS (SELECT 1 FROM notification_channels WHERE type = 'push');
