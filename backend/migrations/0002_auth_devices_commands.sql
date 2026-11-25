ALTER TABLE users ADD COLUMN password_salt TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE device_pairing_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX pairing_user_idx ON device_pairing_codes(user_id);

CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX device_tokens_device_idx ON device_tokens(device_id);

ALTER TABLE policies ADD COLUMN device_id TEXT REFERENCES devices(id) ON DELETE CASCADE;
ALTER TABLE policies ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX policies_device_version_idx ON policies(device_id, version);

CREATE TABLE commands_new (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','executed','failed','expired')),
  expires_at TEXT,
  idempotency_key TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO commands_new (id,device_id,user_id,kind,payload_json,status,created_at,updated_at)
  SELECT c.id,c.device_id,d.user_id,c.kind,c.payload_json,
    CASE WHEN c.status='completed' THEN 'executed' ELSE c.status END,
    c.created_at,c.updated_at FROM commands c JOIN devices d ON d.id=c.device_id;
DROP TABLE commands;
ALTER TABLE commands_new RENAME TO commands;
CREATE INDEX commands_device_status_idx ON commands(device_id, status);
CREATE INDEX commands_expiry_idx ON commands(expires_at);
CREATE UNIQUE INDEX commands_user_idempotency_idx ON commands(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
