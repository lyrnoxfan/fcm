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
const json = (data: unknown, status = 200, headers?: HeadersInit) => Response.json(data, { status, headers: { ...corsHeaders, ...(headers ?? {}) } });
const error = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
const id = () => crypto.randomUUID();
const encoder = new TextEncoder();
const bytesToB64 = (bytes: Uint8Array): string => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const b64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const randomToken = async (): Promise<string> => { const b = crypto.getRandomValues(new Uint8Array(32)); return bytesToB64(b).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); };
const digest = async (value: string): Promise<string> => bytesToB64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
async function hashPassword(password: string, salt?: Uint8Array): Promise<{ salt: string; hash: string }> {
  const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: actualSalt as unknown as BufferSource, iterations: 100000, hash: "SHA-256" }, key, 256);
  return { salt: bytesToB64(actualSalt), hash: bytesToB64(new Uint8Array(bits)) };
}
async function verifyPassword(password: string, salt: string, expected: string): Promise<boolean> { return constantTimeEqual((await hashPassword(password, b64ToBytes(salt))).hash, expected); }
function constantTimeEqual(a: string, b: string): boolean { const x = encoder.encode(a), y = encoder.encode(b); let d = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0); return d === 0; }
async function body(request: Request): Promise<Record<string, unknown> | null> { try { const value: unknown = await request.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } }
function str(value: unknown, min = 1, max = 10000): value is string { return typeof value === "string" && value.length >= min && value.length <= max; }
function userView(row: Record<string, unknown>): User { return { id: String(row.id), email: String(row.email), display_name: row.display_name == null ? null : String(row.display_name) }; }
function clean(row: Record<string, unknown> | null): Record<string, unknown> | null { if (!row) return null; const copy = { ...row }; delete copy.password_hash; delete copy.password_salt; delete copy.token_hash; delete copy.delivery_lease_until; delete copy.request_fingerprint; return copy; }
function routeParts(url: URL): string[] | null {
  const raw = url.pathname.split("/");
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  const parts = raw.filter(Boolean);
  if (parts[0] === "api" && parts[1] === "v1") return parts.slice(2);
  if (parts[0] === "api" || parts[0] === "v1") return parts.slice(1);
  if (parts.length === 1 && parts[0] === "health") return parts;
  return null;
}
function expiresAt(input: unknown): string { const n = typeof input === "number" && Number.isFinite(input) ? input : 86400; return new Date(Date.now() + Math.max(60, Math.min(n, 2_592_000)) * 1000).toISOString(); }
function validDate(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const d = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value; }
function integerIn(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
function parseRules(value: unknown): { text: string } | null { if (typeof value === "string") { try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { text: value } : null; } catch { return null; } } if (value && typeof value === "object" && !Array.isArray(value)) return { text: JSON.stringify(value) }; return null; }
function boolValue(value: unknown, fallback?: number): number | null { if (value === undefined && fallback !== undefined) return fallback; return typeof value === "boolean" ? (value ? 1 : 0) : null; }
async function sessionAuth(request: Request, env: Env): Promise<Auth | Response> {
  const header = request.headers.get("authorization") ?? ""; if (!header.startsWith("Bearer ")) return error(401, "unauthorized", "A bearer session is required");
  const row = await env.DB.prepare("SELECT s.id AS session_id,s.user_id,s.expires_at,u.id,u.email,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(await digest(header.slice(7))).first<Record<string, unknown>>();
  return row ? { user: userView(row), sessionId: String(row.session_id) } : error(401, "unauthorized", "Invalid or expired session");
}
async function deviceAuth(request: Request, env: Env): Promise<DeviceAuth | Response> {
  const header = request.headers.get("authorization") ?? ""; const raw = request.headers.get("x-device-token") ?? (header.startsWith("Device ") ? header.slice(7) : ""); if (!raw) return error(401, "unauthorized", "A device token is required");
  const row = await env.DB.prepare("SELECT t.id AS token_id,t.device_id,d.user_id FROM device_tokens t JOIN devices d ON d.id=t.device_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND d.unbound_at IS NULL").bind(await digest(raw)).first<Record<string, unknown>>();
  return row ? { deviceId: String(row.device_id), userId: String(row.user_id), tokenId: String(row.token_id) } : error(401, "unauthorized", "Invalid device token");
}
async function ownsDevice(env: Env, userId: string, deviceId: string): Promise<boolean> { return !!await env.DB.prepare("SELECT id FROM devices WHERE id=? AND user_id=? AND unbound_at IS NULL").bind(deviceId, userId).first(); }
function deviceHeader(request: Request): boolean { const a = request.headers.get("authorization") ?? ""; return !!(request.headers.get("x-device-token") || a.startsWith("Device ")); }

async function createCommand(env: Env, userId: string, input: Record<string, unknown>, idem: string | null): Promise<Response> {
  const kind = str(input.kind) ? input.kind : input.command;
  if (!str(input.device_id) || !str(kind)) return error(400, "validation_error", "device_id and kind are required");
  if (!await ownsDevice(env, userId, input.device_id)) return error(404, "not_found", "Device not found");
  if (idem !== null && !str(idem, 1, 200)) return error(400, "validation_error", "Idempotency-Key is invalid");
  const payload = typeof input.payload_json === "string" ? input.payload_json : JSON.stringify(input.payload ?? input.payload_json ?? {});
  try { const parsed: unknown = JSON.parse(payload); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return error(400, "validation_error", "payload must be a JSON object"); } catch { return error(400, "validation_error", "payload must be valid JSON"); }
  const fingerprint = await digest(JSON.stringify({ device_id: input.device_id, kind, payload, expires_in: input.expires_in ?? null }));
  if (idem) {
    const inserted = await env.DB.prepare("INSERT OR IGNORE INTO commands (id,user_id,device_id,kind,payload_json,status,expires_at,idempotency_key,request_fingerprint) SELECT ?,?,id,?,?,?,?,?,? FROM devices WHERE id=? AND user_id=? AND unbound_at IS NULL RETURNING *").bind(id(), userId, kind, payload, "pending", expiresAt(input.expires_in), idem, fingerprint, input.device_id, userId).first<Record<string, unknown>>();
    if (inserted) return json(clean(inserted), 201);
    const old = await env.DB.prepare("SELECT * FROM commands WHERE user_id=? AND idempotency_key=?").bind(userId, idem).first<Record<string, unknown>>();
    if (!await ownsDevice(env, userId, input.device_id)) return error(404, "not_found", "Device not found");
    if (!old) return error(409, "idempotency_conflict", "Idempotency request could not be resolved");
    return old.request_fingerprint === fingerprint ? json(clean(old)) : error(409, "idempotency_conflict", "Idempotency key was used for another request");
  }
  const result = await env.DB.prepare("INSERT INTO commands (id,user_id,device_id,kind,payload_json,status,expires_at) SELECT ?,?,id,?,?,?,? FROM devices WHERE id=? AND user_id=? AND unbound_at IS NULL RETURNING *").bind(id(), userId, kind, payload, "pending", expiresAt(input.expires_in), input.device_id, userId).first<Record<string, unknown>>();
  return result ? json(clean(result), 201) : error(404, "not_found", "Device not found");
}

async function ackCommand(env: Env, commandId: string, deviceId: string, status: string, message: unknown): Promise<Response> {
  if (!["delivered", "executed", "failed"].includes(status)) return error(400, "validation_error", "status must be delivered, executed or failed");
  // A delivery acknowledgement is non-terminal: keep a lease so a device that
  // crashed before applying the command can receive it again. Only executed or
  // failed acknowledgements clear the lease.
  const lease = status === "delivered" ? new Date(Date.now() + 30_000).toISOString() : null;
  const result = await env.DB.prepare("UPDATE commands SET status=?,error_message=?,delivery_lease_until=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND device_id=? AND status='delivered' AND (delivery_lease_until IS NULL OR delivery_lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING *").bind(status, str(message) ? message : null, lease, commandId, deviceId).first<Record<string, unknown>>();
  return result ? json(clean(result)) : error(409, "ack_expired", "Command delivery lease expired or command is no longer deliverable");
}

async function pullCommands(env: Env, deviceId: string): Promise<Response> {
  await env.DB.prepare("UPDATE commands SET status='expired',delivery_lease_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE device_id=? AND status IN ('pending','delivered') AND expires_at IS NOT NULL AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(deviceId).run();
  const candidates = await env.DB.prepare("SELECT id FROM commands WHERE device_id=? AND ((status='pending' AND (delivery_lease_until IS NULL OR delivery_lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))) OR (status='delivered' AND delivery_lease_until IS NOT NULL AND delivery_lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))) ORDER BY created_at ASC LIMIT 100").bind(deviceId).all<{ id: string }>();
  if (candidates.results.length === 0) return json({ commands: [] });
  const lease = new Date(Date.now() + 30_000).toISOString();
  const claimed = await env.DB.batch(candidates.results.map(row => env.DB.prepare("UPDATE commands SET status='delivered',delivery_lease_until=?,delivery_attempts=delivery_attempts+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND device_id=? AND ((status='pending' AND (delivery_lease_until IS NULL OR delivery_lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))) OR (status='delivered' AND delivery_lease_until IS NOT NULL AND delivery_lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))) RETURNING *").bind(lease, row.id, deviceId)));
  const rows = claimed.flatMap(result => (result.results ?? []) as Record<string, unknown>[]).map(row => clean(row));
  return json({ commands: rows });
}

async function usageRows(env: Env, deviceId: string, input: Record<string, unknown>): Promise<{ statements: D1PreparedStatement[]; batchId: string } | Response> {
  const rawRows = Array.isArray(input.rows) ? input.rows : [input]; if (!rawRows.length || rawRows.length > 31) return error(400, "validation_error", "usage row count is invalid");
  const batchId = str(input.batchId, 1, 200) ? input.batchId : id(); const statements: D1PreparedStatement[] = [];
  for (const raw of rawRows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return error(400, "validation_error", "usage row is invalid"); const row = raw as Record<string, unknown>; const date = row.localDate ?? row.usage_date; if (!validDate(date)) return error(400, "validation_error", "usage date must be YYYY-MM-DD");
    const updated = row.updatedAtMillis ?? row.updated_at_millis ?? 0; if (!integerIn(updated, 0, Number.MAX_SAFE_INTEGER)) return error(400, "validation_error", "updated_at_millis is invalid");
    const deviceMillis = row.deviceForegroundMillis ?? row.device_foreground_millis ?? (row.duration_seconds === undefined ? undefined : Number(row.duration_seconds) * 1000); if (!integerIn(deviceMillis, 0, 604800000)) return error(400, "validation_error", "device foreground duration is invalid");
    const apps = row.appForeground ?? row.app_foreground ?? {}; if (!apps || typeof apps !== "object" || Array.isArray(apps)) return error(400, "validation_error", "appForeground is invalid"); const entries = Object.entries(apps).slice(0, 480);
    const add = (appId: string, millis: unknown) => { if (!str(appId, 1, 300) || !integerIn(millis, 0, 604800000)) throw new Error("invalid_usage"); statements.push(env.DB.prepare("INSERT INTO usage (id,device_id,app_id,usage_date,duration_seconds,updated_at_millis) VALUES (?,?,?,?,?,?) ON CONFLICT(device_id,app_id,usage_date) DO UPDATE SET duration_seconds=excluded.duration_seconds,updated_at_millis=excluded.updated_at_millis WHERE excluded.updated_at_millis>=usage.updated_at_millis").bind(id(), deviceId, appId, date, Math.floor(Number(millis) / 1000), updated)); };
    try { add("__device__", deviceMillis); for (const [app, millis] of entries) add(app, millis); } catch { return error(400, "validation_error", "usage values are invalid"); }
  }
  return { statements, batchId };
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  const parts = routeParts(url); if (!parts) return error(404, "not_found", "Route not found"); if (parts.length === 1 && parts[0] === "health" && request.method === "GET") return json({ status: "ok" }); if (!parts.length) return error(404, "not_found", "Route not found");
  const method = request.method;
  if (parts[0] === "auth" && parts.length === 2 && method === "POST" && ["register", "login"].includes(parts[1])) {
    const input = await body(request); if (!input || !str(input.email, 3, 320) || !str(input.password, 8, 200)) return error(400, "validation_error", "email and password (8+ characters) are required"); const email = input.email.trim().toLowerCase();
    if (parts[1] === "register") { const pass = await hashPassword(input.password); const userId = id(); try { await env.DB.prepare("INSERT INTO users (id,email,display_name,password_salt,password_hash) VALUES (?,?,?,?,?)").bind(userId, email, str(input.display_name) ? input.display_name : null, pass.salt, pass.hash).run(); } catch { return error(409, "email_taken", "Email is already registered"); } const token = await randomToken(); await env.DB.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)").bind(id(), userId, await digest(token), new Date(Date.now() + 2592000000).toISOString()).run(); return json({ user: { id: userId, email, display_name: str(input.display_name) ? input.display_name : null }, token, expires_in: 2592000 }, 201); }
    const row = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first<Record<string, unknown>>(); if (!row || !str(row.password_salt) || !str(row.password_hash) || !(await verifyPassword(input.password, row.password_salt, row.password_hash))) return error(401, "invalid_credentials", "Email or password is incorrect"); const token = await randomToken(); await env.DB.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)").bind(id(), row.id, await digest(token), new Date(Date.now() + 2592000000).toISOString()).run(); return json({ user: userView(row), token, expires_in: 2592000 });
  }
  if (parts[0] === "devices" && parts.length === 2 && parts[1] === "pair" && method === "POST") {
    const input = await body(request); const code = input?.code ?? input?.pairing_code; if (!input || !str(code, 6, 12) || !str(input.name) || !str(input.platform)) return error(400, "validation_error", "code, name and platform are required"); const pair = await env.DB.prepare("SELECT * FROM device_pairing_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(await digest(code)).first<Record<string, unknown>>(); if (!pair) return error(400, "invalid_pairing_code", "Pairing code is invalid or expired"); const deviceId = String(pair.id); const token = await randomToken(); try { await env.DB.batch([env.DB.prepare("INSERT INTO devices (id,user_id,name,platform,app_version) VALUES (?,?,?,?,?)").bind(deviceId, pair.user_id, input.name, input.platform, str(input.app_version) ? input.app_version : null), env.DB.prepare("INSERT INTO device_tokens (id,device_id,token_hash) VALUES (?,?,?)").bind(id(), deviceId, await digest(token)), env.DB.prepare("UPDATE device_pairing_codes SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND used_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(pair.id)]); } catch { return error(400, "invalid_pairing_code", "Pairing code is invalid or expired"); } return json({ device: { id: deviceId, user_id: pair.user_id, name: input.name, platform: input.platform, app_version: input.app_version ?? null }, device_token: token }, 201);
  }
  if (parts[0] === "devices" && parts.length === 3 && parts[2] === "heartbeat" && method === "POST" && deviceHeader(request)) {
    const da = await deviceAuth(request, env); if (da instanceof Response) return da; if (parts[1] !== da.deviceId) return error(403, "forbidden", "Device token does not match device");
    const input = await body(request) ?? {};
    const usageAccess = input.usageAccessGranted === undefined ? null : boolValue(input.usageAccessGranted);
    const accessibility = input.accessibilityEnabled === undefined ? null : boolValue(input.accessibilityEnabled);
    if (input.usageAccessGranted !== undefined && usageAccess === null) return error(400, "validation_error", "usageAccessGranted must be boolean");
    if (input.accessibilityEnabled !== undefined && accessibility === null) return error(400, "validation_error", "accessibilityEnabled must be boolean");
    await env.DB.prepare("UPDATE devices SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_sync_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),usage_access_granted=COALESCE(?,usage_access_granted),accessibility_enabled=COALESCE(?,accessibility_enabled),app_version=COALESCE(?,app_version),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND user_id=?").bind(usageAccess, accessibility, str(input.app_version) ? input.app_version : null, da.deviceId, da.userId).run();
    return json({ ok: true, device_id: da.deviceId, usage_access_granted: usageAccess, accessibility_enabled: accessibility });
  }
  if (parts[0] === "devices" && parts.length === 3 && parts[2] === "commands" && method === "GET" && deviceHeader(request)) { const da = await deviceAuth(request, env); if (da instanceof Response) return da; if (parts[1] !== da.deviceId) return error(403, "forbidden", "Device token does not match device"); return pullCommands(env, da.deviceId); }
  if (parts[0] === "devices" && parts.length === 3 && parts[2] === "usage" && method === "POST" && deviceHeader(request)) { const da = await deviceAuth(request, env); if (da instanceof Response) return da; if (parts[1] !== da.deviceId) return error(403, "forbidden", "Device token does not match device"); const input = await body(request); if (!input) return error(400, "validation_error", "JSON object is required"); const prepared = await usageRows(env, da.deviceId, input); if (prepared instanceof Response) return prepared; await env.DB.batch(prepared.statements); return json({ ok: true, accepted: prepared.statements.length, batchId: prepared.batchId }); }
  if (parts[0] === "devices" && parts.length === 5 && parts[2] === "commands" && parts[4] === "ack" && method === "POST" && deviceHeader(request)) { const da = await deviceAuth(request, env); if (da instanceof Response) return da; if (parts[1] !== da.deviceId) return error(403, "forbidden", "Device token does not match device"); const input = await body(request); return ackCommand(env, parts[3], da.deviceId, String(input?.status ?? ""), input?.error_message); }
  if (parts[0] === "devices" && parts.length === 3 && parts[2] === "policy" && method === "GET" && deviceHeader(request)) {
    const da = await deviceAuth(request, env); if (da instanceof Response) return da; if (parts[1] !== da.deviceId) return error(403, "forbidden", "Device token does not match device");
    const row = await env.DB.prepare("SELECT * FROM policies WHERE device_id=? AND enabled=1 ORDER BY version DESC, updated_at DESC LIMIT 1").bind(da.deviceId).first<Record<string, unknown>>();
    if (!row) return json({ version: 0, config: { enabled: false } });
    const known = Number(url.searchParams.get("version") ?? -1); const version = Number(row.version ?? 0);
    if (!Number.isSafeInteger(known) || known < -1) return error(400, "validation_error", "version must be an integer");
    if (known >= version) return json({ notModified: true, version });
    const rules = parseRules(row.rules_json); if (!rules) return json({ version, config: { enabled: Number(row.enabled) === 1 } });
    const config = JSON.parse(rules.text) as Record<string, unknown>; config.enabled = Number(row.enabled) === 1 && config.enabled !== false;
    return json({ version, config });
  }
  const authResult = await sessionAuth(request, env); if (authResult instanceof Response) return authResult; const auth = authResult;
  if (parts[0] === "auth" && parts.length === 2 && parts[1] === "logout" && method === "POST") { await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(auth.sessionId).run(); return json({ ok: true }); }
  if ((parts[0] === "me" && parts.length === 1 || parts[0] === "auth" && parts[1] === "session" && parts.length === 2) && method === "GET") return json({ user: auth.user });
  if (parts[0] === "devices" && parts.length === 2 && parts[1] === "pairing-codes" && method === "POST") { const random = crypto.getRandomValues(new Uint32Array(1))[0]; const code = String(100000 + (random % 900000)); await env.DB.prepare("INSERT INTO device_pairing_codes (id,user_id,code_hash,expires_at) VALUES (?,?,?,?)").bind(id(), auth.user.id, await digest(code), new Date(Date.now() + 600000).toISOString()).run(); return json({ code, expires_in: 600 }, 201); }
  if (parts[0] === "devices" && parts.length === 1 && method === "GET") { const rows = await env.DB.prepare("SELECT d.*,(SELECT p.id FROM policies p WHERE p.device_id=d.id AND p.enabled=1 ORDER BY p.version DESC,p.updated_at DESC LIMIT 1) AS policy_id,(SELECT p.version FROM policies p WHERE p.device_id=d.id AND p.enabled=1 ORDER BY p.version DESC,p.updated_at DESC LIMIT 1) AS policy_version FROM devices d WHERE d.user_id=? AND d.unbound_at IS NULL ORDER BY d.created_at DESC").bind(auth.user.id).all(); return json(rows.results.map(r => clean(r))); }
  if (parts[0] === "devices" && parts.length === 1 && method === "POST") { const input = await body(request); if (!input || !str(input.name) || !str(input.platform)) return error(400, "validation_error", "name and platform are required"); const deviceId = id(); const token = await randomToken(); await env.DB.batch([env.DB.prepare("INSERT INTO devices (id,user_id,name,platform,app_version) VALUES (?,?,?,?,?)").bind(deviceId, auth.user.id, input.name, input.platform, str(input.app_version) ? input.app_version : null), env.DB.prepare("INSERT INTO device_tokens (id,device_id,token_hash) VALUES (?,?,?)").bind(id(), deviceId, await digest(token))]); return json({ device: { id: deviceId, user_id: auth.user.id, name: input.name, platform: input.platform, app_version: input.app_version ?? null }, device_token: token }, 201); }
  if (parts[0] === "devices" && parts.length === 2 && method === "DELETE") {
    const deviceId = parts[1];
    const owner = auth.user.id;
    const now = new Date().toISOString();
    const activeDevice = "SELECT id FROM devices WHERE id=? AND user_id=? AND unbound_at IS NULL";
    const [, , , removed] = await env.DB.batch([
      env.DB.prepare(`UPDATE device_tokens SET revoked_at=? WHERE revoked_at IS NULL AND device_id IN (${activeDevice})`).bind(now, deviceId, owner),
      env.DB.prepare(`UPDATE commands SET status='expired',delivery_lease_until=NULL,updated_at=? WHERE status IN ('pending','delivered') AND device_id IN (${activeDevice})`).bind(now, deviceId, owner),
      env.DB.prepare(`UPDATE policies SET device_id=NULL,version=version+1,updated_at=? WHERE user_id=? AND device_id IN (${activeDevice})`).bind(now, owner, deviceId, owner),
      env.DB.prepare("UPDATE devices SET unbound_at=?,updated_at=? WHERE id=? AND user_id=? AND unbound_at IS NULL RETURNING id").bind(now, now, deviceId, owner),
    ]);
    return removed.results.length ? json({ ok: true, device_id: deviceId }) : error(404, "not_found", "Device not found");
  }
  if (parts[0] === "devices" && parts.length === 3 && parts[2] === "heartbeat" && method === "POST") { if (!await ownsDevice(env, auth.user.id, parts[1])) return error(404, "not_found", "Device not found"); const input = await body(request) ?? {}; await env.DB.prepare("UPDATE devices SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),app_version=COALESCE(?,app_version),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(str(input.app_version) ? input.app_version : null, parts[1]).run(); return json({ ok: true, device_id: parts[1] }); }
  if (parts[0] === "policies" && parts.length === 3 && parts[2] === "assign" && method === "POST") { const input = await body(request); const deviceId = input?.device_id ?? input?.deviceId; if (!str(deviceId)) return error(400, "validation_error", "device_id is required"); if (!await ownsDevice(env, auth.user.id, deviceId)) return error(404, "not_found", "Device not found"); const target = await env.DB.prepare("SELECT id FROM policies WHERE id=? AND user_id=?").bind(parts[1], auth.user.id).first(); if (!target) return error(404, "not_found", "Policy not found"); const result = await env.DB.batch([env.DB.prepare("UPDATE policies SET enabled=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND device_id=? AND enabled=1").bind(auth.user.id, deviceId), env.DB.prepare("UPDATE policies SET device_id=?,enabled=1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND user_id=? AND EXISTS (SELECT 1 FROM devices WHERE id=? AND user_id=? AND unbound_at IS NULL) RETURNING *").bind(deviceId, parts[1], auth.user.id, deviceId, auth.user.id)]); const row = (result[1].results?.[0] ?? null) as Record<string, unknown> | null; return row ? json(clean(row)) : error(404, "not_found", "Policy not found"); }
  if (parts[0] === "policies" && (parts.length === 1 || parts.length === 2)) {
    if (method === "GET") { const deviceId = url.searchParams.get("device_id"); if (deviceId && !await ownsDevice(env, auth.user.id, deviceId)) return error(404, "not_found", "Device not found"); if (parts[1]) { const row = await env.DB.prepare("SELECT * FROM policies WHERE id=? AND user_id=?").bind(parts[1], auth.user.id).first<Record<string, unknown>>(); return row ? json(clean(row)) : error(404, "not_found", "Policy not found"); } const rows = await env.DB.prepare(deviceId ? "SELECT * FROM policies WHERE user_id=? AND device_id=? ORDER BY version DESC" : "SELECT * FROM policies WHERE user_id=? ORDER BY updated_at DESC").bind(...(deviceId ? [auth.user.id, deviceId] : [auth.user.id])).all(); return json(rows.results.map(r => clean(r))); }
    if (parts.length === 2 && method === "PATCH") { const input = await body(request); if (!input || !Number.isInteger(input.version)) return error(400, "validation_error", "version is required"); const current = await env.DB.prepare("SELECT * FROM policies WHERE id=? AND user_id=?").bind(parts[1], auth.user.id).first<Record<string, unknown>>(); if (!current) return error(404, "not_found", "Policy not found"); if (input.version !== Number(current.version)) return error(409, "version_conflict", "Policy version changed"); const updates: string[] = []; const values: unknown[] = []; if (input.name !== undefined) { if (!str(input.name)) return error(400, "validation_error", "name is invalid"); updates.push("name=?"); values.push(input.name); } if (input.description !== undefined) { if (input.description !== null && !str(input.description, 0, 2000)) return error(400, "validation_error", "description is invalid"); updates.push("description=?"); values.push(input.description); } if (input.enabled !== undefined) { const enabled = boolValue(input.enabled); if (enabled === null) return error(400, "validation_error", "enabled must be boolean"); updates.push("enabled=?"); values.push(enabled); } if (input.rules_json !== undefined || input.rules !== undefined) { const rules = parseRules(input.rules_json ?? input.rules); if (!rules) return error(400, "validation_error", "rules_json must be a top-level object"); updates.push("rules_json=?"); values.push(rules.text); } if (!updates.length) return error(400, "validation_error", "No fields to update"); updates.push("version=version+1", "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"); const result = await env.DB.prepare(`UPDATE policies SET ${updates.join(",")} WHERE id=? AND user_id=? AND version=? RETURNING *`).bind(...values, parts[1], auth.user.id, input.version).first<Record<string, unknown>>(); return result ? json(clean(result)) : error(409, "version_conflict", "Policy version changed"); }
    if (parts.length === 1 && method === "POST") { const input = await body(request); if (!input || !str(input.name)) return error(400, "validation_error", "name is required"); if (input.version !== undefined && input.version !== 1) return error(400, "validation_error", "version must be 1"); const deviceId = input.device_id ?? input.deviceId; if (deviceId !== undefined && (!str(deviceId) || !await ownsDevice(env, auth.user.id, deviceId))) return error(404, "not_found", "Device not found"); const rules = parseRules(input.rules_json ?? input.rules ?? {}); if (!rules) return error(400, "validation_error", "rules_json must be a top-level object"); const enabled = boolValue(input.enabled, 1); if (enabled === null) return error(400, "validation_error", "enabled must be boolean"); const result = await env.DB.prepare("INSERT INTO policies (id,user_id,device_id,name,description,enabled,rules_json,version) VALUES (?,?,?,?,?,?,?,1) RETURNING *").bind(id(), auth.user.id, deviceId ?? null, input.name, input.description ?? null, enabled, rules.text).first<Record<string, unknown>>(); return json(clean(result), 201); }
  }
  if (parts[0] === "commands" && parts.length === 1 && method === "POST") return createCommand(env, auth.user.id, await body(request) ?? {}, request.headers.get("idempotency-key"));
  if (parts[0] === "commands" && parts.length === 1 && method === "GET") { const deviceId = url.searchParams.get("device_id"); if (!deviceId || !await ownsDevice(env, auth.user.id, deviceId)) return error(404, "not_found", "Device not found"); const rows = await env.DB.prepare("SELECT * FROM commands WHERE user_id=? AND device_id=? ORDER BY created_at ASC").bind(auth.user.id, deviceId).all(); return json(rows.results.map(r => clean(r))); }
  if (parts[0] === "commands" && parts.length === 3 && parts[2] === "ack" && method === "POST") { const input = await body(request); const row = await env.DB.prepare("SELECT device_id FROM commands WHERE id=? AND user_id=?").bind(parts[1], auth.user.id).first<{ device_id: string }>(); return row ? ackCommand(env, parts[1], row.device_id, String(input?.status ?? ""), input?.error_message) : error(404, "not_found", "Command not found"); }
  if (parts[0] === "devices" && parts.length === 3 && parts[2] === "commands" && method === "POST") return createCommand(env, auth.user.id, { ...(await body(request) ?? {}), device_id: parts[1] }, request.headers.get("idempotency-key"));
  if (parts[0] === "devices" && parts.length === 4 && parts[2] === "commands" && method === "GET") { if (!await ownsDevice(env, auth.user.id, parts[1])) return error(404, "not_found", "Device not found"); const row = await env.DB.prepare("SELECT * FROM commands WHERE id=? AND device_id=? AND user_id=?").bind(parts[3], parts[1], auth.user.id).first<Record<string, unknown>>(); return row ? json(clean(row)) : error(404, "not_found", "Command not found"); }
  if (parts[0] === "usage" && parts.length === 1 && method === "GET") { const deviceId = url.searchParams.get("device_id"); if (!deviceId || !await ownsDevice(env, auth.user.id, deviceId)) return error(404, "not_found", "Device not found"); const rows = await env.DB.prepare("SELECT u.* FROM usage u WHERE u.device_id=? ORDER BY usage_date DESC LIMIT 500").bind(deviceId).all(); return json(rows.results); }
  if (parts[0] === "usage" && parts.length === 1 && method === "POST") { const input = await body(request); if (!input || !str(input.device_id) || !str(input.app_id) || !validDate(input.usage_date) || !integerIn(input.duration_seconds, 0, 604800)) return error(400, "validation_error", "usage fields are invalid"); if (!await ownsDevice(env, auth.user.id, input.device_id)) return error(404, "not_found", "Device not found"); const updated = input.updated_at_millis ?? 0; if (!integerIn(updated, 0, Number.MAX_SAFE_INTEGER)) return error(400, "validation_error", "updated_at_millis is invalid"); const result = await env.DB.prepare("INSERT INTO usage (id,device_id,app_id,usage_date,duration_seconds,updated_at_millis) VALUES (?,?,?,?,?,?) ON CONFLICT(device_id,app_id,usage_date) DO UPDATE SET duration_seconds=excluded.duration_seconds,updated_at_millis=excluded.updated_at_millis WHERE excluded.updated_at_millis>=usage.updated_at_millis RETURNING *").bind(id(), input.device_id, input.app_id, input.usage_date, input.duration_seconds, updated).first<Record<string, unknown>>(); return json(result); }
  return error(404, "not_found", "Route not found");
}

export default { async fetch(request: Request, env: Env): Promise<Response> { try { return await handle(request, env); } catch (cause) { console.error("API request failed", cause); return error(500, "internal_error", "Request could not be completed"); } } };
