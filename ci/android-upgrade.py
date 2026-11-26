"""Upgrade a genuinely paired old debug app on a disposable Android emulator.

Not a test of the production-signed APK or actual network host.
"""
from pathlib import Path
import json
import os
import re
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


def installed_version_code():
    package = smoke.shell('dumpsys', 'package', smoke.APP)
    match = re.search(r'versionCode=(\d+)', package)
    if not match:
        raise AssertionError('Could not read installed app versionCode')
    return int(match.group(1))


def pair_old_app(code):
    def fields():
        return [node for node in smoke.nodes() if node.get('class') == 'android.widget.EditText']
    fields_ = smoke.wait_for(fields, 'old app pairing fields')
    assert len(fields_) == 2, f'Expected old address and code fields, got {len(fields_)}'
    smoke.tap(fields_[0]); smoke.shell('input', 'text', smoke.BASE); smoke.key('KEYCODE_BACK')
    fields_ = smoke.wait_for(lambda: f if len(f := fields()) == 2 else None, 'both old pairing fields')
    smoke.tap(fields_[1]); smoke.shell('input', 'text', code); smoke.key('KEYCODE_BACK')
    smoke.wait_for(lambda: any(smoke.BASE in (n.get('text') or '') for n in fields()), 'legacy endpoint retained')
    code_field = fields()[1]
    print(f'OBSERVED: legacy pairing fields populated; endpoint retained={any(smoke.BASE in (n.get("text") or "") for n in fields())}, code_length={len(code_field.get("text") or "")}', flush=True)
    button = smoke.wait_text('配对设备')
    if button.get('enabled') != 'true':
        raise AssertionError(f'Legacy pairing button disabled; enabled={button.get("enabled")}, field_lengths={[len(n.get("text") or "") for n in fields()]}')
    smoke.tap(button)
    print('OBSERVED: tapped legacy pairing button', flush=True)


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
    legacy_rows = smoke.api('/api/v1/devices', token=token)
    assert len(legacy_rows) == 1 and legacy_rows[0]['id'] == device
    heartbeat_path = f'/api/v1/devices/{device}/heartbeat'
    smoke.wait_for(lambda: heartbeat_path in smoke.heartbeat_observations, 'legacy token heartbeat succeeded', 60)
    print('LEGACY_STATE: ' + json.dumps({k: legacy_rows[0].get(k) for k in ['id', 'name', 'platform', 'app_version', 'created_at']}, sort_keys=True), flush=True)
    print('PASS: old app paired and authenticated to the legacy backend')
    return token, device, heartbeat_path


proxy = ThreadingHTTPServer(('127.0.0.1', 18787), smoke.FixtureProxy)
Thread(target=proxy.serve_forever, daemon=True).start()
worker = None
try:
    with (ROOT / 'legacy-worker.log').open('w') as oldlog, (ROOT / 'upgraded-worker.log').open('w') as newlog:
        worker = start_worker('legacy-wrangler.toml', oldlog)
        token, device, heartbeat_path = run()
        legacy_version_code = installed_version_code()
        worker.terminate(); worker.wait(timeout=15); worker = None
        worker = start_worker('wrangler.toml', newlog)
        before_heartbeats = len(smoke.heartbeat_observations)
        before_register = len(smoke.registration_observations)
        smoke.adb('install', '-r', 'android/app/build/outputs/apk/debug/app-debug.apk')
        upgraded_version_code = installed_version_code()
        assert upgraded_version_code > legacy_version_code, (
            f'APK was not a version upgrade: legacy={legacy_version_code}, upgraded={upgraded_version_code}'
        )
        print(f'OBSERVED: in-place package versionCode {legacy_version_code} -> {upgraded_version_code}', flush=True)
        smoke.launch_main()
        smoke.wait_for(lambda: heartbeat_path in smoke.heartbeat_observations[before_heartbeats:],
                       'upgraded app authenticated a fresh heartbeat with the legacy ID/token', 75)
        devices = smoke.api('/api/v1/devices', token=token)
        assert len(devices) == 1 and devices[0]['id'] == device, 'upgrade changed or duplicated legacy identity'
        assert devices[0].get('app_version') == '1.0.7', f'upgrade heartbeat did not report new app version: {devices[0].get("app_version")}'
        assert len(smoke.registration_observations) == before_register, 'upgrade unexpectedly re-registered device'
        print('UPGRADED_STATE: ' + json.dumps({k: devices[0].get(k) for k in ['id', 'name', 'platform', 'app_version', 'created_at']}, sort_keys=True), flush=True)
        print('PASS: in-place debug APK upgrade retained legacy ID and token, authenticated heartbeat and did not re-register')
except Exception:
    print('Foreground:', smoke.current(), flush=True)
    print('UI nodes:', [(n.get('class'), (n.get('text') or '')[:80], n.get('clickable'), n.get('enabled'), n.get('bounds')) for n in smoke.nodes()], flush=True)
    print('Fixture HTTP requests:', smoke.request_observations[-50:], flush=True)
    print('Android crash logcat:', smoke.adb('logcat', '-d', '-t', '1200', '-s', 'AndroidRuntime').splitlines()[-100:], flush=True)
    print('Old worker:', (ROOT / 'legacy-worker.log').read_text()[-3000:], flush=True)
    print('New worker:', (ROOT / 'upgraded-worker.log').read_text()[-3000:], flush=True)
    raise
finally:
    if worker:
        worker.terminate(); worker.wait(timeout=15)
    proxy.shutdown(); proxy.server_close()
