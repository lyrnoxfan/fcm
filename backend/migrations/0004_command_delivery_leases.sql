ALTER TABLE commands ADD COLUMN delivery_lease_until TEXT;
ALTER TABLE commands ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commands ADD COLUMN request_fingerprint TEXT;
CREATE INDEX commands_delivery_lease_idx ON commands(device_id, status, delivery_lease_until);
