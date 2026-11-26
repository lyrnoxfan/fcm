"""Upgrade a genuinely paired old debug app on a disposable Android emulator.

Not a test of the production-signed APK or actual network host.
"""
from pathlib import Path
import os
import subprocess
from threading import Thread
from http.server import ThreadingHTTPServer
from importlib.machinery import SourceFileLoader

smoke = SourceFileLoader('smoke', 'ci/android-smoke.py').load_module()
ROOT = smoke.ROOT
fixture_env = {key: os.environ[key] for key in ['PATH', 'HOME', 'TMPDIR'] if key in os.environ}
fixture_env['WRANGLER_SEND_METRICS'] = 'false'


def start_worker(config, log):
    proc = subprocess.Popen([
        'backend/node_modules/.bin/wrangler', 'dev', '--config', str(ROOT / config),
        '--local', '--ip', '127.0.0.1', '--port', '18786',
        '--persist-to', str(ROOT / 'state'),
    ], env=fixture_env, stdout=log, stderr=subprocess.STDOUT)
    smoke.wait_for(smoke.ready, 'local isolated backend', 60)
    return proc


def pair_old_app(code):
    def fields():
        return [node for node in smoke.nodes() if node.get('class') == 'android.widget.EditText']
    fields_ = smoke.wait_for(fields, 'old app pairing fields')
    assert len(fields_) == 2, f'Expected old address and code fields, got {len(fields_)}'
    smoke.tap(fields_[0]); smoke.shell('input', 'text', smoke.BASE); smoke.key('KEYCODE_BACK')
    fields_ = smoke.wait_for(lambda: f if len(f := fields()) == 2 else None, 'both old pairing fields')
    smoke.tap(fields_[1]); smoke.shell('input', 'text', code); smoke.key('KEYCODE_BACK')
    smoke.wait_for(lambda: any(smoke.BASE in (n.get('text') or '') for n in fields()), 'legacy endpoint retained')
    smoke.tap(smoke.wait_text('配对设备'))


def run():
    smoke.adb('install', 'legacy-fcm/android/app/build/outputs/apk/debug/app-debug.apk')
    smoke.adb('reverse', 'tcp:18787', 'tcp:18787')
    smoke.shell('wm', 'size', '720x1680'); smoke.shell('wm', 'density', '213')
    smoke.key('KEYCODE_WAKEUP'); smoke.shell('wm', 'dismiss-keyguard')
    smoke.shell('settings', 'put', 'system', 'screen_off_timeout', '600000')
    token = smoke.api('/api/v1/auth/register', 'POST', {'email': 'upgrade@example.test', 'password': 'fixture-only password 1234'}, expected=201)['token']
    code = smoke.api('/api/v1/devices/pairing-codes', 'POST', {}, token, 201)['code']
    smoke.launch_main(); smoke.wait_text('设置 FocusGuard', 50)
    smoke.tap(smoke.wait_text('稍后设置')); smoke.wait_text('设备同步')
    pair_old_app(code)
    def paired():
        rows = smoke.api('/api/v1/devices', token=token)
        return rows[0]['id'] if len(rows) == 1 else None
    device = smoke.wait_for(paired, 'legacy app paired', 60)
    heartbeat_path = f'/api/v1/devices/{device}/heartbeat'
    smoke.wait_for(lambda: heartbeat_path in smoke.heartbeat_observations, 'legacy token heartbeat succeeded', 60)
    print('PASS: old app paired and authenticated to the legacy backend')
    return token, device, heartbeat_path


proxy = ThreadingHTTPServer(('127.0.0.1', 18787), smoke.FixtureProxy)
Thread(target=proxy.serve_forever, daemon=True).start()
worker = None
try:
    with (ROOT / 'legacy-worker.log').open('w') as oldlog, (ROOT / 'upgraded-worker.log').open('w') as newlog:
        worker = start_worker('legacy-wrangler.toml', oldlog)
        token, device, heartbeat_path = run()
        worker.terminate(); worker.wait(timeout=15); worker = None
        worker = start_worker('wrangler.toml', newlog)
        before_heartbeats = len(smoke.heartbeat_observations)
        before_register = len(smoke.registration_observations)
        smoke.adb('install', '-r', 'android/app/build/outputs/apk/debug/app-debug.apk')
        smoke.launch_main()
        smoke.wait_for(lambda: heartbeat_path in smoke.heartbeat_observations[before_heartbeats:],
                       'upgraded app authenticated a fresh heartbeat with the legacy ID/token', 75)
        devices = smoke.api('/api/v1/devices', token=token)
        assert len(devices) == 1 and devices[0]['id'] == device, 'upgrade changed or duplicated legacy identity'
        assert len(smoke.registration_observations) == before_register, 'upgrade unexpectedly re-registered device'
        print('PASS: in-place debug APK upgrade retained legacy ID and token, authenticated heartbeat and did not re-register')
except Exception:
    print('Foreground:', smoke.current(), flush=True)
    print('Old worker:', (ROOT / 'legacy-worker.log').read_text()[-3000:], flush=True)
    print('New worker:', (ROOT / 'upgraded-worker.log').read_text()[-3000:], flush=True)
    raise
finally:
    if worker:
        worker.terminate(); worker.wait(timeout=15)
    proxy.shutdown(); proxy.server_close()
