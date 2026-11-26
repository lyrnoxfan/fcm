import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SyntheticEvent, ReactNode } from 'react';
import {
  Activity, AlertCircle, ArrowRight, Check, ChevronDown, CircleHelp, Clock3, Code2,
  Laptop, LayoutDashboard, LoaderCircle, LockKeyhole, LogOut, Menu, Pencil,
  Plus, RefreshCw, Search, Send, Settings2, Shield, ShieldCheck, Smartphone, Sparkles,
  Terminal, Wifi, X,
} from 'lucide-react';
import {
  API_PATHS, clearConfig, normalizeBaseUrl, normalizeCommand, normalizeDevice, normalizePolicy,
  normalizeUsage, readConfig, request, saveConfig, unwrapList,
} from '../lib/api';
import type {
  ApiConfig, ApiError, ApiSession, Command as ApiCommand, Device, Policy, UsageRecord,
} from '../lib/api';

type AuthMode = 'login' | 'register';
type View = 'overview' | 'devices' | 'policies';
type NoticeKind = 'success' | 'error' | 'info';
type Notice = { kind: NoticeKind; text: string };
type CommandKind = 'sync' | 'lock' | 'unlock';
type CommandState = ApiCommand & { deviceId: string };
type PolicyEditorState = { mode: 'create' | 'edit'; policy?: Policy };
type DataStatus = 'idle' | 'loading' | 'ready' | 'error';

type PolicyFormValues = {
  name: string;
  description: string;
  rules: string;
  enabled: boolean;
  deviceId: string;
};

const TERMINAL_COMMANDS = new Set(['executed', 'failed', 'expired']);
const SUCCESS_COMMANDS = new Set(['executed']);
const COMMAND_LABELS: Record<string, string> = {
  sync: '立即同步',
  lock: '远程锁定',
  unlock: '解除限制',
};
const STATUS_LABELS: Record<string, string> = {
  pending: '等待设备',
  delivered: '已送达',
  executed: '已执行',
  failed: '执行失败',
  expired: '已过期',
};

function isOnline(status?: string) {
  return ['online', 'active', 'connected', '已连接', '在线'].includes((status || '').toLowerCase());
}

function statusLabel(status?: string) {
  const key = (status || 'unknown').toLowerCase();
  return STATUS_LABELS[key] || (status || '未知');
}

function statusTone(status?: string) {
  const key = (status || 'unknown').toLowerCase();
  if (key === 'executed' || key === 'online' || key === 'active' || key === 'connected') return 'success';
  if (key === 'failed' || key === 'expired' || key === 'offline') return 'danger';
  if (key === 'delivered') return 'accent';
  return 'pending';
}

function commandLabel(kind?: string) {
  return COMMAND_LABELS[(kind || '').toLowerCase()] || kind || '命令';
}

function formatDate(value?: string) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function relativeTime(value?: string) {
  if (!value) return '暂无心跳';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const delta = Date.now() - time;
  if (delta < 45_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 分钟';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  return `${Math.max(minutes, 1)} 分钟`;
}

function durationForDevice(records: UsageRecord[], deviceId: string) {
  const entries = records.filter((item) => item.deviceId === deviceId);
  const deviceTotal = entries.find((item) => item.appId === '__device__');
  return deviceTotal ? deviceTotal.durationSeconds : entries.reduce((total, item) => total + item.durationSeconds, 0);
}

function initials(value: string) {
  return value.trim().slice(0, 1).toUpperCase() || 'F';
}

function deviceIcon(platform?: string) {
  return platform?.toLowerCase().includes('ios') || platform?.toLowerCase().includes('android')
    ? <Smartphone size={18} />
    : <Laptop size={18} />;
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function prettyRules(value: unknown) {
  if (!value || typeof value !== 'object') return '{}';
  try { return JSON.stringify(value, null, 2); } catch { return '{}'; }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function ConsoleApp() {
  const [config, setConfig] = useState<ApiConfig>({ baseUrl: '', token: '' });
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [userLabel, setUserLabel] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [authBusy, setAuthBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [view, setView] = useState<View>('overview');
  const [devices, setDevices] = useState<Device[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [commands, setCommands] = useState<Record<string, CommandState>>({});
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [dataStatus, setDataStatus] = useState<DataStatus>('idle');
  const [loading, setLoading] = useState(false);
  const [dataError, setDataError] = useState('');
  const [partialErrors, setPartialErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [search, setSearch] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [baseDraft, setBaseDraft] = useState('');
  const [unbindDevice, setUnbindDevice] = useState<Device | null>(null);
  const unboundIds = useRef(new Set<string>());
  const [selected, setSelected] = useState<string | null>(null);
  const [busyCommands, setBusyCommands] = useState<Record<string, boolean>>({});
  const [busyPolicy, setBusyPolicy] = useState<string | null>(null);
  const [policyEditor, setPolicyEditor] = useState<PolicyEditorState | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);

  const refreshGeneration = useRef(0);
  const sessionGeneration = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());
  const authGeneration = useRef(0);
  const loggingOut = useRef(false);

  useEffect(() => {
    const current = readConfig();
    setConfig(current);
    setBaseDraft(current.baseUrl);
    setAuthenticated(Boolean(current.token && current.baseUrl));
    setReady(true);
  }, []);

  const notify = useCallback((kind: NoticeKind, text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice((current) => current?.text === text ? null : current), 6500);
  }, []);

  const logout = useCallback(async () => {
    if (loggingOut.current) return;
    loggingOut.current = true;
    sessionGeneration.current += 1;
    refreshGeneration.current += 1;
    refreshController.current?.abort();
    const current = config;
    try {
      if (current.baseUrl && current.token) await request(current, API_PATHS.logout, { method: 'POST' });
    } catch {
      // Local session is still cleared when the server is unavailable.
    }
    clearConfig();
    setConfig({ baseUrl: '', token: '' });
    setAuthenticated(false);
    setDevices([]);
    setPolicies([]);
    setCommands({});
    setUsage([]);
    setDataStatus('idle');
    setDataError('');
    setPartialErrors([]);
    setSelected(null);
    setUnbindDevice(null);
    unboundIds.current.clear();
    setUserLabel('');
    setBusyCommands({});
    idempotencyKeys.current.clear();
    loggingOut.current = false;
  }, [config]);

  useEffect(() => {
    const handleUnauthorized = () => {
      void logout();
      notify('error', '登录已过期，请重新登录。');
    };
    window.addEventListener('focusguard:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('focusguard:unauthorized', handleUnauthorized);
  }, [logout, notify]);

  useEffect(() => {
    if (!ready || !authenticated || !config.baseUrl || !config.token) return;
    const generation = ++authGeneration.current;
    setSessionBusy(true);
    const snapshot = config;
    void request<ApiSession>(snapshot, API_PATHS.session)
      .then((session) => {
        if (generation !== authGeneration.current) return;
        setUserLabel(session?.user?.name || session?.user?.display_name || session?.user?.email || '');
      })
      .catch((error: unknown) => {
        if (generation !== authGeneration.current || (error as ApiError)?.status === 401) return;
        notify('error', errorMessage(error, '会话校验失败。'));
      })
      .finally(() => {
        if (generation === authGeneration.current) setSessionBusy(false);
      });
  }, [authenticated, config.baseUrl, config.token, notify, ready]);

  const refresh = useCallback(async () => {
    const snapshot = config;
    if (!snapshot.baseUrl || !snapshot.token) return;
    const generation = ++refreshGeneration.current;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    setLoading(true);
    setDataError('');
    setPartialErrors([]);
    setDataStatus((current) => current === 'ready' ? current : 'loading');
    try {
      const [deviceResponse, policyResponse] = await Promise.all([
        request<unknown>(snapshot, API_PATHS.devices, { signal: controller.signal }),
        request<unknown>(snapshot, API_PATHS.policies, { signal: controller.signal }),
      ]);
      if (generation !== refreshGeneration.current) return;
      const nextDevices = unwrapList<unknown>(deviceResponse).map(normalizeDevice);
      const nextPolicies = unwrapList<unknown>(policyResponse).map(normalizePolicy);
      setDevices(nextDevices);
      setPolicies(nextPolicies);

      const commandResults = await Promise.all(nextDevices.map(async (device) => {
        try {
          const response = await request<unknown>(snapshot, `${API_PATHS.commands}?device_id=${encodeURIComponent(device.id)}`, { signal: controller.signal });
          return { deviceId: device.id, commands: unwrapList<unknown>(response).map(normalizeCommand), error: '' };
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          return { deviceId: device.id, commands: [], error: `设备 ${device.name} 的命令历史读取失败：${errorMessage(error, '未知错误')}` };
        }
      }));
      const usageResults = await Promise.all(nextDevices.map(async (device) => {
        try {
          const response = await request<unknown>(snapshot, `${API_PATHS.usage}?device_id=${encodeURIComponent(device.id)}`, { signal: controller.signal });
          return { deviceId: device.id, usage: unwrapList<unknown>(response).map(normalizeUsage), error: '' };
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          return { deviceId: device.id, usage: [], error: `设备 ${device.name} 的 usage 读取失败：${errorMessage(error, '未知错误')}` };
        }
      }));
      if (generation !== refreshGeneration.current) return;
      const commandMap: Record<string, CommandState> = {};
      commandResults.forEach((result) => result.commands.forEach((command) => {
        if (command.id) commandMap[command.id] = { ...command, deviceId: result.deviceId };
      }));
      setCommands(commandMap);
      setUsage(usageResults.flatMap((result) => result.usage));
      const errors = [...commandResults, ...usageResults].map((result) => result.error).filter(Boolean);
      setPartialErrors(errors);
      setDataStatus('ready');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (generation !== refreshGeneration.current) return;
      const message = errorMessage(error, '读取控制台数据失败。');
      setDataError(message);
      setDataStatus('error');
      notify('error', message);
    } finally {
      if (generation === refreshGeneration.current) {
        setLoading(false);
        if (refreshController.current === controller) refreshController.current = null;
      }
    }
  }, [config, notify]);

  useEffect(() => {
    if (ready && authenticated && config.baseUrl && config.token) void refresh();
  }, [authenticated, config.baseUrl, config.token, ready, refresh]);

  const onlineCount = useMemo(() => devices.filter((device) => isOnline(device.status)).length, [devices]);
  const filteredDevices = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return devices;
    return devices.filter((device) => [device.name, device.id, device.status, device.platform, device.policyId]
      .some((value) => value?.toLowerCase().includes(term)));
  }, [devices, search]);
  const currentDevice = devices.find((device) => device.id === selected) || null;
  const commandForDevice = useCallback((deviceId: string) => Object.values(commands)
    .filter((command) => command.deviceId === deviceId)
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))[0], [commands]);
  const commandsForDevice = useCallback((deviceId: string) => Object.values(commands)
    .filter((command) => command.deviceId === deviceId)
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')), [commands]);

  async function authenticate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrl(baseDraft);
    } catch (error) {
      notify('error', errorMessage(error, 'API Base URL 无效。'));
      return;
    }
    if (!baseUrl) {
      notify('error', '请填写 API Base URL。');
      return;
    }
    setAuthBusy(true);
    const path = authMode === 'login' ? API_PATHS.login : API_PATHS.register;
    try {
      const result = await request<ApiSession>({ baseUrl, token: '' }, path, {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const token = result?.token || result?.access_token;
      if (!token) throw new Error('认证响应中未找到 token/access_token，无法建立会话。');
      const next = { baseUrl, token };
      saveConfig(next);
      setConfig(next);
      setUserLabel(result.user?.name || result.user?.display_name || result.user?.email || email);
      setAuthenticated(true);
      setPassword('');
      notify('success', authMode === 'login' ? '登录成功，正在读取真实数据。' : '账户已创建，正在读取真实数据。');
    } catch (error) {
      notify('error', errorMessage(error, '认证请求失败。'));
    } finally {
      setAuthBusy(false);
    }
  }

  function saveBaseUrl(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrl(baseDraft);
    } catch (error) {
      notify('error', errorMessage(error, 'API Base URL 无效。'));
      return;
    }
    if (!baseUrl) {
      notify('error', 'API Base URL 不能为空。');
      return;
    }
    const next = { ...config, baseUrl };
    saveConfig(next);
    setConfig(next);
    setShowSettings(false);
    setDataStatus('idle');
    notify('success', 'API 地址已保存，将重新验证会话。');
  }

  const pollCommand = useCallback(async (deviceId: string, commandId: string, operation: string, generation: number, kind: CommandKind) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (generation !== sessionGeneration.current || unboundIds.current.has(deviceId) || !config.baseUrl || !config.token) return;
      try {
        const result = await request<unknown>(config, `${API_PATHS.devices}/${encodeURIComponent(deviceId)}/commands/${encodeURIComponent(commandId)}`);
        if (generation !== sessionGeneration.current || unboundIds.current.has(deviceId)) return;
        const next = { ...normalizeCommand(result), deviceId };
        setCommands((current) => ({ ...current, [commandId]: next }));
        const normalized = next.status.toLowerCase();
        if (TERMINAL_COMMANDS.has(normalized)) {
          idempotencyKeys.current.delete(operation);
          setBusyCommands((current) => {
            const copy = { ...current };
            delete copy[operation];
            return copy;
          });
          notify(SUCCESS_COMMANDS.has(normalized) ? 'success' : 'error', next.error
            ? `${commandLabel(next.kind)}：${statusLabel(next.status)}，${next.error}`
            : `${commandLabel(next.kind)}：${statusLabel(next.status)}。`);
          return;
        }
      } catch (error) {
        if ((error as ApiError)?.status === 401) return;
        // A transient status read failure must not be rendered as a false terminal state.
        if (attempt === 29) notify('error', `${commandLabel(kind)} 状态查询超时，请刷新查看。`);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    setBusyCommands((current) => {
      const copy = { ...current };
      delete copy[operation];
      return copy;
    });
  }, [config, notify]);

  const sendDeviceCommand = useCallback(async (device: Device, kind: CommandKind) => {
    const operation = `${device.id}:${kind}`;
    if (busyCommands[operation]) return;
    const key = idempotencyKeys.current.get(operation) || `console-${crypto.randomUUID()}`;
    idempotencyKeys.current.set(operation, key);
    setBusyCommands((current) => ({ ...current, [operation]: true }));
    const generation = sessionGeneration.current;
    try {
      const response = await request<unknown>(config, `${API_PATHS.devices}/${encodeURIComponent(device.id)}/commands`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ kind, payload: {} }),
      });
      if (generation !== sessionGeneration.current || unboundIds.current.has(device.id)) return;
      const queued = normalizeCommand(response);
      if (!queued.id) throw new Error('命令响应中未找到 command id，无法查询执行状态。');
      const initial: CommandState = { ...queued, deviceId: device.id, status: queued.status || 'pending' };
      setCommands((current) => ({ ...current, [initial.id]: initial }));
      notify('success', `${commandLabel(kind)}已入队，等待设备回执。`);
      void pollCommand(device.id, initial.id, operation, generation, kind);
    } catch (error) {
      // Keep the idempotency key so a user retry can safely resolve the same request.
      setBusyCommands((current) => {
        const copy = { ...current };
        delete copy[operation];
        return copy;
      });
      notify('error', errorMessage(error, '远程命令发送失败。'));
    }
  }, [busyCommands, config, notify, pollCommand]);

  async function confirmUnbind(device: Device) {
    const generation = sessionGeneration.current;
    const result = await request<{ ok?: boolean; device_id?: string }>(config, `${API_PATHS.devices}/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
    if (result?.ok !== true || result.device_id !== device.id) throw new Error('服务器未返回解绑确认，请刷新设备列表。');
    if (generation !== sessionGeneration.current) return;
    unboundIds.current.add(device.id);
    refreshGeneration.current += 1;
    refreshController.current?.abort();
    setDevices((rows) => rows.filter((row) => row.id !== device.id));
    setUsage((rows) => rows.filter((row) => row.deviceId !== device.id));
    setCommands((rows) => Object.fromEntries(Object.entries(rows).filter(([, row]) => row.deviceId !== device.id)));
    setPolicies((rows) => rows.map((row) => row.deviceId === device.id ? { ...row, deviceId: undefined } : row));
    setBusyCommands((rows) => Object.fromEntries(Object.entries(rows).filter(([key]) => !key.startsWith(`${device.id}:`))));
    for (const key of idempotencyKeys.current.keys()) if (key.startsWith(`${device.id}:`)) idempotencyKeys.current.delete(key);
    setSelected(null);
    setUnbindDevice(null);
    notify('success', '设备已解绑，旧凭证已失效。');
    void refresh();
  }

  async function savePolicy(values: PolicyFormValues, editor: PolicyEditorState) {
    const operation = editor.policy?.id || 'new';
    if (busyPolicy) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(values.rules);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('规则 JSON 必须是对象。');
    } catch (error) {
      notify('error', errorMessage(error, '规则 JSON 无效。'));
      return;
    }
    setBusyPolicy(operation);
    const body: Record<string, unknown> = {
      name: values.name.trim(),
      description: values.description.trim(),
      enabled: values.enabled,
      rules_json: JSON.stringify(parsed),
    };
    if (!body.name) {
      setBusyPolicy(null);
      notify('error', '策略名称不能为空。');
      return;
    }
    try {
      if (editor.mode === 'create') {
        if (values.deviceId) body.device_id = values.deviceId;
        await request(config, API_PATHS.policies, { method: 'POST', body: JSON.stringify(body) });
      } else {
        const version = Number(editor.policy?.version);
        if (!Number.isSafeInteger(version)) throw new Error('策略版本缺失，刷新后再试。');
        body.version = version;
        await request(config, `${API_PATHS.policies}/${encodeURIComponent(editor.policy?.id || '')}`, { method: 'PATCH', body: JSON.stringify(body) });
        if (values.deviceId && values.deviceId !== editor.policy?.deviceId) {
          await request(config, `${API_PATHS.policies}/${encodeURIComponent(editor.policy?.id || '')}/assign`, { method: 'POST', body: JSON.stringify({ device_id: values.deviceId }) });
        }
      }
      setPolicyEditor(null);
      notify('success', editor.mode === 'create' ? '策略已创建。' : '策略已更新，版本已递增。');
      await refresh();
    } catch (error) {
      notify('error', errorMessage(error, '策略保存失败。'));
    } finally {
      setBusyPolicy(null);
    }
  }

  async function togglePolicy(policy: Policy) {
    const version = Number(policy.version);
    if (!Number.isSafeInteger(version)) return notify('error', '策略版本缺失，请刷新后再试。');
    setBusyPolicy(policy.id);
    try {
      await request(config, `${API_PATHS.policies}/${encodeURIComponent(policy.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ version, enabled: policy.enabled !== true }),
      });
      notify('success', `策略已${policy.enabled === true ? '停用' : '启用'}。`);
      await refresh();
    } catch (error) {
      notify('error', errorMessage(error, '策略状态更新失败。'));
    } finally {
      setBusyPolicy(null);
    }
  }

  async function assignPolicy(policy: Policy, deviceId: string) {
    if (!deviceId) {
      notify('error', '请先选择要绑定的设备。');
      return;
    }
    setBusyPolicy(policy.id);
    try {
      await request(config, `${API_PATHS.policies}/${encodeURIComponent(policy.id)}/assign`, {
        method: 'POST',
        body: JSON.stringify({ device_id: deviceId }),
      });
      notify('success', `策略“${policy.name}”已绑定到设备，正在确认最新版本。`);
      await refresh();
    } catch (error) {
      notify('error', errorMessage(error, '策略绑定失败。'));
    } finally {
      setBusyPolicy(null);
    }
  }

  if (!ready) return <div className="boot-screen"><LoaderCircle size={20} className="spin" /> 正在载入控制台…</div>;
  if (!authenticated) return <AuthScreen
    mode={authMode}
    setMode={setAuthMode}
    email={email}
    setEmail={setEmail}
    password={password}
    setPassword={setPassword}
    baseUrl={baseDraft}
    setBaseUrl={setBaseDraft}
    busy={authBusy}
    notice={notice}
    onSubmit={authenticate}
    onSettings={() => setShowSettings(true)}
    showSettings={showSettings}
    onSaveBase={saveBaseUrl}
    onCloseSettings={() => setShowSettings(false)}
  />;

  const loaded = dataStatus === 'ready';
  const navTo = (next: View) => {
    setView(next);
    setMobileNav(false);
  };

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <a className="brand" href="#overview" onClick={() => navTo('overview')}>
        <span className="brand-mark"><ShieldCheck size={19} strokeWidth={2.4} /></span>
        <span className="brand-copy"><b>focusguard</b><small>DEVICE CONTROL</small></span>
      </a>
      <div className="workspace-switch"><span className="workspace-avatar">{initials(userLabel)}</span><span><b>工作区</b><small>{userLabel || '已登录用户'}</small></span><ChevronDown size={15} /></div>
      <div className="workspace-label">CONTROL PLANE</div>
      <nav className="side-nav" aria-label="主导航">
        <button className={view === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => navTo('overview')}><LayoutDashboard size={17} /><span>总览</span><span className="nav-key">01</span></button>
        <button className={view === 'devices' ? 'nav-item active' : 'nav-item'} onClick={() => navTo('devices')}><Smartphone size={17} /><span>设备</span><span className="nav-count">{loaded ? devices.length : '—'}</span></button>
        <button className={view === 'policies' ? 'nav-item active' : 'nav-item'} onClick={() => navTo('policies')}><Shield size={17} /><span>策略</span><span className="nav-count">{loaded ? policies.length : '—'}</span></button>
      </nav>
      <div className="sidebar-bottom">
        <div className={`connection-card ${dataStatus === 'error' ? 'connection-error' : ''}`}>
          <span className={`connection-dot ${loaded ? 'connected' : dataStatus === 'loading' ? 'pending' : ''}`} />
          <div><b>{loaded ? 'API 数据已同步' : dataStatus === 'loading' ? '正在读取 API' : '等待 API 数据'}</b><small title={config.baseUrl}>{config.baseUrl || '未配置地址'}</small></div>
          <button className="icon-button tiny dark" title="API 设置" onClick={() => { setBaseDraft(config.baseUrl); setShowSettings(true); }}><Settings2 size={15} /></button>
        </div>
        <button className="profile-row" onClick={() => void logout()}><span className="avatar">{initials(userLabel)}</span><span className="profile-meta"><b>{userLabel || '已登录用户'}</b><small>退出登录</small></span><LogOut size={16} className="profile-out" /></button>
      </div>
    </aside>
    {mobileNav && <button className="mobile-scrim" aria-label="关闭菜单" onClick={() => setMobileNav(false)} />}
    <main className="main-panel">
      <header className="topbar">
        <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setMobileNav(true)}><Menu size={19} /></button>
        <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><b>{viewLabel(view)}</b></div>
        <div className="top-actions"><span className="live-status"><span /> {loaded ? 'LIVE' : 'SYNCING'}</span><button className="icon-button" title="刷新设备、策略与 usage" onClick={() => void refresh()} disabled={loading}>{loading ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}</button><span className="top-avatar">{initials(userLabel)}</span></div>
      </header>
      {notice && <div className={`toast ${notice.kind}`} role="status"><span className="toast-icon">{notice.kind === 'error' ? <AlertCircle size={17} /> : notice.kind === 'success' ? <Check size={17} /> : <Activity size={17} />}</span><span>{notice.text}</span><button className="toast-close" onClick={() => setNotice(null)} aria-label="关闭"><X size={15} /></button></div>}
      <div className="content-area">
        {view === 'overview' && <Overview devices={devices} policies={policies} onlineCount={onlineCount} status={dataStatus} loading={loading} dataError={dataError} partialErrors={partialErrors} usage={usage} commands={commands} commandForDevice={commandForDevice} onViewDevices={() => navTo('devices')} onViewPolicies={() => navTo('policies')} onRefresh={() => void refresh()} onSelect={setSelected} onCommand={sendDeviceCommand} busyCommands={busyCommands} />}
        {view === 'devices' && <DevicesView devices={filteredDevices} total={devices.length} search={search} setSearch={setSearch} status={dataStatus} loading={loading} dataError={dataError} onRefresh={() => void refresh()} onSelect={setSelected} onCommand={sendDeviceCommand} busyCommands={busyCommands} commandForDevice={commandForDevice} />}
        {view === 'policies' && <PoliciesView policies={policies} devices={devices} status={dataStatus} loading={loading} dataError={dataError} busyPolicy={busyPolicy} onCreate={() => setPolicyEditor({ mode: 'create' })} onEdit={(policy) => setPolicyEditor({ mode: 'edit', policy })} onToggle={togglePolicy} onAssign={assignPolicy} onRefresh={() => void refresh()} />}
      </div>
      <footer className="footer"><span>FOCUSGUARD CONTROL PLANE <i>·</i> v0.2.0</span><span><CircleHelp size={13} /> {sessionBusy ? '正在验证会话' : `API ${config.baseUrl}`}</span></footer>
    </main>
    {currentDevice && <DeviceDrawer device={currentDevice} commands={commandsForDevice(currentDevice.id)} onClose={() => setSelected(null)} onCommand={sendDeviceCommand} busyCommands={busyCommands} onUnbind={() => setUnbindDevice(currentDevice)} />}
    {unbindDevice && <UnbindDialog device={unbindDevice} onClose={() => setUnbindDevice(null)} onConfirm={() => confirmUnbind(unbindDevice)} />}
    {policyEditor && <PolicyEditorModal editor={policyEditor} busy={busyPolicy === (policyEditor.policy?.id || 'new')} devices={devices} onClose={() => setPolicyEditor(null)} onSubmit={(values) => void savePolicy(values, policyEditor)} />}
    {showSettings && <SettingsModal value={baseDraft} setValue={setBaseDraft} onClose={() => setShowSettings(false)} onSubmit={saveBaseUrl} />}
  </div>;
}

function viewLabel(view: View) {
  return view === 'overview' ? '总览' : view === 'devices' ? '设备' : '策略';
}

function AuthScreen(props: {
  mode: AuthMode;
  setMode: (mode: AuthMode) => void;
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  busy: boolean;
  notice: Notice | null;
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
  onSettings: () => void;
  showSettings: boolean;
  onSaveBase: (event: SyntheticEvent<HTMLFormElement>) => void;
  onCloseSettings: () => void;
}) {
  return <div className="auth-shell">
    <section className="auth-aside">
      <a className="brand auth-brand" href="#"><span className="brand-mark"><ShieldCheck size={19} strokeWidth={2.4} /></span><span className="brand-copy"><b>focusguard</b><small>DEVICE CONTROL</small></span></a>
      <div className="auth-visual"><div className="visual-grid" /><div className="visual-core"><Shield size={65} strokeWidth={1.2} /><span><Check size={15} /></span></div><div className="visual-stat stat-one"><Wifi size={14} /> fleet <b>API</b></div><div className="visual-stat stat-two"><Activity size={14} /> commands <b>live</b></div></div>
      <div className="auth-aside-copy"><div className="eyebrow"><span /> DEVICE OPERATIONS PLATFORM</div><h1>把每一台设备<br /><em>放在掌控之中。</em></h1><p>集中查看设备心跳、usage、策略与远程命令。所有数据均来自你配置的 API。</p></div>
      <div className="auth-aside-foot">SECURE CONTROL PLANE <span>·</span> REAL API DATA</div>
    </section>
    <section className="auth-main"><div className="auth-main-top"><span>CONTROL PLANE / ACCESS</span><button className="icon-button" title="配置 API 地址" onClick={props.onSettings}><Settings2 size={17} /></button></div>
      <div className="auth-card"><div className="auth-icon"><LockKeyhole size={21} /></div><div className="eyebrow auth-eyebrow">{props.mode === 'login' ? 'WELCOME BACK' : 'NEW WORKSPACE'}</div><h2>{props.mode === 'login' ? '登录控制台' : '创建工作区账户'}</h2><p className="auth-subtitle">{props.mode === 'login' ? '输入凭据以访问你的设备控制台。' : '创建账户后连接已部署的控制服务。'}</p>
        {props.notice && <div className={`auth-notice ${props.notice.kind}`}><AlertCircle size={16} />{props.notice.text}</div>}
        <form className="auth-form" onSubmit={props.onSubmit}><label>邮箱地址<input type="email" autoComplete="email" placeholder="name@company.com" required value={props.email} onChange={(event) => props.setEmail(event.target.value)} /></label><label>密码<input type="password" autoComplete={props.mode === 'login' ? 'current-password' : 'new-password'} placeholder="至少 8 位字符" minLength={8} required value={props.password} onChange={(event) => props.setPassword(event.target.value)} /></label><button className="primary-button auth-submit" disabled={props.busy}>{props.busy ? <LoaderCircle size={17} className="spin" /> : <>{props.mode === 'login' ? '登录' : '创建账户'} <ArrowRight size={16} /></>}</button></form>
        <div className="auth-switch">{props.mode === 'login' ? '还没有账户？' : '已有账户？'}<button onClick={() => props.setMode(props.mode === 'login' ? 'register' : 'login')}>{props.mode === 'login' ? '注册' : '返回登录'}</button></div>
        <div className="auth-api"><span className={`api-indicator ${props.baseUrl ? 'configured' : ''}`} /><div><b>API ENDPOINT</b><small title={props.baseUrl}>{props.baseUrl || '尚未配置 API 地址'}</small></div><button className="text-button" onClick={props.onSettings}>设置</button></div>
      </div><div className="auth-legal">请求将发送至你配置的 HTTP/HTTPS API 服务。</div></section>
    {props.showSettings && <SettingsModal value={props.baseUrl} setValue={props.setBaseUrl} onClose={props.onCloseSettings} onSubmit={props.onSaveBase} />}
  </div>;
}

function Overview(props: {
  devices: Device[];
  policies: Policy[];
  onlineCount: number;
  status: DataStatus;
  loading: boolean;
  dataError: string;
  partialErrors: string[];
  usage: UsageRecord[];
  commands: Record<string, CommandState>;
  commandForDevice: (deviceId: string) => CommandState | undefined;
  onViewDevices: () => void;
  onViewPolicies: () => void;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onCommand: (device: Device, command: CommandKind) => void;
  busyCommands: Record<string, boolean>;
}) {
  const offline = Math.max(props.devices.length - props.onlineCount, 0);
  const usageSeconds = props.devices.reduce((total, device) => total + durationForDevice(props.usage, device.id), 0);
  const commandList = Object.values(props.commands);
  const commandCounts = commandList.reduce<Record<string, number>>((counts, command) => {
    const key = command.status.toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const onlineRate = props.devices.length ? Math.round((props.onlineCount / props.devices.length) * 100) : 0;
  const usageByDevice = props.devices.map((device) => ({
    device,
    seconds: durationForDevice(props.usage, device.id),
  })).sort((a, b) => b.seconds - a.seconds).slice(0, 4);
  return <>
    <PageHeading eyebrow="OVERVIEW" title="设备总览" description="实时查看在线率、使用时长与命令活动。" action={<button className="secondary-button" onClick={props.onRefresh} disabled={props.loading}>{props.loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={15} />} 刷新数据</button>} />
    {props.dataError && <ErrorBanner message={props.dataError} onRetry={props.onRefresh} />}
    {props.partialErrors.length > 0 && !props.dataError && <div className="partial-banner"><AlertCircle size={16} /><span>{props.partialErrors.length} 项可选数据读取失败，设备与策略仍来自 API。</span><button onClick={props.onRefresh}>重试</button></div>}
    <div className="metric-grid overview-metrics">
      <Metric icon={<Wifi size={17} />} label="在线率" value={props.status === 'ready' ? `${onlineRate}%` : '—'} note={props.status === 'ready' ? `${props.onlineCount} 在线 · ${offline} 离线` : loadingLabel(props.status)} tone="mint" progress={props.status === 'ready' ? onlineRate : undefined} />
      <Metric icon={<Laptop size={17} />} label="设备总数" value={props.status === 'ready' ? String(props.devices.length) : '—'} note={props.status === 'ready' ? 'API 返回设备' : loadingLabel(props.status)} tone="blue" />
      <Metric icon={<Clock3 size={17} />} label="使用时长" value={props.status === 'ready' ? formatDuration(usageSeconds) : '—'} note={props.status === 'ready' ? '已读取 /usage' : loadingLabel(props.status)} tone="amber" />
      <Metric icon={<Terminal size={17} />} label="命令活动" value={props.status === 'ready' ? String(commandList.length) : '—'} note={props.status === 'ready' ? `${commandCounts.pending || 0} 条等待回执` : loadingLabel(props.status)} tone="rose" />
    </div>
    <div className="section-heading"><div><h2>设备状态</h2><span className="section-caption">DEVICE FLEET <i>·</i> {props.status === 'ready' ? `${props.devices.length} TOTAL` : 'NO DATA'}</span></div><button className="link-button" onClick={props.onViewDevices}>查看全部 <ArrowRight size={15} /></button></div>
    <section className="panel fleet-panel"><div className="panel-head"><div><b>设备活动</b><span>在线、最近心跳、策略与最后一条命令</span></div><span className={`data-pill ${props.status === 'ready' ? 'is-live' : ''}`}><span />{props.status === 'ready' ? 'API DATA' : props.status === 'loading' ? 'LOADING' : 'NOT LOADED'}</span></div>
      {props.status !== 'ready' || props.devices.length === 0 ? <DataState status={props.status} kind="device" onAction={props.status === 'ready' ? props.onViewDevices : props.onRefresh} /> : <div className="device-list">{props.devices.slice(0, 5).map((device) => <DeviceRow key={device.id} device={device} command={props.commandForDevice(device.id)} onSelect={props.onSelect} onCommand={props.onCommand} busyCommands={props.busyCommands} />)}</div>}
    </section>
    <div className="lower-grid">
      <section><div className="section-heading compact"><div><h2>使用时长</h2><span className="section-caption">USAGE BY DEVICE</span></div></div><div className="panel usage-panel">{props.status !== 'ready' ? <DataState status={props.status} kind="usage" onAction={props.onRefresh} /> : usageByDevice.length === 0 ? <DataState status="ready" kind="usage" onAction={props.onRefresh} /> : usageByDevice.map(({ device, seconds }) => <UsageBar key={device.id} device={device} seconds={seconds} max={usageByDevice[0]?.seconds || 1} />)}</div></section>
      <section><div className="section-heading compact"><div><h2>命令活动</h2><span className="section-caption">SERVER ACK STATUS</span></div><span className="mini-live"><span /> API</span></div><div className="panel command-summary"><div className="command-summary-total"><span className="summary-icon"><Sparkles size={17} /></span><div><strong>{props.status === 'ready' ? commandList.length : '—'}</strong><small>已记录命令</small></div></div><div className="command-status-grid">{(['pending', 'delivered', 'executed', 'failed', 'expired'] as const).map((status) => <div key={status}><StatusBadge status={status} /><b>{props.status === 'ready' ? commandCounts[status] || 0 : '—'}</b></div>)}</div></div></section>
    </div>
    <div className="section-heading compact"><div><h2>策略概览</h2><span className="section-caption">POLICY STATUS</span></div><button className="link-button" onClick={props.onViewPolicies}>管理策略 <ArrowRight size={15} /></button></div>
    <div className="panel policy-overview">{props.status !== 'ready' || props.policies.length === 0 ? <DataState status={props.status} kind="policy" onAction={props.onViewPolicies} /> : props.policies.slice(0, 4).map((policy) => <PolicySummary key={policy.id} policy={policy} />)}</div>
  </>;
}

function loadingLabel(status: DataStatus) {
  return status === 'loading' ? '正在读取 API' : status === 'error' ? '读取失败' : '等待 API 数据';
}

function PageHeading(props: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow"><span className="heading-mark" /> {props.eyebrow}</div><h1>{props.title}</h1><p>{props.description}</p></div>{props.action}</div>;
}

function Metric(props: { icon: ReactNode; label: string; value: string; note: string; tone: string; progress?: number }) {
  return <div className="metric"><div className={`metric-icon ${props.tone}`}>{props.icon}</div><span className="metric-label">{props.label}</span><strong>{props.value}</strong><small>{props.note}</small>{props.progress !== undefined && <span className="metric-progress"><i style={{ width: `${props.progress}%` }} /></span>}</div>;
}

function ErrorBanner(props: { message: string; onRetry: () => void }) {
  return <div className="error-banner"><AlertCircle size={18} /><div><b>API 数据读取失败</b><span>{props.message}</span></div><button onClick={props.onRetry}>重试</button></div>;
}

function DataState(props: { status: DataStatus; kind: 'device' | 'policy' | 'usage'; onAction: () => void }) {
  const labels = {
    device: ['设备', '接入设备后会显示在这里。'],
    policy: ['策略', '创建第一条策略以开始绑定设备。'],
    usage: ['usage', '设备上报 usage 后会显示真实时长。'],
  }[props.kind];
  const loading = props.status === 'loading';
  const error = props.status === 'error';
  return <div className="empty-state"><span className="empty-icon">{loading ? <LoaderCircle size={20} className="spin" /> : error ? <AlertCircle size={20} /> : props.kind === 'policy' ? <Shield size={20} /> : props.kind === 'usage' ? <Clock3 size={20} /> : <Smartphone size={20} />}</span><b>{loading ? '正在从 API 加载…' : error ? '无法读取真实数据' : props.status === 'ready' ? `还没有${labels[0]}` : '尚无 API 数据'}</b><span>{loading ? '数据返回后会显示在这里。' : error ? '请检查连接后重试，当前没有可用的成功状态。' : props.status === 'ready' ? labels[1] : '登录并连接 API 后才会显示数据。'}</span><button className="empty-action" onClick={props.onAction}>{error || loading || props.status !== 'ready' ? <><RefreshCw size={14} /> 重试</> : props.kind === 'policy' ? <><Plus size={14} /> 创建策略</> : <><ArrowRight size={14} /> 查看详情</>}</button></div>;
}

function DeviceRow(props: { device: Device; command?: CommandState; onSelect: (id: string) => void; onCommand: (device: Device, command: CommandKind) => void; busyCommands: Record<string, boolean> }) {
  const online = isOnline(props.device.status);
  const operation = `${props.device.id}:sync`;
  return <div className="device-row"><button className="device-identity" onClick={() => props.onSelect(props.device.id)}><span className={`device-icon ${online ? 'online' : ''}`}>{deviceIcon(props.device.platform)}</span><span className="device-name"><b>{props.device.name || props.device.id}</b><small>{props.device.platform || '平台未知'} · {props.device.id}</small></span></button><div className="device-connection"><StatusBadge status={online ? 'online' : 'offline'} /><small title={props.device.lastSeen}>{relativeTime(props.device.lastSeen)}</small></div><div className="device-policy"><b>{props.device.policyId ? `v${props.device.policyVersion ?? '—'}` : '未绑定'}</b><small>{props.device.policyId || '暂无策略'}</small></div><div className="device-command-status" title={props.command?.error || undefined}>{props.command ? <><StatusBadge status={props.command.status} /><small>{commandLabel(props.command.kind)}</small></> : <small>暂无命令</small>}</div><button className="row-action" onClick={() => props.onCommand(props.device, 'sync')} disabled={Boolean(props.busyCommands[operation])} title="立即同步">{props.busyCommands[operation] ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</button><button className="row-more" onClick={() => props.onSelect(props.device.id)} title="设备详情"><ArrowRight size={15} /></button></div>;
}

function StatusBadge({ status }: { status?: string }) {
  const tone = statusTone(status);
  const label = status === 'online' || status === 'offline' ? (status === 'online' ? '在线' : '离线') : statusLabel(status);
  return <span className={`status-badge ${tone}`}><i />{label}</span>;
}

function UsageBar(props: { device: Device; seconds: number; max: number }) {
  const ratio = Math.min(100, Math.round((props.seconds / props.max) * 100));
  return <div className="usage-row"><div className="usage-label"><span className="device-icon mini">{deviceIcon(props.device.platform)}</span><span><b>{props.device.name}</b><small>{props.device.id}</small></span><strong>{formatDuration(props.seconds)}</strong></div><div className="usage-track"><i style={{ width: `${ratio}%` }} /></div></div>;
}

function PolicySummary({ policy }: { policy: Policy }) {
  return <div className="policy-summary"><span className={`policy-icon ${policy.enabled ? 'enabled' : ''}`}><Shield size={16} /></span><span className="policy-summary-copy"><b>{policy.name}</b><small>{policy.description || '未添加描述'} · v{policy.version ?? '—'}</small></span><span className={`policy-state ${policy.enabled ? 'enabled' : ''}`}><span />{policy.enabled ? '已启用' : '已停用'}</span></div>;
}

function DevicesView(props: {
  devices: Device[];
  total: number;
  search: string;
  setSearch: (value: string) => void;
  status: DataStatus;
  loading: boolean;
  dataError: string;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onCommand: (device: Device, command: CommandKind) => void;
  busyCommands: Record<string, boolean>;
  commandForDevice: (deviceId: string) => CommandState | undefined;
}) {
  return <><PageHeading eyebrow="FLEET MANAGEMENT" title="设备" description="查看在线状态、最近心跳、策略版本与远程命令。" action={<div className="heading-actions"><button className="secondary-button" onClick={props.onRefresh} disabled={props.loading}>{props.loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} 刷新</button></div>} />
    {props.dataError && <ErrorBanner message={props.dataError} onRetry={props.onRefresh} />}
    <div className="toolbar"><div className="search-field"><Search size={16} /><input aria-label="搜索设备" placeholder="搜索名称、设备 ID、状态或策略" value={props.search} onChange={(event) => props.setSearch(event.target.value)} /></div><div className="toolbar-meta"><span>{props.status === 'ready' ? `${props.devices.length} / ${props.total} 台设备` : loadingLabel(props.status)}</span></div></div>
    <section className="panel table-panel"><div className="table-head"><span>设备</span><span>连接</span><span>策略</span><span>最近命令</span><span>操作</span></div>{props.status !== 'ready' || props.devices.length === 0 ? <DataState status={props.status} kind="device" onAction={props.onRefresh} /> : <div className="device-list">{props.devices.map((device) => <DeviceRow key={device.id} device={device} command={props.commandForDevice(device.id)} onSelect={props.onSelect} onCommand={props.onCommand} busyCommands={props.busyCommands} />)}</div>}</section>
  </>;
}

function PoliciesView(props: {
  policies: Policy[];
  devices: Device[];
  status: DataStatus;
  loading: boolean;
  dataError: string;
  busyPolicy: string | null;
  onCreate: () => void;
  onEdit: (policy: Policy) => void;
  onToggle: (policy: Policy) => void;
  onAssign: (policy: Policy, deviceId: string) => void;
  onRefresh: () => void;
}) {
  return <><PageHeading eyebrow="POLICY ENGINE" title="策略" description="用常用限制或规则 JSON 定义策略，并绑定到具体设备。" action={<button className="primary-button" onClick={props.onCreate}><Plus size={16} /> 新建策略</button>} />
    {props.dataError && <ErrorBanner message={props.dataError} onRetry={props.onRefresh} />}
    {props.status !== 'ready' || props.policies.length === 0 ? <div className="panel policies-empty"><DataState status={props.status} kind="policy" onAction={props.onCreate} /></div> : <div className="policies-grid">{props.policies.map((policy) => <PolicyCard key={policy.id} policy={policy} devices={props.devices} busy={props.busyPolicy === policy.id} onEdit={() => props.onEdit(policy)} onToggle={() => props.onToggle(policy)} onAssign={(deviceId) => props.onAssign(policy, deviceId)} />)}</div>}
  </>;
}

function PolicyCard(props: { policy: Policy; devices: Device[]; busy: boolean; onEdit: () => void; onToggle: () => void; onAssign: (deviceId: string) => void }) {
  const [target, setTarget] = useState(props.policy.deviceId || '');
  const rules = safeObject(props.policy.rules);
  const limits = safeObject(rules.limits);
  const bound = props.devices.filter((device) => device.policyId === props.policy.id);
  return <article className="policy-card"><div className="policy-card-top"><span className={`policy-icon large ${props.policy.enabled ? 'enabled' : ''}`}><Shield size={19} /></span><span className={`policy-state ${props.policy.enabled ? 'enabled' : ''}`}><span />{props.policy.enabled ? '已启用' : '已停用'}</span><button className="icon-button policy-menu" title="编辑策略" onClick={props.onEdit}><Pencil size={15} /></button></div><div className="policy-title-row"><div><h3>{props.policy.name}</h3><p>{props.policy.description || '暂无策略说明。'}</p></div><span className="policy-version">v{props.policy.version ?? '—'}</span></div><div className="rule-chips">{typeof limits.screen_time_minutes === 'number' && <span>屏幕时长 {limits.screen_time_minutes} 分钟</span>}{typeof limits.downtime_start === 'string' && <span>停用 {limits.downtime_start}{typeof limits.downtime_end === 'string' ? `–${limits.downtime_end}` : ''}</span>}{limits.block_camera === true && <span>阻止相机</span>}{Object.keys(limits).length === 0 && <span>自定义规则 JSON</span>}</div><div className="policy-card-meta"><span><Smartphone size={14} />{bound.length || props.policy.deviceCount || 0} 台绑定设备</span><span className="policy-id">ID {props.policy.id}</span></div><div className="assign-row"><select aria-label={`为${props.policy.name}选择设备`} value={target} onChange={(event) => setTarget(event.target.value)}><option value="">选择设备绑定</option>{props.devices.map((device) => <option key={device.id} value={device.id}>{device.name || device.id}</option>)}</select><button className="assign-button" title="绑定策略" onClick={() => props.onAssign(target)} disabled={props.busy || !target}>{props.busy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}</button></div><div className="policy-actions"><button className="text-button" onClick={props.onEdit}><Code2 size={14} /> 查看规则 JSON</button><button className="policy-toggle" onClick={props.onToggle} disabled={props.busy}>{props.busy ? <LoaderCircle size={14} className="spin" /> : props.policy.enabled ? '停用策略' : '启用策略'}<ArrowRight size={14} /></button></div></article>;
}

function DeviceDrawer(props: { onUnbind: () => void; device: Device; commands: CommandState[]; onClose: () => void; onCommand: (device: Device, command: CommandKind) => void; busyCommands: Record<string, boolean> }) {
  const online = isOnline(props.device.status);
  return <div className="drawer-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}><aside className="device-drawer"><div className="drawer-top"><span>DEVICE DETAILS</span><button className="icon-button" onClick={props.onClose} aria-label="关闭"><X size={18} /></button></div><div className="drawer-device"><span className={`device-icon big ${online ? 'online' : ''}`}>{deviceIcon(props.device.platform)}</span><div><h2>{props.device.name || props.device.id}</h2><span className="mono">{props.device.id}</span></div><StatusBadge status={online ? 'online' : 'offline'} /></div><div className="drawer-details"><div><span>平台</span><b>{props.device.platform || 'API 未提供'}</b></div><div><span>应用版本</span><b>{props.device.appVersion || 'API 未提供'}</b></div><div><span>最近心跳</span><b title={props.device.lastSeen}>{relativeTime(props.device.lastSeen)}</b><small>{formatDate(props.device.lastSeen)}</small></div><div><span>策略绑定</span><b>{props.device.policyId ? `v${props.device.policyVersion ?? '—'}` : '未分配'}</b><small>{props.device.policyId || '暂无策略 ID'}</small></div></div><div className="drawer-section"><div className="drawer-section-head"><b>远程控制</b><span>每个操作都会创建真实命令并轮询回执</span></div><div className="drawer-actions"><CommandAction icon={<RefreshCw size={16} />} label="立即同步" hint="请求设备立即上报状态" command="sync" device={props.device} onCommand={props.onCommand} busy={props.busyCommands[`${props.device.id}:sync`]} /><CommandAction icon={<LockKeyhole size={16} />} label="远程锁定" hint="向设备发送锁定命令" command="lock" device={props.device} onCommand={props.onCommand} busy={props.busyCommands[`${props.device.id}:lock`]} danger /><CommandAction icon={<LockKeyhole size={16} />} label="解除限制" hint="向设备发送解除命令" command="unlock" device={props.device} onCommand={props.onCommand} busy={props.busyCommands[`${props.device.id}:unlock`]} /></div></div><div className="drawer-section command-history"><div className="drawer-section-head"><b>命令状态</b><span>{props.commands.length} 条服务器记录</span></div>{props.commands.length === 0 ? <div className="drawer-empty">API 尚未返回该设备的命令记录。</div> : <div className="command-timeline">{props.commands.slice(0, 8).map((command) => <div className="command-item" key={command.id}><span className={`timeline-dot ${statusTone(command.status)}`} /><div><div className="command-item-head"><b>{commandLabel(command.kind)}</b><StatusBadge status={command.status} /></div><small>{formatDate(command.updatedAt || command.createdAt)} · ID {command.id}</small>{command.error && <p>{command.error}</p>}</div></div>)}</div>}</div><div className="drawer-note"><AlertCircle size={15} />命令状态只在 API 返回 pending、delivered、executed、failed 或 expired 后更新。</div><div className="drawer-section unbind-section"><div><b>移除此设备</b><p>停止同步与远程控制。</p></div><button type="button" className="danger-button" onClick={props.onUnbind}>解绑设备</button></div></aside></div>;
}

function UnbindDialog(props: { device: Device; onClose: () => void; onConfirm: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);
  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try { await props.onConfirm(); }
    catch (cause) { setError(errorMessage(cause, '暂未收到解绑结果，请刷新设备列表核对。')); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="modal unbind-dialog" aria-labelledby="unbind-title" onCancel={(event) => { event.preventDefault(); if (!inFlight.current) props.onClose(); }}>
    <h2 id="unbind-title">解绑 {props.device.name || props.device.id}？</h2>
    <p>旧凭证会立即失效，未完成的命令将过期。已解绑设备不会自动重新注册；服务器历史记录和策略本身不会删除。</p>
    {error && <p role="alert" className="unbind-error">{error}</p>}
    <div className="unbind-actions"><button type="button" autoFocus className="secondary-button" disabled={busy} onClick={props.onClose}>取消</button><button type="button" className="danger-button" disabled={busy} onClick={() => void confirm()}>{busy ? '正在解绑…' : '确认解绑'}</button></div>
  </dialog>;
}

function CommandAction(props: { icon: ReactNode; label: string; hint: string; command: CommandKind; device: Device; onCommand: (device: Device, command: CommandKind) => void; busy?: boolean; danger?: boolean }) {
  return <button className={`command-action ${props.danger ? 'danger' : ''}`} onClick={() => props.onCommand(props.device, props.command)} disabled={props.busy}><span className="command-action-icon">{props.busy ? <LoaderCircle size={16} className="spin" /> : props.icon}</span><span><b>{props.label}</b><small>{props.hint}</small></span><ArrowRight size={15} /></button>;
}

function PolicyEditorModal(props: { editor: PolicyEditorState; devices: Device[]; busy: boolean; onClose: () => void; onSubmit: (values: PolicyFormValues) => void }) {
  const policy = props.editor.policy;
  const existingRules = safeObject(policy?.rules);
  const existingLimits = safeObject(existingRules.limits);
  const [name, setName] = useState(policy?.name || '');
  const [description, setDescription] = useState(policy?.description || '');
  const [rules, setRules] = useState(prettyRules(policy?.rules || { enabled: true, limits: {} }));
  const [enabled, setEnabled] = useState(policy?.enabled !== false);
  const [deviceId, setDeviceId] = useState(policy?.deviceId || '');
  const [screenTime, setScreenTime] = useState(typeof existingLimits.screen_time_minutes === 'number' ? String(existingLimits.screen_time_minutes) : '');
  const [downtimeStart, setDowntimeStart] = useState(typeof existingLimits.downtime_start === 'string' ? existingLimits.downtime_start : '');
  const [downtimeEnd, setDowntimeEnd] = useState(typeof existingLimits.downtime_end === 'string' ? existingLimits.downtime_end : '');
  const [blockCamera, setBlockCamera] = useState(existingLimits.block_camera === true);
  const [jsonError, setJsonError] = useState('');

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const parsed = JSON.parse(rules) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('规则 JSON 必须是对象。');
      setJsonError('');
      const next = safeObject(parsed);
      const limits = safeObject(next.limits);
      if (screenTime.trim()) {
        const minutes = Number(screenTime);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('每日屏幕时长必须是 1–1440 的整数。');
        limits.screen_time_minutes = minutes;
      } else delete limits.screen_time_minutes;
      if (downtimeStart) limits.downtime_start = downtimeStart; else delete limits.downtime_start;
      if (downtimeEnd) limits.downtime_end = downtimeEnd; else delete limits.downtime_end;
      if (blockCamera) limits.block_camera = true; else delete limits.block_camera;
      next.enabled = enabled;
      if (Object.keys(limits).length) next.limits = limits; else delete next.limits;
      props.onSubmit({ name, description, rules: JSON.stringify(next), enabled, deviceId });
    } catch (error) {
      setJsonError(errorMessage(error, '规则 JSON 无效。'));
    }
  }

  return <Modal title={props.editor.mode === 'create' ? '新建策略' : '编辑策略'} subtitle={props.editor.mode === 'create' ? '保存后由 API 创建版本 1 的策略。' : `编辑当前版本 v${policy?.version ?? '—'}；保存会触发服务端版本递增。`} onClose={props.onClose} wide><form className="policy-editor" onSubmit={submit}><div className="editor-grid"><label>策略名称<input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：工作时段限制" /></label><label>说明<input maxLength={300} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述该策略的用途" /></label></div><div className="editor-section"><div className="editor-section-head"><div><b>常用限制</b><span>快速配置会写入规则 JSON 的 limits 对象。</span></div><label className="switch-row"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>{enabled ? '启用' : '停用'}</span></label></div><div className="quick-limits"><label>每日屏幕时长（分钟）<input type="number" min="1" max="1440" value={screenTime} onChange={(event) => setScreenTime(event.target.value)} placeholder="不限制" /></label><label>停用开始<input type="time" value={downtimeStart} onChange={(event) => setDowntimeStart(event.target.value)} /></label><label>停用结束<input type="time" value={downtimeEnd} onChange={(event) => setDowntimeEnd(event.target.value)} /></label><label className="check-control"><input type="checkbox" checked={blockCamera} onChange={(event) => setBlockCamera(event.target.checked)} /><span>阻止相机</span></label></div></div><label className="json-field"><span>规则 JSON <small>必须是顶层对象，后端会按原文保存。</small></span><textarea rows={12} value={rules} onChange={(event) => { setRules(event.target.value); setJsonError(''); }} spellCheck={false} className={jsonError ? 'invalid' : ''} />{jsonError && <em>{jsonError}</em>}</label><label>设备绑定（可选）<select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><option value="">暂不绑定</option>{props.devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.id}</option>)}</select></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={props.onClose}>取消</button><button className="primary-button" disabled={props.busy}>{props.busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} {props.editor.mode === 'create' ? '创建策略' : '保存版本'}</button></div></form></Modal>;
}

function SettingsModal(props: { value: string; setValue: (value: string) => void; onClose: () => void; onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void }) {
  return <Modal title="API 连接设置" subtitle="输入控制服务的 HTTP 或 HTTPS Base URL。" onClose={props.onClose}><form className="modal-form" onSubmit={props.onSubmit}><label>API Base URL<input autoFocus type="text" required placeholder="https://api.example.com" value={props.value} onChange={(event) => props.setValue(event.target.value)} /><small>支持 origin、/api、/v1 或 /api/v1；控制台会避免重复拼接路径。</small></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={props.onClose}>取消</button><button className="primary-button"><Check size={16} /> 保存地址</button></div></form></Modal>;
}

function Modal(props: { title: string; subtitle: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}><section className={`modal ${props.wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title}><div className="modal-heading"><span className="modal-icon"><CommandIcon /></span><button className="icon-button" onClick={props.onClose} aria-label="关闭"><X size={17} /></button></div><h2>{props.title}</h2><p>{props.subtitle}</p>{props.children}</section></div>;
}

function CommandIcon() {
  return <Settings2 size={18} />;
}
