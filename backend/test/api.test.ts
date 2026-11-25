import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const jsonHeaders = { "content-type": "application/json" };
const request = (path: string, init: RequestInit = {}) => SELF.fetch(`https://api.test${path}`, { ...init, headers: { ...jsonHeaders, ...(init.headers ?? {}) } });
const post = (path: string, body: unknown, token?: string) => request(path, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });

beforeAll(async () => {
  await env.DB.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT, password_salt TEXT, password_hash TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT, last_seen_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE device_pairing_codes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE device_tokens (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE policies (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_id TEXT REFERENCES devices(id) ON DELETE CASCADE, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, rules_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE commands (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','executed','failed','expired')), expires_at TEXT, idempotency_key TEXT, error_message TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE usage (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, app_id TEXT NOT NULL, usage_date TEXT NOT NULL, duration_seconds INTEGER NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(device_id, app_id, usage_date));
  `);
});
afterAll(async () => { await env.DB.exec("DROP TABLE IF EXISTS usage; DROP TABLE IF EXISTS commands; DROP TABLE IF EXISTS policies; DROP TABLE IF EXISTS device_tokens; DROP TABLE IF EXISTS device_pairing_codes; DROP TABLE IF EXISTS devices; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users;"); });

describe("FocusGuard API", () => {
  it("registers and logs in without exposing password material", async () => {
    const registered = await post("/api/auth/register", { email: "a@example.test", password: "correct horse battery", display_name: "A" });
    expect(registered.status).toBe(201); const data = await registered.json() as { token: string; user: { id: string } }; expect(data.token).toEqual(expect.any(String)); expect(data.user.id).toEqual(expect.any(String));
    const stored = await env.DB.prepare("SELECT password_hash,password_salt FROM users WHERE id=?").bind(data.user.id).first<Record<string, unknown>>(); expect(stored?.password_hash).toEqual(expect.any(String)); expect(stored?.password_salt).toEqual(expect.any(String));
    const login = await post("/api/auth/login", { email: "a@example.test", password: "correct horse battery" }); expect(login.status).toBe(200);
    const logged = await login.clone().json() as { token: string };
    const session = await request("/api/v1/auth/session", { headers: { authorization: `Bearer ${logged.token}` } }); expect(session.status).toBe(200);
    const bad = await post("/api/auth/login", { email: "a@example.test", password: "wrong password" }); expect(bad.status).toBe(401);
  });

  it("isolates users and supports one-time device pairing and heartbeat", async () => {
    const a = await (await post("/api/auth/register", { email: "owner@example.test", password: "password one" })).json() as { token: string };
    const b = await (await post("/api/auth/register", { email: "other@example.test", password: "password two" })).json() as { token: string };
    const code = await (await post("/api/devices/pairing-codes", {}, a.token)).json() as { code: string };
    const paired = await (await post("/api/devices/pair", { code: code.code, name: "Phone", platform: "android" })).json() as { device: { id: string }; device_token: string };
    expect(paired.device_token).toEqual(expect.any(String)); expect((await post("/api/devices/pair", { code: code.code, name: "Again", platform: "android" })).status).toBe(400);
    expect((await request(`/api/devices/${paired.device.id}/heartbeat`, { method: "POST", headers: { "x-device-token": paired.device_token } })).status).toBe(200);
    expect(await (await request("/api/devices", { headers: { authorization: `Bearer ${b.token}` } })).json()).toEqual([]);
  });

  it("creates idempotent commands, enforces ownership, and handles device ack", async () => {
    const auth = await (await post("/api/auth/register", { email: "cmd@example.test", password: "password three" })).json() as { token: string };
    const device = await (await post("/api/devices", { name: "Laptop", platform: "linux" }, auth.token)).json() as { device: { id: string }; device_token: string };
    const headers = { authorization: `Bearer ${auth.token}`, "idempotency-key": "same-command" };
    const first = await request("/api/commands", { method: "POST", headers, body: JSON.stringify({ device_id: device.device.id, kind: "sync", expires_in: 60 }) }); const command = await first.json() as { id: string; status: string }; expect(first.status).toBe(201); expect(command.status).toBe("pending");
    const second = await request("/api/commands", { method: "POST", headers, body: JSON.stringify({ device_id: device.device.id, kind: "sync", expires_in: 60 }) }); expect((await second.json() as { id: string }).id).toBe(command.id);
    const pulled = await request(`/api/devices/${device.device.id}/commands`, { headers: { "x-device-token": device.device_token } }); expect(pulled.status).toBe(200); expect((await pulled.json() as { commands: Array<{ status: string }> }).commands[0].status).toBe("delivered");
    const ack = await post(`/api/devices/${device.device.id}/commands/${command.id}/ack`, { status: "executed" }); expect(ack.status).toBe(401);
    const deviceAck = await request(`/api/devices/${device.device.id}/commands/${command.id}/ack`, { method: "POST", headers: { "x-device-token": device.device_token }, body: JSON.stringify({ status: "executed" }) }); expect(deviceAck.status).toBe(200);
  });
});
