import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const auth = { authorization: "Bearer test-token", "content-type": "application/json" };

beforeAll(async () => {
  await env.DB.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT, last_seen_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE policies (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), rules_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE commands (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','completed','failed')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE usage (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, app_id TEXT NOT NULL, usage_date TEXT NOT NULL, duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0), recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(device_id, app_id, usage_date));
  `);
});

afterAll(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS usage; DROP TABLE IF EXISTS commands; DROP TABLE IF EXISTS policies; DROP TABLE IF EXISTS devices; DROP TABLE IF EXISTS users;");
});

describe("FocusGuard API", () => {
  it("rejects missing bearer token instead of returning success", async () => {
    const response = await SELF.fetch("https://api.test/v1/users");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("creates a user and device, then records device heartbeat", async () => {
    const userResponse = await SELF.fetch("https://api.test/v1/users", {
      method: "POST", headers: auth, body: JSON.stringify({ email: "dev@example.test", display_name: "Dev" }),
    });
    expect(userResponse.status).toBe(201);
    const user = await userResponse.json() as { id: string };
    const deviceResponse = await SELF.fetch("https://api.test/v1/devices", {
      method: "POST", headers: auth, body: JSON.stringify({ user_id: user.id, name: "Phone", platform: "android" }),
    });
    expect(deviceResponse.status).toBe(201);
    const device = await deviceResponse.json() as { id: string };
    const heartbeat = await SELF.fetch(`https://api.test/v1/devices/${device.id}/heartbeat`, { method: "POST", headers: auth });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toMatchObject({ id: device.id, last_seen_at: expect.any(String) });
  });

  it("validates required fields and persists policies, commands, and usage", async () => {
    const invalid = await SELF.fetch("https://api.test/v1/users", { method: "POST", headers: auth, body: "{}" });
    expect(invalid.status).toBe(400);
    const user = await env.DB.prepare("INSERT INTO users (id,email) VALUES ('u2','u2@example.test') RETURNING id").first() as { id: string };
    const device = await env.DB.prepare("INSERT INTO devices (id,user_id,name,platform) VALUES ('d2',?,'Tablet','android') RETURNING id").bind(user.id).first() as { id: string };
    const policy = await SELF.fetch("https://api.test/v1/policies", { method: "POST", headers: auth, body: JSON.stringify({ user_id: user.id, name: "Quiet", enabled: true, rules_json: "{}" }) });
    expect(policy.status).toBe(201);
    const command = await SELF.fetch("https://api.test/v1/commands", { method: "POST", headers: auth, body: JSON.stringify({ device_id: device.id, kind: "sync", payload_json: "{}" }) });
    expect(command.status).toBe(201);
    const usage = await SELF.fetch("https://api.test/v1/usage", { method: "POST", headers: auth, body: JSON.stringify({ device_id: device.id, app_id: "com.example", usage_date: "2026-05-25", duration_seconds: 120 }) });
    expect(usage.status).toBe(201);
    expect((await SELF.fetch("https://api.test/v1/usage?device_id=d2", { headers: auth })).status).toBe(200);
  });
});
