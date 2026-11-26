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
    CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT, unbound_at TEXT, last_seen_at TEXT, last_sync_at TEXT, usage_access_granted INTEGER, accessibility_enabled INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE device_pairing_codes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, device_id TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE device_tokens (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE policies (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_id TEXT REFERENCES devices(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT, enabled INTEGER NOT NULL DEFAULT 1, rules_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE commands (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','executed','failed','expired')), expires_at TEXT, idempotency_key TEXT, request_fingerprint TEXT, error_message TEXT, delivery_lease_until TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE usage (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, app_id TEXT NOT NULL, usage_date TEXT NOT NULL, duration_seconds INTEGER NOT NULL, updated_at_millis INTEGER NOT NULL DEFAULT 0, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(device_id, app_id, usage_date));
    CREATE UNIQUE INDEX commands_user_idempotency_idx ON commands(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
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
    const heartbeat = await request(`/api/devices/${paired.device.id}/heartbeat`, { method: "POST", headers: { "x-device-token": paired.device_token }, body: JSON.stringify({ usageAccessGranted: true, accessibilityEnabled: false }) });
    expect(heartbeat.status).toBe(200);
    const ownerDevices = await (await request("/api/devices", { headers: { authorization: `Bearer ${a.token}` } })).json() as Array<{ id: string; usage_access_granted: number; accessibility_enabled: number; last_sync_at: string }>;
    expect(ownerDevices[0]).toMatchObject({ id: paired.device.id, usage_access_granted: 1, accessibility_enabled: 0 }); expect(ownerDevices[0].last_sync_at).toEqual(expect.any(String));
    expect(await (await request("/api/devices", { headers: { authorization: `Bearer ${b.token}` } })).json()).toEqual([]);
  });

  it("unbinds only an owned device, revokes credentials and preserves other devices", async () => {
    const owner = await (await post("/api/auth/register", { email: "unbind@example.test", password: "password one" })).json() as { token: string };
    const other = await (await post("/api/auth/register", { email: "outside@example.test", password: "password two" })).json() as { token: string };
    const makeCode = async () => (await (await post("/api/devices/pairing-codes", {}, owner.token)).json() as { code: string }).code;
    const pair = async (code: string) => await (await post("/api/devices/pair", { code, name: "Test phone", platform: "android" })).json() as { device: { id: string }; device_token: string };
    const code = await makeCode();
    const old = await pair(code);
    const sibling = await pair(await makeCode());
    const id = old.device.id;
    const path = `/api/v1/devices/${id}`;
    const token = { "x-device-token": old.device_token };
    const bearer = { authorization: `Bearer ${owner.token}` };
    const policy = await (await post("/api/policies", { name: "Test policy", device_id: id }, owner.token)).json() as { id: string };
    const command = await (await post("/api/commands", { device_id: id, command: "lock", expires_in: 60 }, owner.token)).json() as { id: string };
    expect((await request(path, { method: "DELETE", headers: token })).status).toBe(401);
    expect((await request(path, { method: "DELETE", headers: { authorization: `Bearer ${other.token}` } })).status).toBe(404);
    expect((await request(`${path}/policy`, { headers: token })).status).toBe(200);
    expect((await post("/api/usage", { device_id: id, app_id: "isolated.fixture", usage_date: "2026-11-25", duration_seconds: 60 }, owner.token)).status).toBe(200);
    expect((await request(path, { method: "DELETE", headers: bearer })).status).toBe(200);
    expect((await request(path, { method: "DELETE", headers: bearer })).status).toBe(404);
    expect((await request(`${path}/policy`, { headers: token })).status).toBe(401);
    expect((await request(`${path}/commands`, { headers: token })).status).toBe(401);
    expect((await request(`${path}/usage`, { method: "POST", headers: token, body: "{}" })).status).toBe(401);
    expect((await request(`/api/usage?device_id=${id}`, { headers: bearer })).status).toBe(404);
    expect((await request(`${path}/heartbeat`, { method: "POST", headers: token })).status).toBe(401);
    expect((await post("/api/commands", { device_id: id, command: "lock" }, owner.token)).status).toBe(404);
    expect((await post(`/api/policies/${policy.id}/assign`, { device_id: id }, owner.token)).status).toBe(404);
    expect(await (await request("/api/devices", { headers: bearer })).json()).toEqual([expect.objectContaining({ id: sibling.device.id })]);
    expect(await (await request(`/api/policies/${policy.id}`, { headers: bearer })).json()).toMatchObject({ id: policy.id, device_id: null });
    expect(await env.DB.prepare("SELECT status FROM commands WHERE id=?").bind(command.id).first()).toMatchObject({ status: "expired" });
    expect(await env.DB.prepare("SELECT duration_seconds FROM usage WHERE device_id=?").bind(id).first()).toMatchObject({ duration_seconds: 60 });
    expect(await env.DB.prepare("SELECT revoked_at FROM device_tokens WHERE device_id=?").bind(id).first()).toMatchObject({ revoked_at: expect.any(String) });
    expect((await post("/api/devices/pair", { code, name: "Retry", platform: "android" })).status).toBe(400);
    const fresh = await pair(await makeCode());
    expect(fresh.device.id).not.toBe(id);
    expect(fresh.device_token).not.toBe(old.device_token);
    expect((await request(`/api/devices/${fresh.device.id}/policy`, { headers: { "x-device-token": fresh.device_token } })).status).toBe(200);
  });

  it("creates idempotent commands, enforces ownership, and handles device ack", async () => {
    const auth = await (await post("/api/auth/register", { email: "cmd@example.test", password: "password three" })).json() as { token: string };
    const device = await (await post("/api/devices", { name: "Laptop", platform: "linux" }, auth.token)).json() as { device: { id: string }; device_token: string };
    const emptyQueue = await request(`/api/devices/${device.device.id}/commands`, { headers: { "x-device-token": device.device_token } });
    expect(emptyQueue.status).toBe(200);
    expect(await emptyQueue.json()).toEqual({ commands: [] });
    const headers = { authorization: `Bearer ${auth.token}`, "idempotency-key": "same-command" };
    const first = await request("/api/commands", { method: "POST", headers, body: JSON.stringify({ device_id: device.device.id, command: "sync", expires_in: 60 }) }); const command = await first.json() as { id: string; status: string; kind: string }; expect(first.status).toBe(201); expect(command.status).toBe("pending"); expect(command.kind).toBe("sync");
    const second = await request("/api/commands", { method: "POST", headers, body: JSON.stringify({ device_id: device.device.id, command: "sync", expires_in: 60 }) }); expect((await second.json() as { id: string }).id).toBe(command.id);
    const pulled = await request(`/api/devices/${device.device.id}/commands`, { headers: { "x-device-token": device.device_token } }); expect(pulled.status).toBe(200); expect((await pulled.json() as { commands: Array<{ status: string }> }).commands[0].status).toBe("delivered");
    const deliveryAck = await request(`/api/devices/${device.device.id}/commands/${command.id}/ack`, { method: "POST", headers: { "x-device-token": device.device_token }, body: JSON.stringify({ status: "delivered" }) }); expect(deliveryAck.status).toBe(200);
    const ownerCommand = await request(`/api/devices/${device.device.id}/commands/${command.id}`, { headers: { authorization: `Bearer ${auth.token}` } }); expect((await ownerCommand.json() as { status: string }).status).toBe("delivered");
    const ack = await post(`/api/devices/${device.device.id}/commands/${command.id}/ack`, { status: "executed" }); expect(ack.status).toBe(401);
    const deviceAck = await request(`/api/devices/${device.device.id}/commands/${command.id}/ack`, { method: "POST", headers: { "x-device-token": device.device_token }, body: JSON.stringify({ status: "executed" }) }); expect(deviceAck.status).toBe(200);
  });
});
