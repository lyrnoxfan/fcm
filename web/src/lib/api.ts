export type Device = {
  id: string;
  name: string;
  status: string;
  lastSeen?: string;
  platform?: string;
  appVersion?: string;
  policyId?: string;
  policyVersion?: string | number;
  commandStatus?: string;
};

export type Policy = {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  version?: string | number;
  deviceCount?: number;
  rules?: unknown;
};

export type Command = {
  id: string;
  deviceId?: string;
  kind: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
};

export type UsageRecord = {
  id?: string;
  deviceId?: string;
  appId: string;
  usageDate: string;
  durationSeconds: number;
};

export type ApiConfig = { baseUrl: string; token: string };
export type ApiError = Error & { status?: number; code?: string };
export type ApiSession = { token?: string; access_token?: string; user?: { name?: string; email?: string; display_name?: string } };

const configKey = 'focusguard.api.config';

export const API_PATHS = {
  register: '/auth/register', login: '/auth/login', session: '/auth/session',
  devices: '/devices', pairingCodes: '/devices/pairing-codes', policies: '/policies', usage: '/usage',
} as const;

export function readConfig(): ApiConfig {
  if (typeof window === 'undefined') return { baseUrl: '', token: '' };
  try {
    const parsed = JSON.parse(localStorage.getItem(configKey) || '{}') as Partial<ApiConfig>;
    return { baseUrl: parsed.baseUrl || '', token: parsed.token || '' };
  } catch { return { baseUrl: '', token: '' }; }
}

export function saveConfig(config: ApiConfig) { if (typeof window !== 'undefined') localStorage.setItem(configKey, JSON.stringify(config)); }
export function clearConfig() { if (typeof window !== 'undefined') localStorage.removeItem(configKey); }
export function normalizeBaseUrl(value: string) { return value.trim().replace(/\/+$/, ''); }

/** Accept an origin, /api, /v1, or /api/v1 without duplicating the prefix. */
export function apiUrl(baseUrl: string, path: string) {
  const base = normalizeBaseUrl(baseUrl);
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (/\/api\/v1$/i.test(base) || /\/v1$/i.test(base)) return `${base}${suffix}`;
  if (/\/api$/i.test(base)) return `${base}/v1${suffix}`;
  return `${base}/api/v1${suffix}`;
}

function unauthorized() { if (typeof window !== 'undefined') window.dispatchEvent(new Event('focusguard:unauthorized')); }

export async function request<T>(config: ApiConfig, path: string, init: RequestInit = {}): Promise<T> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) throw new Error('请先设置 API Base URL。');
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (config.token) headers.set('Authorization', `Bearer ${config.token}`);
  let response: Response;
  try { response = await fetch(apiUrl(baseUrl, path), { ...init, headers }); }
  catch (error) {
    const detail = error instanceof Error ? error.message : '网络连接失败';
    throw new Error(`无法连接 API（${detail}）。请检查 Base URL、服务状态与 CORS 配置。`);
  }
  if (!response.ok) {
    if (response.status === 401) unauthorized();
    const body = await response.text().catch(() => '');
    let message = ''; let code: string | undefined;
    if (body) {
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string; code?: string }; message?: string };
        message = parsed.error?.message || parsed.message || ''; code = parsed.error?.code;
      } catch { message = body.slice(0, 240); }
    }
    const failure = new Error(message || `API 请求失败 (${response.status} ${response.statusText})`) as ApiError;
    failure.status = response.status; failure.code = code; throw failure;
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; } catch { throw new Error('API 返回的内容不是有效 JSON。'); }
}

export function unwrapList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['items', 'data', 'results', 'devices', 'policies', 'commands', 'usage']) {
      if (Array.isArray(record[key])) return record[key] as T[];
      if (record[key] && typeof record[key] === 'object') { try { return unwrapList<T>(record[key]); } catch { /* continue */ } }
    }
  }
  throw new Error('API 列表响应格式不符合预期（需要数组或 items/data/results 字段）。');
}

function text(value: unknown) { return typeof value === 'string' ? value : value == null ? undefined : String(value); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }

export function normalizeDevice(value: unknown): Device {
  const item = record(value);
  const lastSeen = text(item.lastSeen ?? item.last_seen_at ?? item.lastHeartbeat ?? item.last_heartbeat_at ?? item.heartbeat_at);
  const explicitStatus = text(item.status ?? item.connection_status ?? item.state);
  const online = item.online === true || item.is_online === true || (lastSeen ? Date.now() - new Date(lastSeen).getTime() < 5 * 60_000 : false);
  return {
    id: text(item.id ?? item.device_id) || 'unknown', name: text(item.name ?? item.device_name) || text(item.id ?? item.device_id) || '未命名设备',
    status: explicitStatus || (online ? 'online' : lastSeen ? 'offline' : 'unknown'), lastSeen,
    platform: text(item.platform ?? item.os), appVersion: text(item.appVersion ?? item.app_version),
    policyId: text(item.policyId ?? item.policy_id ?? record(item.policy).id), policyVersion: text(item.policyVersion ?? item.policy_version ?? record(item.policy).version),
    commandStatus: text(item.commandStatus ?? item.command_status),
  };
}

export function normalizePolicy(value: unknown): Policy {
  const item = record(value); let rules: unknown = item.rules ?? item.rules_json;
  if (typeof rules === 'string') { try { rules = JSON.parse(rules); } catch { /* preserve backend value */ } }
  const enabled = item.enabled === undefined ? undefined : item.enabled === true || item.enabled === 1 || item.enabled === '1';
  return {
    id: text(item.id ?? item.policy_id) || 'unknown', name: text(item.name ?? item.policy_name) || '未命名策略',
    description: text(item.description ?? item.summary), enabled, version: text(item.version ?? item.policy_version), rules,
    deviceCount: typeof item.deviceCount === 'number' ? item.deviceCount : typeof item.device_count === 'number' ? item.device_count : undefined,
  };
}

export function normalizeCommand(value: unknown): Command {
  const item = record(value);
  return {
    id: text(item.id ?? item.command_id) || '', deviceId: text(item.deviceId ?? item.device_id), kind: text(item.kind ?? item.command) || 'command',
    status: text(item.status ?? item.state) || 'pending', createdAt: text(item.createdAt ?? item.created_at), updatedAt: text(item.updatedAt ?? item.updated_at), error: text(item.error ?? item.error_message),
  };
}

export function normalizeUsage(value: unknown): UsageRecord {
  const item = record(value);
  return { id: text(item.id), deviceId: text(item.deviceId ?? item.device_id), appId: text(item.appId ?? item.app_id) || 'unknown', usageDate: text(item.usageDate ?? item.usage_date) || '', durationSeconds: Number(item.durationSeconds ?? item.duration_seconds ?? 0) || 0 };
}
