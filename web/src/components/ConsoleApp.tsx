import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, SubmitEvent } from 'react';
import {
  Activity, AlertCircle, ArrowRight, Bell, Check,
  CircleHelp, Clock3, Command, Gauge, Laptop, LoaderCircle, LockKeyhole, LogOut,
  Menu, Plus, RefreshCw, Search, Send, Settings2, Shield, ShieldCheck, SlidersHorizontal,
  Smartphone, Sparkles, Wifi, X,
} from 'lucide-react';
import {
  API_PATHS, clearConfig, normalizeBaseUrl, normalizeCommand, normalizeDevice, normalizePolicy,
  normalizeUsage, readConfig, request, saveConfig, unwrapList,
} from '../lib/api';
import type { ApiConfig, ApiError, ApiSession, Command as ApiCommand, Device, Policy, UsageRecord } from '../lib/api';

type AuthState = 'login' | 'register';
type Notice = { kind: 'error' | 'success'; text: string };
type View = 'overview' | 'devices' | 'policies';

type CommandState = ApiCommand & { deviceId: string };

function prettyTime(value?: string) {
  if (!value) return '未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function isOnline(status: string) {
  return ['online', 'active', 'connected', '已连接', '在线'].includes(status.toLowerCase());
}

function initials(value: string) {
  return value.trim().slice(0, 1).toUpperCase() || 'F';
}

export default function ConsoleApp() {
  const [config, setConfig] = useState<ApiConfig>({ baseUrl: '', token: '' });
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [userLabel, setUserLabel] = useState('');
  const [authMode, setAuthMode] = useState<AuthState>('login');
  const [authBusy, setAuthBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [view, setView] = useState<View>('overview');
  const [devices, setDevices] = useState<Device[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [commands, setCommands] = useState<Record<string, CommandState>>({});
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [search, setSearch] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [baseDraft, setBaseDraft] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [commandBusy, setCommandBusy] = useState<string | null>(null);
  const [newPolicyOpen, setNewPolicyOpen] = useState(false);
  const [policyName, setPolicyName] = useState('');
  const [policyDescription, setPolicyDescription] = useState('');
  const [policyBusy, setPolicyBusy] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [pairingCode, setPairingCode] = useState<{ code: string; expiresIn: number } | null>(null);
  const refreshGeneration = useRef(0);
  const loggingOut = useRef(false);

  useEffect(() => {
    const current = readConfig();
    setConfig(current);
    setBaseDraft(current.baseUrl);
    setAuthenticated(Boolean(current.token && current.baseUrl));
    setReady(true);
  }, []);

  const notify = useCallback((kind: Notice['kind'], text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice((current) => current?.text === text ? null : current), 6000);
  }, []);

  const logout = useCallback(async () => {
    if (loggingOut.current) return;
    loggingOut.current = true;
    const current = config;
    try {
      if (current.baseUrl && current.token) await request(current, API_PATHS.logout, { method: 'POST' });
    } catch { /* local logout must complete even when API is unavailable */ }
    refreshGeneration.current += 1;
    clearConfig();
    setConfig({ baseUrl: '', token: '' });
    setAuthenticated(false);
    setDevices([]);
    setPolicies([]);
    setCommands({});
    setUsage([]);
    setLoaded(false);
    setUserLabel('');
    loggingOut.current = false;
  }, [config]);

  useEffect(() => {
    const handleUnauthorized = () => {
      logout();
      notify('error', '登录已过期，请重新登录。');
    };
    window.addEventListener('focusguard:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('focusguard:unauthorized', handleUnauthorized);
  }, [logout, notify]);

  useEffect(() => {
    if (!ready || !config.baseUrl || !config.token) return;
    void request<ApiSession>(config, API_PATHS.session)
      .then((session) => setUserLabel(session?.user?.name || session?.user?.display_name || session?.user?.email || userLabel))
      .catch((error: unknown) => {
        if ((error as ApiError)?.status !== 401) notify('error', error instanceof Error ? error.message : '会话校验失败。');
      });
  }, [ready, config.baseUrl, config.token, notify]);

  const refresh = useCallback(async () => {
    if (!config.baseUrl || !config.token) return;
    const generation = ++refreshGeneration.current;
    setLoading(true);
    setNotice(null);
    setLoaded(false);
    setDevices([]);
    setPolicies([]);
    setUsage([]);
    try {
      const [deviceResponse, policyResponse] = await Promise.all([
        request<unknown>(config, API_PATHS.devices),
        request<unknown>(config, API_PATHS.policies),
      ]);
      if (generation !== refreshGeneration.current) return;
      const nextDevices = unwrapList<unknown>(deviceResponse).map(normalizeDevice);
      setDevices(nextDevices);
      setPolicies(unwrapList<unknown>(policyResponse).map(normalizePolicy));
      const usageResults = await Promise.allSettled(nextDevices.map((device) => request<unknown>(config, `${API_PATHS.usage}?device_id=${encodeURIComponent(device.id)}`)));
      if (generation !== refreshGeneration.current) return;
      const nextUsage: UsageRecord[] = [];
      usageResults.forEach((result) => { if (result.status === 'fulfilled') { try { nextUsage.push(...unwrapList<unknown>(result.value).map(normalizeUsage)); } catch { /* usage is optional */ } } });
      setUsage(nextUsage);
      setLoaded(true);
    } catch (error) {
      if (generation === refreshGeneration.current) notify('error', error instanceof Error ? error.message : '读取控制台数据失败。');
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [config, notify]);

  useEffect(() => {
    if (ready && authenticated && config.baseUrl && config.token) void refresh();
  }, [ready, authenticated, config.baseUrl, config.token, refresh]);

  const onlineCount = devices.filter((device) => isOnline(device.status)).length;
  const filteredDevices = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return devices;
    return devices.filter((device) => [device.name, device.id, device.status, device.platform].some((value) => value?.toLowerCase().includes(term)));
  }, [devices, search]);
  const currentDevice = devices.find((device) => device.id === selected) || null;
  const commandForDevice = useCallback((deviceId: string) => Object.values(commands)
    .filter((command) => command.deviceId === deviceId)
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))[0], [commands]);

  async function authenticate(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    let baseUrl: string;
    try { baseUrl = normalizeBaseUrl(baseDraft); } catch (error) { return notify('error', error instanceof Error ? error.message : 'API Base URL 无效。'); }
    if (!baseUrl) return notify('error', '请填写 API Base URL。');
    setAuthBusy(true);
    const path = authMode === 'login' ? API_PATHS.login : API_PATHS.register;
    try {
      const result = await request<ApiSession>({ baseUrl, token: '' }, path, {
        method: 'POST', body: JSON.stringify({ email, password }),
      });
      const token = result?.token || result?.access_token;
      if (!token) throw new Error('认证响应中未找到 token/access_token，无法建立会话。');
      const next = { baseUrl, token };
      saveConfig(next);
      setConfig(next);
      setUserLabel(result.user?.name || result.user?.display_name || result.user?.email || email);
      setAuthenticated(true);
      setPassword('');
      notify('success', authMode === 'login' ? '登录成功。' : '注册成功。');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '认证请求失败。');
    } finally {
      setAuthBusy(false);
    }
  }

  function saveBaseUrl(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    let baseUrl: string;
    try { baseUrl = normalizeBaseUrl(baseDraft); } catch (error) { return notify('error', error instanceof Error ? error.message : 'API Base URL 无效。'); }
    if (!baseUrl) return notify('error', 'API Base URL 不能为空。');
    const next = { ...config, baseUrl };
    saveConfig(next);
    setConfig(next);
    setShowSettings(false);
    setLoaded(false);
    notify('success', 'API Base URL 已保存。');
  }


  async function createPairingCode() {
    try {
      const result = await request<{ code?: string; expires_in?: number; expiresIn?: number }>(config, API_PATHS.pairingCodes, { method: 'POST', body: JSON.stringify({}) });
      if (!result.code) throw new Error('配对码响应中没有 code。');
      setPairingCode({ code: result.code, expiresIn: result.expires_in ?? result.expiresIn ?? 600 });
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '生成配对码失败。');
    }
  }

  async function sendDeviceCommand(device: Device, command: 'sync' | 'lock' | 'unlock') {
    const busyKey = `${device.id}:${command}`;
    setCommandBusy(busyKey);
    try {
      const response = await request<unknown>(config, `${API_PATHS.devices}/${encodeURIComponent(device.id)}/commands`, {
        method: 'POST', headers: { 'Idempotency-Key': `${device.id}:${command}:${Date.now()}` }, body: JSON.stringify({ command, kind: command }),
      });
      const queued = normalizeCommand(response);
      if (!queued.id) throw new Error('命令响应中未找到 command id，无法查询执行状态。');
      const initial: CommandState = { ...queued, deviceId: device.id, status: queued.status || 'pending' };
      setCommands((current) => ({ ...current, [initial.id]: initial }));
      notify('success', `命令“${commandLabel(command)}”已发送，正在查询执行状态。`);
      void pollCommand(device.id, initial.id);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '远程命令发送失败。');
    } finally {
      setCommandBusy(null);
    }
  }

  async function pollCommand(deviceId: string, commandId: string) {
    const terminal = new Set(['completed', 'failed', 'cancelled', 'success', 'error', 'executed', 'expired']);
    const successful = new Set(['completed', 'success', 'executed']);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const result = await request<unknown>(config, `${API_PATHS.devices}/${encodeURIComponent(deviceId)}/commands/${encodeURIComponent(commandId)}`);
        const next = { ...normalizeCommand(result), deviceId };
        setCommands((current) => ({ ...current, [commandId]: next }));
        if (terminal.has(next.status.toLowerCase())) {
          notify(successful.has(next.status.toLowerCase()) ? 'success' : 'error', next.error ? `命令状态：${next.status}，${next.error}` : `命令状态：${next.status}`);
          return;
        }
      } catch (error) {
        if ((error as ApiError)?.status === 404) return;
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
  }

  async function createPolicy(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPolicyBusy(true);
    try {
      await request(config, API_PATHS.policies, {
        method: 'POST', body: JSON.stringify({ name: policyName.trim(), description: policyDescription.trim(), enabled: true }),
      });
      setNewPolicyOpen(false);
      setPolicyName('');
      setPolicyDescription('');
      notify('success', '策略已创建。');
      await refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '策略创建失败。');
    } finally {
      setPolicyBusy(false);
    }
  }

  async function togglePolicy(policy: Policy) {
    const nextEnabled = !policy.enabled;
    try {
      await request(config, `${API_PATHS.policies}/${encodeURIComponent(policy.id)}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: nextEnabled }),
      });
      notify('success', `策略已${nextEnabled ? '启用' : '停用'}。`);
      await refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '策略状态更新失败。');
    }
  }

  async function assignPolicy(policy: Policy, deviceId: string) {
    if (!deviceId) return notify('error', '请先选择要下发的设备。');
    try {
      await request(config, `${API_PATHS.policies}/${encodeURIComponent(policy.id)}/assign`, {
        method: 'POST', body: JSON.stringify({ deviceId, device_id: deviceId }),
      });
      notify('success', `策略“${policy.name}”已下发。`);
      await refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '策略下发失败。');
    }
  }

  if (!ready) return <div className="boot-screen"><LoaderCircle size={20} className="spin" /> 正在载入控制台…</div>;
  if (!authenticated) return <AuthScreen
    mode={authMode} setMode={setAuthMode} email={email} setEmail={setEmail} password={password}
    setPassword={setPassword} baseUrl={baseDraft} setBaseUrl={setBaseDraft} busy={authBusy}
    notice={notice} onSubmit={authenticate} onSettings={() => setShowSettings(true)}
    showSettings={showSettings} onSaveBase={saveBaseUrl} onCloseSettings={() => setShowSettings(false)}
  />;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <a className="brand" href="#overview" onClick={() => setView('overview')}>
        <span className="brand-mark"><ShieldCheck size={19} strokeWidth={2.4} /></span>
        <span className="brand-copy"><b>focusguard</b><small>DEVICE CONTROL</small></span>
      </a>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="side-nav" aria-label="主导航">
        <button className={view === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('overview'); setMobileNav(false); }}><Gauge size={17} /> <span>总览</span><span className="nav-key">01</span></button>
        <button className={view === 'devices' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('devices'); setMobileNav(false); }}><Smartphone size={17} /> <span>设备</span><span className="nav-count">{devices.length}</span></button>
        <button className={view === 'policies' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('policies'); setMobileNav(false); }}><SlidersHorizontal size={17} /> <span>策略</span><span className="nav-count">{policies.length}</span></button>
      </nav>
      <div className="sidebar-bottom">
        <div className="connection-card"><span className={`connection-dot ${loaded ? '' : 'pending'}`} /><div><b>{loaded ? 'API 数据已读取' : 'API 尚未验证'}</b><small title={config.baseUrl}>{config.baseUrl || '未配置地址'}</small></div><button className="icon-button tiny" title="API 设置" onClick={() => { setBaseDraft(config.baseUrl); setShowSettings(true); }}><Settings2 size={15} /></button></div>
        <button className="profile-row" onClick={logout}><span className="avatar">{initials(userLabel)}</span><span className="profile-meta"><b>{userLabel || '已登录用户'}</b><small>管理员账户</small></span><LogOut size={16} className="profile-out" /></button>
      </div>
    </aside>
    {mobileNav && <button className="mobile-scrim" aria-label="关闭菜单" onClick={() => setMobileNav(false)} />}
    <main className="main-panel">
      <header className="topbar">
        <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setMobileNav(true)}><Menu size={19} /></button>
        <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><b>{viewLabel(view)}</b></div>
        <div className="top-actions"><span className="live-status"><span /> LIVE</span><button className="icon-button" title="刷新设备与策略" onClick={() => void refresh()} disabled={loading}>{loading ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}</button><button className="icon-button" title="通知"><Bell size={17} /></button><span className="top-avatar">{initials(userLabel)}</span></div>
      </header>
      {notice && <div className={`toast ${notice.kind}`} role="status"><span className="toast-icon">{notice.kind === 'error' ? <AlertCircle size={17} /> : <Check size={17} />}</span><span>{notice.text}</span><button className="toast-close" onClick={() => setNotice(null)} aria-label="关闭"><X size={15} /></button></div>}
      <div className="content-area">
        {view === 'overview' && <Overview devices={devices} policies={policies} onlineCount={onlineCount} loaded={loaded} loading={loading} usage={usage} commands={commands} commandForDevice={commandForDevice} onViewDevices={() => setView('devices')} onViewPolicies={() => setView('policies')} onRefresh={() => void refresh()} onSelect={setSelected} onCommand={sendDeviceCommand} commandBusy={commandBusy} />}
        {view === 'devices' && <DevicesView devices={filteredDevices} total={devices.length} search={search} setSearch={setSearch} loaded={loaded} loading={loading} commands={commands} commandForDevice={commandForDevice} onRefresh={() => void refresh()} onPair={() => void createPairingCode()} onSelect={setSelected} onCommand={sendDeviceCommand} commandBusy={commandBusy} />}
        {view === 'policies' && <PoliciesView policies={policies} devices={devices} loaded={loaded} onCreate={() => setNewPolicyOpen(true)} onToggle={togglePolicy} onAssign={assignPolicy} />}
      </div>
      <footer className="footer"><span>FOCUSGUARD CONTROL PLANE <i>·</i> v0.1.0</span><span><CircleHelp size={13} /> API {config.baseUrl}</span></footer>
    </main>
    {currentDevice && <DeviceDrawer device={currentDevice} command={commandForDevice(currentDevice.id)} onClose={() => setSelected(null)} onCommand={sendDeviceCommand} busy={commandBusy} />}
    {newPolicyOpen && <PolicyModal name={policyName} setName={setPolicyName} description={policyDescription} setDescription={setPolicyDescription} busy={policyBusy} onClose={() => setNewPolicyOpen(false)} onSubmit={createPolicy} />}
    {showSettings && <SettingsModal value={baseDraft} setValue={setBaseDraft} onClose={() => setShowSettings(false)} onSubmit={saveBaseUrl} />}
    {pairingCode && <PairingCodeModal code={pairingCode.code} expiresIn={pairingCode.expiresIn} onClose={() => setPairingCode(null)} />}
  </div>;
}

function viewLabel(view: View) { return view === 'overview' ? '总览' : view === 'devices' ? '设备' : '策略'; }
function commandLabel(command: 'sync' | 'lock' | 'unlock') { return command === 'sync' ? '立即同步' : command === 'lock' ? '远程锁定' : '解除锁定'; }

function AuthScreen(props: {
  mode: AuthState; setMode: (mode: AuthState) => void; email: string; setEmail: (value: string) => void;
  password: string; setPassword: (value: string) => void; baseUrl: string; setBaseUrl: (value: string) => void;
  busy: boolean; notice: Notice | null; onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  onSettings: () => void; showSettings: boolean; onSaveBase: (event: SubmitEvent<HTMLFormElement>) => void;
  onCloseSettings: () => void;
}) {
  return <div className="auth-shell">
    <div className="auth-aside"><a className="brand auth-brand" href="#"><span className="brand-mark"><ShieldCheck size={19} strokeWidth={2.4} /></span><span className="brand-copy"><b>focusguard</b><small>DEVICE CONTROL</small></span></a>
      <div className="auth-illustration"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="illustration-core"><Shield size={74} strokeWidth={1.2} /><span className="core-check"><Check size={19} /></span></div><div className="float-chip chip-one"><Activity size={15} /> Device health <b>98.4%</b></div><div className="float-chip chip-two"><Wifi size={15} /> Fleet connected <b>Live</b></div><div className="float-chip chip-three"><LockKeyhole size={15} /> Policy engine <b>Active</b></div></div>
      <div className="auth-aside-copy"><div className="eyebrow"><span /> DEVICE OPERATIONS PLATFORM</div><h1>Clarity for every<br /><em>connected device.</em></h1><p>集中管理设备、策略与远程操作。所有状态均来自你配置的 API。</p></div><div className="auth-aside-foot">SECURE BY DESIGN <span>·</span> BUILT FOR TEAMS</div>
    </div>
    <div className="auth-main"><div className="auth-main-top"><span>CONTROL PLANE / ACCESS</span><button className="icon-button" title="配置 API 地址" onClick={props.onSettings}><Settings2 size={17} /></button></div>
      <div className="auth-card"><div className="auth-icon"><LockKeyhole size={21} /></div><div className="eyebrow auth-eyebrow">WELCOME BACK</div><h2>{props.mode === 'login' ? '登录控制台' : '创建工作区账户'}</h2><p className="auth-subtitle">{props.mode === 'login' ? '输入凭据以访问你的设备控制台。' : '注册后即可开始管理已接入的设备。'}</p>
        {props.notice && <div className={`auth-notice ${props.notice.kind}`}><AlertCircle size={16} />{props.notice.text}</div>}
        <form className="auth-form" onSubmit={props.onSubmit}><label>邮箱地址<input type="email" autoComplete="email" placeholder="name@company.com" required value={props.email} onChange={(e) => props.setEmail(e.target.value)} /></label><label>密码<input type="password" autoComplete={props.mode === 'login' ? 'current-password' : 'new-password'} placeholder="至少 8 位字符" minLength={8} required value={props.password} onChange={(e) => props.setPassword(e.target.value)} /></label><button className="primary-button auth-submit" disabled={props.busy}>{props.busy ? <LoaderCircle size={17} className="spin" /> : <>{props.mode === 'login' ? '登录' : '创建账户'} <ArrowRight size={16} /></>}</button></form>
        <div className="auth-switch">{props.mode === 'login' ? '还没有账户？' : '已有账户？'}<button onClick={() => props.setMode(props.mode === 'login' ? 'register' : 'login')}>{props.mode === 'login' ? '注册' : '返回登录'}</button></div>
        <div className="auth-api"><span className={`api-indicator ${props.baseUrl ? 'configured' : ''}`} /><div><b>API ENDPOINT</b><small title={props.baseUrl}>{props.baseUrl || '尚未配置 API 地址'}</small></div><button className="text-button" onClick={props.onSettings}>设置</button></div>
      </div><div className="auth-legal">连接后，数据请求会发送至你配置的 API 服务。</div>
    </div>
    {props.showSettings && <SettingsModal value={props.baseUrl} setValue={props.setBaseUrl} onClose={props.onCloseSettings} onSubmit={props.onSaveBase} />}
  </div>;
}

function Overview(props: {
  devices: Device[]; policies: Policy[]; onlineCount: number; loaded: boolean; loading: boolean; usage: UsageRecord[]; commands: Record<string, CommandState>; commandForDevice: (deviceId: string) => CommandState | undefined;
  onViewDevices: () => void; onViewPolicies: () => void; onRefresh: () => void; onSelect: (id: string) => void;
  onCommand: (device: Device, command: 'sync' | 'lock' | 'unlock') => void; commandBusy: string | null;
}) {
  const offline = props.devices.length - props.onlineCount;
  const usageSeconds = props.usage.reduce((total, item) => total + item.durationSeconds, 0);
  const usageLabel = usageSeconds >= 3600 ? `${Math.floor(usageSeconds / 3600)}h ${Math.floor((usageSeconds % 3600) / 60)}m` : `${Math.floor(usageSeconds / 60)}m`;
  return <>
    <div className="page-heading"><div><div className="eyebrow"><span className="heading-mark" /> OVERVIEW</div><h1>设备总览</h1><p>设备状态与策略执行情况，一目了然。</p></div><button className="secondary-button" onClick={props.onRefresh} disabled={props.loading}>{props.loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={15} />} 刷新数据</button></div>
    <div className="metric-grid"><Metric icon={<Laptop size={17} />} label="已注册设备" value={props.loaded ? String(props.devices.length) : '—'} note={props.loaded ? 'API 返回设备总数' : '等待 API 数据'} tone="mint" /><Metric icon={<Wifi size={17} />} label="在线设备" value={props.loaded ? String(props.onlineCount) : '—'} note={props.loaded ? `${props.loaded ? Math.max(offline, 0) : 0} 台设备当前离线` : '等待 API 数据'} tone="blue" /><Metric icon={<ShieldCheck size={17} />} label="已配置策略" value={props.loaded ? String(props.policies.length) : '—'} note={props.loaded ? `${props.policies.filter((p) => p.enabled).length} 条已启用` : '等待 API 数据'} tone="amber" /><Metric icon={<Activity size={17} />} label="运行状态" value={props.loaded ? '正常' : '待连接'} note={props.loaded ? '数据同步已完成' : '尚未读取 API'} tone="rose" /><Metric icon={<Clock3 size={17} />} label="使用时长" value={props.loaded ? usageLabel : '—'} note={props.loaded ? '来自 /usage 实时汇总' : '后端未返回使用数据'} tone="blue" /></div>
    <div className="section-heading"><div><h2>设备状态</h2><span className="section-caption">DEVICE FLEET <i>·</i> {props.loaded ? `${props.devices.length} TOTAL` : 'NO DATA'}</span></div><button className="link-button" onClick={props.onViewDevices}>查看全部 <ArrowRight size={15} /></button></div>
    <div className="panel fleet-panel"><div className="panel-head"><div><b>设备活动</b><span>最新接入设备的连接状态</span></div><span className={`data-pill ${props.loaded ? 'is-live' : ''}`}><span />{props.loaded ? 'API DATA' : 'NOT LOADED'}</span></div>
      {!props.loaded || props.devices.length === 0 ? <EmptyState loading={props.loading} loaded={props.loaded} kind="device" onAction={props.onRefresh} /> : <div className="device-list">{props.devices.slice(0, 5).map((device) => <DeviceRow key={device.id} device={device} command={props.commandForDevice(device.id)} onSelect={props.onSelect} onCommand={props.onCommand} busy={props.commandBusy} />)}</div>}
    </div>
    <div className="lower-grid"><section><div className="section-heading compact"><div><h2>策略概览</h2><span className="section-caption">POLICY STATUS</span></div><button className="link-button" onClick={props.onViewPolicies}>管理策略 <ArrowRight size={15} /></button></div><div className="panel policy-overview">{!props.loaded || props.policies.length === 0 ? <EmptyState loading={props.loading} loaded={props.loaded} kind="policy" onAction={props.onViewPolicies} /> : props.policies.slice(0, 3).map((policy) => <PolicySummary key={policy.id} policy={policy} />)}</div></section>
      <section className="activity-section"><div className="section-heading compact"><div><h2>控制摘要</h2><span className="section-caption">LIVE SNAPSHOT</span></div><span className="mini-live"><span /> LIVE</span></div><div className="panel summary-panel"><div className="summary-top"><span className="summary-icon"><Sparkles size={17} /></span><span className="summary-label">FLEET HEALTH</span><span className="summary-indicator" /></div><strong>{props.loaded ? (props.devices.length ? `${Math.round(props.onlineCount / props.devices.length * 100)}%` : '0%') : '—'}</strong><p>{props.loaded ? '在线率基于 API 当前设备状态' : '连接 API 后显示设备健康状态'}</p><div className="summary-divider" /><div className="summary-row"><span><span className="tiny-dot green" />在线</span><b>{props.loaded ? props.onlineCount : '—'}</b></div><div className="summary-row"><span><span className="tiny-dot gray" />离线</span><b>{props.loaded ? offline : '—'}</b></div></div></section></div>
  </>;
}

function Metric(props: { icon: ReactNode; label: string; value: string; note: string; tone: string }) {
  return <div className="metric"><div className={`metric-icon ${props.tone}`}>{props.icon}</div><span className="metric-label">{props.label}</span><strong>{props.value}</strong><small>{props.note}</small><span className={`metric-spark ${props.tone}`}><span /><span /><span /><span /><span /><span /><span /><span /></span></div>;
}

function EmptyState(props: { loading: boolean; loaded: boolean; kind: 'device' | 'policy'; onAction: () => void }) {
  const device = props.kind === 'device';
  return <div className="empty-state"><span className="empty-icon">{device ? <Smartphone size={20} /> : <Shield size={20} />}</span><b>{props.loading ? '正在从 API 加载…' : props.loaded ? (device ? '还没有接入设备' : '还没有创建策略') : '尚无 API 数据'}</b><span>{props.loading ? '数据返回后会显示在这里。' : props.loaded ? (device ? '设备接入后会自动出现在此列表。' : '创建一条策略以开始管理设备。') : '登录后连接 API，即可读取真实数据。'}</span><button className="empty-action" onClick={props.onAction}>{props.loaded && !device ? <><Plus size={14} /> 创建策略</> : <><RefreshCw size={14} /> {props.loaded ? '重新加载' : '检查连接'}</>}</button></div>;
}

function DeviceRow(props: { device: Device; command?: CommandState; onSelect: (id: string) => void; onCommand: (device: Device, command: 'sync' | 'lock' | 'unlock') => void; busy: string | null }) {
  const { device } = props;
  const online = isOnline(device.status);
  return <div className="device-row"><button className="device-identity" onClick={() => props.onSelect(device.id)}><span className={`device-icon ${online ? 'online' : ''}`}>{device.platform?.toLowerCase().includes('ios') ? <Smartphone size={17} /> : <Laptop size={18} />}</span><span className="device-name"><b>{device.name || device.id}</b><small>{device.id}</small></span></button><span className={`status-chip ${online ? 'online' : 'offline'}`}><span />{device.status || 'unknown'}</span><span className="device-time"><Clock3 size={13} />{prettyTime(device.lastSeen)}</span><span className="device-command-status" title={props.command?.error || undefined}>{props.command?.status || device.commandStatus || '无命令'}{props.command?.error ? ` · ${props.command.error}` : ''}</span><button className="row-action" onClick={() => props.onCommand(device, 'sync')} disabled={props.busy === `${device.id}:sync`} title="立即同步"><RefreshCw size={15} className={props.busy === `${device.id}:sync` ? 'spin' : ''} /></button><button className="row-more" onClick={() => props.onSelect(device.id)} title="设备详情"><ArrowRight size={15} /></button></div>;
}

function DevicesView(props: { devices: Device[]; total: number; search: string; setSearch: (value: string) => void; loaded: boolean; loading: boolean; commands: Record<string, CommandState>; commandForDevice: (deviceId: string) => CommandState | undefined; onRefresh: () => void; onPair: () => void; onSelect: (id: string) => void; onCommand: (device: Device, command: 'sync' | 'lock' | 'unlock') => void; commandBusy: string | null }) {
  return <><div className="page-heading"><div><div className="eyebrow"><span className="heading-mark" /> FLEET MANAGEMENT</div><h1>设备</h1><p>查看设备连接状态并执行远程命令。</p></div><div className="heading-actions"><button className="secondary-button" onClick={props.onPair}><Plus size={15} /> 生成配对码</button><button className="secondary-button" onClick={props.onRefresh} disabled={props.loading}>{props.loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={15} />} 刷新</button></div></div>
    <div className="toolbar"><div className="search-field"><Search size={16} /><input placeholder="搜索名称、设备 ID 或状态" value={props.search} onChange={(event) => props.setSearch(event.target.value)} /></div><div className="toolbar-meta"><span>{props.loaded ? `${props.devices.length} / ${props.total} 台设备` : '尚未读取数据'}</span><button className="icon-button" title="刷新列表" onClick={props.onRefresh}><SlidersHorizontal size={16} /></button></div></div>
    <div className="panel table-panel"><div className="table-head"><span>设备</span><span>状态</span><span>最近连接</span><span>操作</span></div>{!props.loaded || props.devices.length === 0 ? <EmptyState loaded={props.loaded} loading={props.loading} kind="device" onAction={props.onRefresh} /> : <div className="device-list">{props.devices.map((device) => <DeviceRow key={device.id} device={device} command={props.commandForDevice(device.id)} onSelect={props.onSelect} onCommand={props.onCommand} busy={props.commandBusy} />)}</div>}</div>
  </>;
}

function PolicySummary(props: { policy: Policy }) {
  return <div className="policy-summary"><span className={`policy-icon ${props.policy.enabled ? 'enabled' : ''}`}><Shield size={16} /></span><span className="policy-summary-copy"><b>{props.policy.name}</b><small>{props.policy.description || '未添加描述'}</small></span><span className={`policy-state ${props.policy.enabled ? 'enabled' : ''}`}><span />{props.policy.enabled ? '已启用' : '已停用'}</span></div>;
}

function PoliciesView(props: { policies: Policy[]; devices: Device[]; loaded: boolean; onCreate: () => void; onToggle: (policy: Policy) => void; onAssign: (policy: Policy, deviceId: string) => void }) {
  const [targets, setTargets] = useState<Record<string, string>>({});
  return <><div className="page-heading"><div><div className="eyebrow"><span className="heading-mark" /> POLICY ENGINE</div><h1>策略</h1><p>创建策略、切换启用状态，并将策略下发到设备。</p></div><button className="primary-button" onClick={props.onCreate}><Plus size={16} /> 新建策略</button></div>
    {!props.loaded || props.policies.length === 0 ? <div className="panel policies-empty"><EmptyState loaded={props.loaded} loading={false} kind="policy" onAction={props.onCreate} /></div> : <div className="policies-grid">{props.policies.map((policy) => <article className="policy-card" key={policy.id}><div className="policy-card-top"><span className={`policy-icon large ${policy.enabled ? 'enabled' : ''}`}><Shield size={19} /></span><span className={`policy-state ${policy.enabled ? 'enabled' : ''}`}><span />{policy.enabled ? '已启用' : '已停用'}</span><button className="icon-button policy-menu" title="切换策略状态" onClick={() => props.onToggle(policy)}><Settings2 size={16} /></button></div><h3>{policy.name}</h3><p>{policy.description || '暂无策略说明。'}</p><div className="policy-card-meta"><span><Smartphone size={14} />{policy.deviceCount ?? 0} 台设备</span><span className="policy-id">v{policy.version ?? '—'} · ID {policy.id}</span></div><div className="assign-row"><select aria-label={`为${policy.name}选择设备`} value={targets[policy.id] || ''} onChange={(e) => setTargets({ ...targets, [policy.id]: e.target.value })}><option value="">选择设备下发</option>{props.devices.map((device) => <option key={device.id} value={device.id}>{device.name || device.id}</option>)}</select><button className="assign-button" title="下发策略" onClick={() => props.onAssign(policy, targets[policy.id] || '')}><Send size={15} /></button></div><button className="policy-toggle" onClick={() => props.onToggle(policy)}>{policy.enabled ? '停用策略' : '启用策略'}<ArrowRight size={14} /></button></article>)}</div>}
  </>;
}

function DeviceDrawer(props: { device: Device; command?: CommandState; onClose: () => void; onCommand: (device: Device, command: 'sync' | 'lock' | 'unlock') => void; busy: string | null }) {
  const online = isOnline(props.device.status);
  return <div className="drawer-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}><aside className="device-drawer"><div className="drawer-top"><span>DEVICE DETAILS</span><button className="icon-button" onClick={props.onClose} aria-label="关闭"><X size={18} /></button></div><div className="drawer-device"><span className={`device-icon big ${online ? 'online' : ''}`}>{props.device.platform?.toLowerCase().includes('ios') ? <Smartphone size={24} /> : <Laptop size={24} />}</span><h2>{props.device.name || props.device.id}</h2><span>{props.device.id}</span><span className={`status-chip ${online ? 'online' : 'offline'}`}><span />{props.device.status || 'unknown'}</span></div><div className="drawer-details"><div><span>平台</span><b>{props.device.platform || 'API 未提供'}</b></div><div><span>最近连接</span><b>{prettyTime(props.device.lastSeen)}</b></div><div><span>策略</span><b>{props.device.policyId || '未分配'} · v{props.device.policyVersion ?? '—'}</b></div><div><span>命令状态</span><b title={props.command?.error || undefined}>{props.command?.status || props.device.commandStatus || '无命令'}{props.command?.error ? ` · ${props.command.error}` : ''}</b></div></div><div className="drawer-actions"><b>远程命令</b><button onClick={() => props.onCommand(props.device, 'sync')} disabled={Boolean(props.busy)}><RefreshCw size={16} /> 立即同步 <ArrowRight size={15} /></button><button onClick={() => props.onCommand(props.device, 'lock')} disabled={Boolean(props.busy)}><LockKeyhole size={16} /> 远程锁定 <ArrowRight size={15} /></button><button onClick={() => props.onCommand(props.device, 'unlock')} disabled={Boolean(props.busy)}><LockKeyhole size={16} /> 解除锁定 <ArrowRight size={15} /></button></div><div className="drawer-note"><AlertCircle size={15} />命令会发送至配置的 API；执行结果取决于设备端响应。</div></aside></div>;
}

function PolicyModal(props: { name: string; setName: (v: string) => void; description: string; setDescription: (v: string) => void; busy: boolean; onClose: () => void; onSubmit: (e: SubmitEvent<HTMLFormElement>) => void }) {
  return <Modal title="新建策略" subtitle="定义一条新的设备管理策略。" onClose={props.onClose}><form className="modal-form" onSubmit={props.onSubmit}><label>策略名称<input autoFocus required maxLength={80} value={props.name} onChange={(e) => props.setName(e.target.value)} placeholder="例如：工作时段限制" /></label><label>说明<textarea rows={3} maxLength={300} value={props.description} onChange={(e) => props.setDescription(e.target.value)} placeholder="描述该策略的用途" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={props.onClose}>取消</button><button className="primary-button" disabled={props.busy}>{props.busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />} 创建策略</button></div></form></Modal>;
}

function SettingsModal(props: { value: string; setValue: (value: string) => void; onClose: () => void; onSubmit: (e: SubmitEvent<HTMLFormElement>) => void }) {
  return <Modal title="API 连接设置" subtitle="输入控制服务的 HTTP 或 HTTPS Base URL。" onClose={props.onClose}><form className="modal-form" onSubmit={props.onSubmit}><label>API Base URL<input autoFocus type="text" required placeholder="https://api.example.com" value={props.value} onChange={(e) => props.setValue(e.target.value)} /><small>仅支持包含协议与主机名的绝对地址；控制台会自动补齐 /api/v1。</small></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={props.onClose}>取消</button><button className="primary-button"><Check size={16} /> 保存地址</button></div></form></Modal>;
}

function PairingCodeModal(props: { code: string; expiresIn: number; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() { try { await navigator.clipboard.writeText(props.code); setCopied(true); } catch { setCopied(false); } }
  return <Modal title="设备配对码" subtitle={`请在 ${Math.round(props.expiresIn / 60)} 分钟内完成配对。`} onClose={props.onClose}><div className="pairing-code"><strong>{props.code}</strong><button className="secondary-button" onClick={() => void copy()}>{copied ? '已复制' : '复制配对码'}</button></div></Modal>;
}

function Modal(props: { title: string; subtitle: string; onClose: () => void; children: ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={props.title}><div className="modal-heading"><span className="modal-icon"><Command size={18} /></span><button className="icon-button" onClick={props.onClose} aria-label="关闭"><X size={17} /></button></div><h2>{props.title}</h2><p>{props.subtitle}</p>{props.children}</section></div>;
}
