export interface Env { DB: D1Database }

type User = { id: string; email: string; display_name: string | null };
type Auth = { user: User; sessionId: string };
type DeviceAuth = { deviceId: string; userId: string; tokenId: string };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Device-Token, Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};
const json = (data: unknown, status = 200, headers?: HeadersInit) => Response.json(data, {
  status,
  headers: { ...corsHeaders, ...(headers ?? {}) },
});
const error = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
const id = () => crypto.randomUUID();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToB64(bytes: Uint8Array): string { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function b64ToBytes(value: string): Uint8Array { const s = atob(value); return Uint8Array.from(s, c => c.charCodeAt(0)); }
async function randomToken(): Promise<string> { const b = new Uint8Array(32); crypto.getRandomValues(b); return bytesToB64(b).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function digest(value: string): Promise<string> { const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value)); return bytesToB64(new Uint8Array(hash)); }
async function hashPassword(password: string, salt?: Uint8Array): Promise<{ salt: string; hash: string }> {
  const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: actualSalt as unknown as BufferSource, iterations: 120000, hash: "SHA-256" }, key, 256);
  return { salt: bytesToB64(actualSalt), hash: bytesToB64(new Uint8Array(bits)) };
}
async function verifyPassword(password: string, salt: string, expected: string): Promise<boolean> {
  const result = await hashPassword(password, b64ToBytes(salt));
  return constantTimeEqual(result.hash, expected);
}
function constantTimeEqual(a: string, b: string): boolean { const x = encoder.encode(a), y = encoder.encode(b); let d = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0); return d === 0; }
async function body(request: Request): Promise<Record<string, unknown> | null> { try { const x: unknown = await request.json(); return x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : null; } catch { return null; } }
function str(value: unknown, min = 1, max = 10000): value is string { return typeof value === "string" && value.length >= min && value.length <= max; }
function userView(row: Record<string, unknown>): User { return { id: String(row.id), email: String(row.email), display_name: row.display_name == null ? null : String(row.display_name) }; }
function clean(row: Record<string, unknown> | null): Record<string, unknown> | null { if (!row) return null; const copy = { ...row }; delete copy.password_hash; delete copy.password_salt; delete copy.token_hash; return copy; }

async function sessionAuth(request: Request, env: Env): Promise<Auth | Response> {
  const value = request.headers.get("authorization") ?? "";
  if (!value.startsWith("Bearer ")) return error(401, "unauthorized", "A bearer session is required");
  const tokenHash = await digest(value.slice(7));
  const row = await env.DB.prepare("SELECT s.id AS session_id, s.user_id, s.expires_at, u.id, u.email, u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(tokenHash).first<Record<string, unknown>>();
  if (!row) return error(401, "unauthorized", "Invalid or expired session");
  return { user: userView(row), sessionId: String(row.session_id) };
}
async function deviceAuth(request: Request, env: Env): Promise<DeviceAuth | Response> {
  const raw = request.headers.get("x-device-token") ?? (request.headers.get("authorization")?.startsWith("Device ") ? request.headers.get("authorization")!.slice(7) : "");
  if (!raw) return error(401, "unauthorized", "A device token is required");
  const hash = await digest(raw);
  const row = await env.DB.prepare("SELECT t.id AS token_id, t.device_id, d.user_id FROM device_tokens t JOIN devices d ON d.id=t.device_id WHERE t.token_hash=? AND t.revoked_at IS NULL").bind(hash).first<Record<string, unknown>>();
  return row ? { deviceId: String(row.device_id), userId: String(row.user_id), tokenId: String(row.token_id) } : error(401, "unauthorized", "Invalid device token");
}
async function ownsDevice(env: Env, userId: string, deviceId: string): Promise<boolean> { return !!await env.DB.prepare("SELECT id FROM devices WHERE id=? AND user_id=?").bind(deviceId, userId).first(); }
function routeParts(url: URL): string[] {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "v1") return parts.slice(2);
  if (parts[0] === "api" || parts[0] === "v1") return parts.slice(1);
  return [];
}
function expiresAt(input: unknown): string { const n = typeof input === "number" ? input : 86400; return new Date(Date.now() + Math.max(60, Math.min(n, 2_592_000)) * 1000).toISOString(); }

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const parts = routeParts(url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (url.pathname === "/health" && request.method === "GET") return json({ status: "ok" });
  if (!parts.length) return error(404, "not_found", "Route not found");
  const method = request.method;

  if (parts[0] === "auth" && method === "POST" && (parts[1] === "register" || parts[1] === "login")) {
    const input = await body(request); if (!input || !str(input.email, 3, 320) || !str(input.password, 8, 200)) return error(400, "validation_error", "email and password (8+ characters) are required");
    const email = input.email.trim().toLowerCase();
    if (parts[1] === "register") {
      const existing = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first(); if (existing) return error(409, "email_taken", "Email is already registered");
      const pass = await hashPassword(input.password); const userId = id();
      await env.DB.prepare("INSERT INTO users (id,email,display_name,password_salt,password_hash) VALUES (?,?,?,?,?)").bind(userId, email, str(input.display_name) ? input.display_name : null, pass.salt, pass.hash).run();
      const token = await randomToken(); const sessionId = id(); await env.DB.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)").bind(sessionId, userId, await digest(token), new Date(Date.now() + 30 * 86400000).toISOString()).run();
      return json({ user: { id: userId, email, display_name: str(input.display_name) ? input.display_name : null }, token, expires_in: 2592000 }, 201);
    }
    const row = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first<Record<string, unknown>>();
    if (!row || !str(row.password_salt) || !str(row.password_hash) || !(await verifyPassword(input.password, row.password_salt, row.password_hash))) return error(401, "invalid_credentials", "Email or password is incorrect");
    const token = await randomToken(); await env.DB.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)").bind(id(), row.id, await digest(token), new Date(Date.now() + 30 * 86400000).toISOString()).run();
    return json({ user: userView(row), token, expires_in: 2592000 });
  }

  // Device pairing and device-token operations do not use a user session.
  if (parts[0] === "devices" && parts[1] === "pair" && method === "POST") {
    const input = await body(request); const pairingCode = input?.code ?? input?.pairing_code; if (!input || !str(pairingCode) || !str(input.name) || !str(input.platform)) return error(400, "validation_error", "code, name and platform are required");
    const pair = await env.DB.prepare("SELECT * FROM device_pairing_codes WHERE code_hash=? AND used_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(await digest(pairingCode)).first<Record<string, unknown>>();
    if (!pair) return error(400, "invalid_pairing_code", "Pairing code is invalid or expired");
    const deviceId = id(); const token = await randomToken();
    await env.DB.batch([env.DB.prepare("INSERT INTO devices (id,user_id,name,platform,app_version) VALUES (?,?,?,?,?)").bind(deviceId, pair.user_id, input.name, input.platform, str(input.app_version) ? input.app_version : null), env.DB.prepare("INSERT INTO device_tokens (id,device_id,token_hash) VALUES (?,?,?)").bind(id(), deviceId, await digest(token)), env.DB.prepare("UPDATE device_pairing_codes SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND used_at IS NULL").bind(pair.id)]);
    return json({ device: { id: deviceId, user_id: pair.user_id, name: input.name, platform: input.platform, app_version: input.app_version ?? null }, device_token: token }, 201);
  }
  if (parts[0] === "devices" && parts[1] && parts[2] === "heartbeat" && method === "POST" && (request.headers.get("x-device-token") || request.headers.get("authorization")?.startsWith("Device "))) {
    const da = await deviceAuth(request, env); if (da instanceof Response) return da; if (parts[1] !== da.deviceId) return error(403, "forbidden", "Device token does not match device"); const input = await body(request) ?? {};
    await env.DB.prepare("UPDATE devices SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), app_version=COALESCE(?,app_version), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND user_id=?").bind(str(input.app_version) ? input.app_version : null, parts[1], da.userId).run(); return json({ ok: true, device_id: parts[1] });
  }
  if (parts[0] === "devices" && parts[1] && parts[2] === "commands" && method === "GET" && (request.headers.get("x-device-token") || request.headers.get("authorization")?.startsWith("Device "))) {
    const da = await deviceAuth(request, env); if (da instanceof Response) return da; if (parts[1] !== da.deviceId) return error(403, "forbidden", "Device token does not match device");
    await env.DB.prepare("UPDATE commands SET status='expired',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE device_id=? AND status IN ('pending','delivered') AND expires_at IS NOT NULL AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(da.deviceId).run();
    const rows = await env.DB.prepare("SELECT * FROM commands WHERE device_id=? AND status='pending' ORDER BY created_at ASC LIMIT 100").bind(da.deviceId).all();
    if (rows.results.length) await env.DB.prepare("UPDATE commands SET status='delivered',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE device_id=? AND status='pending'").bind(da.deviceId).run();
    return json({ commands: rows.results.map(r => ({ ...clean(r), status: "delivered" })) });
  }
  if (parts[0] === "devices" && parts[1] && parts[2] === "usage" && method === "POST" && (request.headers.get("x-device-token") || request.headers.get("authorization")?.startsWith("Device "))) {
    const da = await deviceAuth(request, env); if (da instanceof Response) return da; if (parts[1] !== da.deviceId) return error(403, "forbidden", "Device token does not match device"); const input = await body(request); const rows = Array.isArray(input?.rows) ? input.rows : [input];
    for (const row of rows) { if (!row || typeof row !== "object") return error(400, "validation_error", "usage row is required"); const value = row as Record<string, unknown>; const appId = String(value.appId ?? value.app_id ?? "__device__"); const date = String(value.localDate ?? value.usage_date ?? ""); const duration = Math.max(0, Math.floor(Number(value.deviceForegroundMillis ?? value.duration_seconds ?? 0) / (value.deviceForegroundMillis === undefined ? 1 : 1000))); if (!date) return error(400, "validation_error", "usage date is required"); await env.DB.prepare("INSERT INTO usage (id,device_id,app_id,usage_date,duration_seconds) VALUES (?,?,?,?,?) ON CONFLICT(device_id,app_id,usage_date) DO UPDATE SET duration_seconds=excluded.duration_seconds").bind(id(), da.deviceId, appId, date, duration).run(); }
    return json({ ok: true, accepted: rows.length });
  }
  if (parts[0] === "usage" && method === "POST" && (request.headers.get("x-device-token") || request.headers.get("authorization")?.startsWith("Device "))) {
    const da = await deviceAuth(request, env); if (da instanceof Response) return da; const input = await body(request); if (!input || input.device_id !== da.deviceId || !str(input.app_id) || !str(input.usage_date) || !Number.isInteger(input.duration_seconds) || Number(input.duration_seconds) < 0) return error(400, "validation_error", "device_id, app_id, usage_date and duration_seconds are required"); const result = await env.DB.prepare("INSERT INTO usage (id,device_id,app_id,usage_date,duration_seconds) VALUES (?,?,?,?,?) ON CONFLICT(device_id,app_id,usage_date) DO UPDATE SET duration_seconds=excluded.duration_seconds RETURNING *").bind(id(), da.deviceId, input.app_id, input.usage_date, input.duration_seconds).first(); return json(result, 201);
  }
  if (parts[0] === "commands" && parts[1] && parts[2] === "ack" && method === "POST" && (request.headers.get("x-device-token") || request.headers.get("authorization")?.startsWith("Device "))) {
    const da = await deviceAuth(request, env); if (da instanceof Response) return da; const input = await body(request); const status = input?.status; if (!['executed','failed','delivered'].includes(String(status))) return error(400, "validation_error", "status must be delivered, executed or failed"); const result = await env.DB.prepare("UPDATE commands SET status=?,error_message=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND device_id=? AND status NOT IN ('executed','failed','expired') RETURNING *").bind(status, str(input?.error_message) ? input!.error_message : null, parts[1], da.deviceId).first(); return result ? json(clean(result as Record<string, unknown>)) : error(404, "not_found", "Command not found");
  }
  if (parts[0] === "devices" && parts[1] && parts[2] === "commands" && parts[3] && parts[4] === "ack" && method === "POST" && (request.headers.get("x-device-token") || request.headers.get("authorization")?.startsWith("Device "))) {
    const da = await deviceAuth(request, env); if (da instanceof Response) return da; if (parts[1] !== da.deviceId) return error(403, "forbidden", "Device token does not match device"); const input = await body(request); const status = input?.status; if (!['executed','failed','delivered'].includes(String(status))) return error(400, "validation_error", "status must be delivered, executed or failed"); const result = await env.DB.prepare("UPDATE commands SET status=?,error_message=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND device_id=? AND status NOT IN ('executed','failed','expired') RETURNING *").bind(status, str(input?.error_message) ? input!.error_message : null, parts[3], da.deviceId).first(); return result ? json(clean(result as Record<string, unknown>)) : error(404, "not_found", "Command not found");
  }

  if (parts[0] === "devices" && parts[1] && parts[2] === "policy" && method === "GET" && (request.headers.get("x-device-token") || request.headers.get("authorization")?.startsWith("Device "))) {
    const da = await deviceAuth(request, env); if (da instanceof Response) return da;
    if (parts[1] !== da.deviceId) return error(403, "forbidden", "Device token does not match device");
    const row = await env.DB.prepare("SELECT * FROM policies WHERE device_id=? AND enabled=1 ORDER BY version DESC LIMIT 1").bind(da.deviceId).first<Record<string, unknown>>();
    if (!row) return json({ version: 0, config: {} });
    const version = Number(row.version ?? 0); const known = Number(url.searchParams.get("version") ?? -1);
    if (known >= version) return json({ notModified: true, version });
    let config: unknown = {}; try { config = JSON.parse(String(row.rules_json ?? "{}")); } catch { config = {}; }
    return json({ version, config });
  }
  if (parts[0] === "devices" && parts[1] && parts[2] === "usage" && method === "POST" && (request.headers.get("x-device-token") || request.headers.get("authorization")?.startsWith("Device "))) {
    const da = await deviceAuth(request, env); if (da instanceof Response) return da;
    if (parts[1] !== da.deviceId) return error(403, "forbidden", "Device token does not match device");
    const input = await body(request); const rows = Array.isArray(input?.rows) ? input?.rows : [input];
    if (!rows.length || rows.some((row) => !row || typeof row !== "object")) return error(400, "validation_error", "usage rows are required");
    const statements = rows.map((row) => { const value = row as Record<string, unknown>; const date = String(value.localDate ?? value.usage_date ?? ""); const duration = Number(value.deviceForegroundMillis ?? Number(value.duration_seconds ?? 0) * 1000); return env.DB.prepare("INSERT INTO usage (id,device_id,app_id,usage_date,duration_seconds) VALUES (?,?,?,?,?) ON CONFLICT(device_id,app_id,usage_date) DO UPDATE SET duration_seconds=excluded.duration_seconds").bind(id(), da.deviceId, "__device__", date, Math.max(0, Math.floor(duration / 1000))); });
    await env.DB.batch(statements); return json({ ok: true, accepted: statements.length });
  }

  const authResult = await sessionAuth(request, env); if (authResult instanceof Response) return authResult; const auth = authResult;
  if (parts[0] === "auth" && parts[1] === "logout" && method === "POST") { await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(auth.sessionId).run(); return json({ ok: true }); }
  if ((parts[0] === "me" || (parts[0] === "auth" && parts[1] === "session")) && method === "GET") return json({ user: auth.user });

  if (parts[0] === "devices" && parts[1] === "pairing-codes" && method === "POST") {
    const random = new Uint32Array(1); crypto.getRandomValues(random); const code = String(100000 + (random[0] % 900000)); const codeHash = await digest(code); await env.DB.prepare("INSERT INTO device_pairing_codes (id,user_id,code_hash,expires_at) VALUES (?,?,?,?)").bind(id(), auth.user.id, codeHash, new Date(Date.now() + 10 * 60 * 1000).toISOString()).run(); return json({ code, expires_in: 600 }, 201);
  }

  if (parts[0] === "devices" && parts.length === 1 && method === "GET") { const rows = await env.DB.prepare("SELECT * FROM devices WHERE user_id=? ORDER BY created_at DESC").bind(auth.user.id).all(); return json(rows.results.map(r => clean(r))); }
  if (parts[0] === "devices" && parts.length === 1 && method === "POST") {
    const input = await body(request); if (!input || !str(input.name) || !str(input.platform)) return error(400, "validation_error", "name and platform are required"); const deviceId = id(); const token = await randomToken(); await env.DB.batch([env.DB.prepare("INSERT INTO devices (id,user_id,name,platform,app_version) VALUES (?,?,?,?,?)").bind(deviceId, auth.user.id, input.name, input.platform, str(input.app_version) ? input.app_version : null), env.DB.prepare("INSERT INTO device_tokens (id,device_id,token_hash) VALUES (?,?,?)").bind(id(), deviceId, await digest(token))]); return json({ device: { id: deviceId, user_id: auth.user.id, name: input.name, platform: input.platform }, device_token: token }, 201);
  }
  if (parts[0] === "devices" && parts[1] && parts[2] === "heartbeat" && method === "POST") {
    const owner = await ownsDevice(env, auth.user.id, parts[1]); if (!owner) return error(404, "not_found", "Device not found"); const input = await body(request) ?? {}; await env.DB.prepare("UPDATE devices SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), app_version=COALESCE(?,app_version), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(str(input.app_version) ? input.app_version : null, parts[1]).run(); return json({ ok: true, device_id: parts[1] });
  }

  if (parts[0] === "policies" && parts[1] && parts[2] === "assign" && method === "POST") {
    const input = await body(request); if (!input || !str(input.device_id ?? input.deviceId)) return error(400, "validation_error", "device_id is required");
    const deviceId = String(input.device_id ?? input.deviceId); if (!await ownsDevice(env, auth.user.id, deviceId)) return error(404, "not_found", "Device not found");
    const current = await env.DB.prepare("SELECT id FROM policies WHERE id=? AND user_id=?").bind(parts[1], auth.user.id).first(); if (!current) return error(404, "not_found", "Policy not found");
    const result = await env.DB.prepare("UPDATE policies SET device_id=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND user_id=? RETURNING *").bind(deviceId, parts[1], auth.user.id).first<Record<string, unknown>>(); return json(clean(result));
  }
  if (parts[0] === "policies") {
    if (method === "GET") { const deviceId = url.searchParams.get("device_id"); if (parts[1]) { const row = await env.DB.prepare("SELECT * FROM policies WHERE id=? AND user_id=?").bind(parts[1], auth.user.id).first<Record<string, unknown>>(); return row ? json(clean(row)) : error(404, "not_found", "Policy not found"); } if (deviceId && !await ownsDevice(env, auth.user.id, deviceId)) return error(404, "not_found", "Device not found"); const rows = await env.DB.prepare(deviceId ? "SELECT * FROM policies WHERE user_id=? AND device_id=? ORDER BY version DESC" : "SELECT * FROM policies WHERE user_id=? ORDER BY updated_at DESC").bind(...(deviceId ? [auth.user.id, deviceId] : [auth.user.id])).all(); return json(rows.results.map(r => clean(r))); }
    if (parts[1] && method === "PATCH") { const input = await body(request); if (!input || Object.keys(input).length === 0) return error(400, "validation_error", "A non-empty JSON object is required"); const current = await env.DB.prepare("SELECT * FROM policies WHERE id=? AND user_id=?").bind(parts[1], auth.user.id).first<Record<string, unknown>>(); if (!current) return error(404, "not_found", "Policy not found"); const version = input.version === undefined ? Number(current.version) + 1 : Number(input.version); if (!Number.isInteger(version) || version < 1) return error(400, "validation_error", "version must be a positive integer"); const result = await env.DB.prepare("UPDATE policies SET name=COALESCE(?,name),enabled=COALESCE(?,enabled),rules_json=COALESCE(?,rules_json),version=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND user_id=? RETURNING *").bind(str(input.name) ? input.name : null, input.enabled === undefined ? null : (input.enabled === false || input.enabled === 0 ? 0 : 1), input.rules_json === undefined ? null : (typeof input.rules_json === "string" ? input.rules_json : JSON.stringify(input.rules_json)), version, parts[1], auth.user.id).first(); return json(clean(result as Record<string, unknown>)); }
    const input = await body(request); if (!input || !str(input.name)) return error(400, "validation_error", "name is required"); const deviceId = str(input.device_id ?? input.deviceId) ? String(input.device_id ?? input.deviceId) : null; if (deviceId && !await ownsDevice(env, auth.user.id, deviceId)) return error(404, "not_found", "Device not found"); const version = Number(input.version ?? 1); if (!Number.isInteger(version) || version < 1) return error(400, "validation_error", "version must be a positive integer"); const policyId = id(); const result = await env.DB.prepare("INSERT INTO policies (id,user_id,device_id,name,enabled,rules_json,version) VALUES (?,?,?,?,?,?,?) RETURNING *").bind(policyId, auth.user.id, deviceId, input.name, input.enabled === false || input.enabled === 0 ? 0 : 1, typeof (input.rules_json ?? input.rules ?? {}) === "string" ? (input.rules_json ?? input.rules ?? {}) : JSON.stringify(input.rules_json ?? input.rules ?? {}), version).first(); return json(clean(result as Record<string, unknown>), 201);
  }

  if (parts[0] === "devices" && parts[1] && parts[2] === "commands" && method === "POST") {
    const input = await body(request); if (!input || !str(input.kind ?? input.command)) return error(400, "validation_error", "command kind is required");
    if (!await ownsDevice(env, auth.user.id, parts[1])) return error(404, "not_found", "Device not found");
    const kind = String(input.kind ?? input.command); const idem = request.headers.get("idempotency-key");
    if (idem) { const old = await env.DB.prepare("SELECT * FROM commands WHERE user_id=? AND idempotency_key=?").bind(auth.user.id, idem).first<Record<string, unknown>>(); if (old) return json(clean(old)); }
    const result = await env.DB.prepare("INSERT INTO commands (id,user_id,device_id,kind,payload_json,status,expires_at,idempotency_key) VALUES (?,?,?,?,?,?,?,?) RETURNING *").bind(id(), auth.user.id, parts[1], kind, JSON.stringify(input.payload ?? input.payload_json ?? {}), "pending", expiresAt(input.expires_in), idem).first<Record<string, unknown>>(); return json(clean(result), 201);
  }
  if (parts[0] === "devices" && parts[1] && parts[2] === "commands" && parts[3] && method === "GET") {
    if (!await ownsDevice(env, auth.user.id, parts[1])) return error(404, "not_found", "Device not found");
    const result = await env.DB.prepare("SELECT * FROM commands WHERE id=? AND device_id=? AND user_id=?").bind(parts[3], parts[1], auth.user.id).first<Record<string, unknown>>(); return result ? json(clean(result)) : error(404, "not_found", "Command not found");
  }
  if (parts[0] === "commands") {
    if (method === "POST" && parts.length === 1) { const input = await body(request); if (!input || !str(input.device_id) || !str(input.kind)) return error(400, "validation_error", "device_id and kind are required"); if (!await ownsDevice(env, auth.user.id, input.device_id)) return error(404, "not_found", "Device not found"); const idem = request.headers.get("idempotency-key"); if (idem) { const old = await env.DB.prepare("SELECT * FROM commands WHERE user_id=? AND idempotency_key=?").bind(auth.user.id, idem).first(); if (old) return json(clean(old as Record<string, unknown>)); } const result = await env.DB.prepare("INSERT INTO commands (id,user_id,device_id,kind,payload_json,status,expires_at,idempotency_key) VALUES (?,?,?,?,?,?,?,?) RETURNING *").bind(id(), auth.user.id, input.device_id, input.kind, typeof input.payload_json === "string" ? input.payload_json : JSON.stringify(input.payload_json ?? {}), "pending", expiresAt(input.expires_in), idem).first(); return json(clean(result as Record<string, unknown>), 201); }
    if (method === "GET" && parts.length === 1) { const deviceId = url.searchParams.get("device_id"); if (!deviceId || !await ownsDevice(env, auth.user.id, deviceId)) return error(404, "not_found", "Device not found"); await env.DB.prepare("UPDATE commands SET status='expired',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE device_id=? AND status IN ('pending','delivered') AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(deviceId).run(); const rows = await env.DB.prepare("SELECT * FROM commands WHERE user_id=? AND device_id=? AND status IN ('pending','delivered') ORDER BY created_at ASC").bind(auth.user.id, deviceId).all(); return json(rows.results.map(r => clean(r))); }
    if (method === "POST" && parts[1] && parts[2] === "ack") { const input = await body(request); const status = input?.status; if (!['delivered','executed','failed'].includes(String(status))) return error(400, "validation_error", "status must be delivered, executed or failed"); const result = await env.DB.prepare("UPDATE commands SET status=?,error_message=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND user_id=? AND status NOT IN ('executed','failed','expired') RETURNING *").bind(status, str(input?.error_message) ? input!.error_message : null, parts[1], auth.user.id).first(); return result ? json(clean(result as Record<string, unknown>)) : error(404, "not_found", "Command not found"); }
  }

  if (parts[0] === "usage") {
    if (method === "GET") { const deviceId = url.searchParams.get("device_id"); if (!deviceId || !await ownsDevice(env, auth.user.id, deviceId)) return error(404, "not_found", "Device not found"); const rows = await env.DB.prepare("SELECT u.* FROM usage u JOIN devices d ON d.id=u.device_id WHERE u.device_id=? AND d.user_id=? ORDER BY usage_date DESC LIMIT 500").bind(deviceId, auth.user.id).all(); return json(rows.results); }
    if (method === "POST") { const input = await body(request); if (!input || !str(input.device_id) || !str(input.app_id) || !str(input.usage_date) || !Number.isInteger(input.duration_seconds) || Number(input.duration_seconds) < 0) return error(400, "validation_error", "device_id, app_id, usage_date and duration_seconds are required"); if (!await ownsDevice(env, auth.user.id, input.device_id)) return error(404, "not_found", "Device not found"); const result = await env.DB.prepare("INSERT INTO usage (id,device_id,app_id,usage_date,duration_seconds) VALUES (?,?,?,?,?) ON CONFLICT(device_id,app_id,usage_date) DO UPDATE SET duration_seconds=excluded.duration_seconds RETURNING *").bind(id(), input.device_id, input.app_id, input.usage_date, input.duration_seconds).first(); return json(result); }
  }
  return error(404, "not_found", "Route not found");
}

export default { async fetch(request: Request, env: Env): Promise<Response> { try { return await handle(request, env); } catch (cause) { console.error("API request failed", cause); return error(500, "internal_error", "Request could not be completed"); } } };
