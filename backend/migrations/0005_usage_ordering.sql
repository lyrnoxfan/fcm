ALTER TABLE usage ADD COLUMN updated_at_millis INTEGER NOT NULL DEFAULT 0;
CREATE INDEX usage_device_updated_idx ON usage(device_id, updated_at_millis);
