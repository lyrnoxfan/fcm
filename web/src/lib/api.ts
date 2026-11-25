export type Device = {
  id: string;
  name: string;
  status: string;
  lastSeen?: string;
  platform?: string;
  policyId?: string;
};

export type Policy = {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  deviceCount?: number;
};

export type ApiConfig = {
  baseUrl: string;
  token: string;
};

export type ApiError = Error & { status?: number };

const configKey = 'focusguard.api.config';

export function readConfig(): ApiConfig {
  if (typeof window === 'undefined') return { baseUrl: '', token: '' };
  try {
    const parsed = JSON.parse(localStorage.getItem(configKey) || '{}') as Partial<ApiConfig>;
    return { baseUrl: parsed.baseUrl || '', token: parsed.token || '' };
  } catch {
    return { baseUrl: '', token: '' };
  }
}

export function saveConfig(config: ApiConfig) {
  localStorage.setItem(configKey, JSON.stringify(config));
}

export function clearConfig() {
  localStorage.removeItem(configKey);
}

export function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

export async function request<T>(config: ApiConfig, path: string, init: RequestInit = {}): Promise<T> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) throw new Error('请先设置 API Base URL。');
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (config.token) headers.set('Authorization', `Bearer ${config.token}`);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  } catch (error) {
    const detail = error instanceof Error ? error.message : '网络连接失败';
    throw new Error(`无法连接 API（${detail}）。请检查 Base URL、服务状态与 CORS 配置。`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const message = body ? `：${body.slice(0, 240)}` : '';
    const failure = new Error(`API 请求失败 (${response.status} ${response.statusText})${message}`) as ApiError;
    failure.status = response.status;
    throw failure;
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('API 返回的内容不是有效 JSON。');
  }
}

export function unwrapList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['items', 'data', 'results', 'devices', 'policies']) {
      if (Array.isArray(record[key])) return record[key] as T[];
    }
  }
  throw new Error('API 列表响应格式不符合预期（需要数组或 items/data/results 字段）。');
}
