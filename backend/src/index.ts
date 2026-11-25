export interface Env {
  DB: D1Database;
  AUTH_TOKEN?: string;
}

type Entity = "users" | "devices" | "policies" | "commands" | "usage";
type Field = "email" | "display_name" | "user_id" | "name" | "platform" | "app_version" |
  "enabled" | "rules_json" | "device_id" | "kind" | "payload_json" | "status" |
  "app_id" | "usage_date" | "duration_seconds";

const schemas: Record<Entity, { required: Field[]; allowed: Field[] }> = {
  users: { required: ["email"], allowed: ["email", "display_name"] },
  devices: { required: ["user_id", "name", "platform"], allowed: ["user_id", "name", "platform", "app_version"] },
  policies: { required: ["user_id", "name"], allowed: ["user_id", "name", "enabled", "rules_json"] },
  commands: { required: ["device_id", "kind"], allowed: ["device_id", "kind", "payload_json", "status"] },
  usage: { required: ["device_id", "app_id", "usage_date", "duration_seconds"], allowed: ["device_id", "app_id", "usage_date", "duration_seconds"] },
};

const json = (data: unknown, status = 200): Response => Response.json(data, { status });
const error = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status);
const id = (): string => crypto.randomUUID();

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

async function bodyObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function validField(field: Field, value: unknown): boolean {
  if (field === "enabled") return value === 0 || value === 1 || typeof value === "boolean";
  if (field === "duration_seconds") return Number.isInteger(value) && (value as number) >= 0;
  return typeof value === "string" && value.length > 0;
}

function normalize(field: Field, value: unknown): unknown {
  if (field === "enabled" && typeof value === "boolean") return value ? 1 : 0;
  if (field === "rules_json" || field === "payload_json") {
    try { JSON.parse(value as string); } catch { return undefined; }
  }
  return value;
}

function validate(entity: Entity, input: Record<string, unknown>, partial: boolean): { values?: Partial<Record<Field, unknown>>; problem?: string } {
  const schema = schemas[entity];
  for (const key of Object.keys(input)) {
    if (!(schema.allowed as string[]).includes(key)) return { problem: `Unknown field: ${key}` };
  }
  if (!partial) {
    const missing = schema.required.filter((key) => !(key in input));
    if (missing.length) return { problem: `Missing required field(s): ${missing.join(", ")}` };
  }
  const values: Partial<Record<Field, unknown>> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const field = rawKey as Field;
    const value = normalize(field, rawValue);
    if (value === undefined || !validField(field, value)) return { problem: `Invalid value for ${field}` };
    values[field] = value;
  }
  return { values };
}

function parseEntity(value: string | undefined): Entity | null {
  return value && Object.hasOwn(schemas, value) ? value as Entity : null;
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return json({ status: "ok" });
  if (!env.AUTH_TOKEN) return error(503, "auth_not_configured", "AUTH_TOKEN is not configured");
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!constantTimeEqual(token, env.AUTH_TOKEN)) return error(401, "unauthorized", "A valid bearer token is required");

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1") return error(404, "not_found", "Route not found");

  if (parts[1] === "devices" && parts[3] === "heartbeat" && parts[2] && request.method === "POST") {
    const result = await env.DB.prepare("UPDATE devices SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? RETURNING *")
      .bind(parts[2]).first();
    return result ? json(result) : error(404, "not_found", "Device not found");
  }

  const entity = parseEntity(parts[1]);
  if (!entity) return error(404, "not_found", "Route not found");
  const table = entity;

  if (entity === "usage" && request.method === "GET") {
    const deviceId = url.searchParams.get("device_id");
    if (!deviceId) return error(400, "invalid_query", "device_id is required");
    const rows = await env.DB.prepare("SELECT * FROM usage WHERE device_id = ? ORDER BY usage_date DESC LIMIT 500").bind(deviceId).all();
    return json(rows.results);
  }

  if (parts.length === 2 && request.method === "GET") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);
    const rows = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
    return json(rows.results);
  }

  if (parts.length === 2 && request.method === "POST") {
    const input = await bodyObject(request);
    if (!input) return error(400, "invalid_json", "Request body must be a JSON object");
    const checked = validate(entity, input, false);
    if (checked.problem) return error(400, "validation_error", checked.problem);
    const values = checked.values!;
    const columns = ["id", ...Object.keys(values)];
    const params = [id(), ...Object.values(values)];
    const result = await env.DB.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) RETURNING *`)
      .bind(...params).first();
    return json(result, 201);
  }

  if (parts.length === 3 && request.method === "GET") {
    const result = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(parts[2]).first();
    return result ? json(result) : error(404, "not_found", `${entity} record not found`);
  }

  if (parts.length === 3 && request.method === "PATCH") {
    const input = await bodyObject(request);
    if (!input || Object.keys(input).length === 0) return error(400, "invalid_json", "A non-empty JSON object is required");
    const checked = validate(entity, input, true);
    if (checked.problem) return error(400, "validation_error", checked.problem);
    const entries = Object.entries(checked.values!);
    const assignments = [...entries.map(([key]) => `${key} = ?`), "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"];
    const result = await env.DB.prepare(`UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ? RETURNING *`)
      .bind(...entries.map(([, value]) => value), parts[2]).first();
    return result ? json(result) : error(404, "not_found", `${entity} record not found`);
  }

  if (parts.length === 3 && request.method === "DELETE") {
    const result = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ? RETURNING id`).bind(parts[2]).first();
    return result ? json({ deleted: true, id: parts[2] }) : error(404, "not_found", `${entity} record not found`);
  }
  return error(405, "method_not_allowed", "Method or route is not supported");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (cause) {
      console.error("API request failed", cause);
      return error(500, "internal_error", "Request could not be completed");
    }
  },
};
