"""Test legitimate use of the app on a disposable emulator and isolated D1."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import time
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

APP = 'com.focusguard'
SERVICE = f'{APP}/.enforcement.PolicyAccessibilityService'
ROOT = Path(os.environ['RUNNER_TEMP']) / 'focusguard-smoke'
BASE = 'https://127.0.0.1:18787'
TLS = ssl.create_default_context(cafile=str(ROOT / 'ca.pem'))


def adb(*args, check=True):
    p = subprocess.run(['adb', *args], text=True, capture_output=True, check=False, timeout=30)
    if check and p.returncode:
        raise RuntimeError(f'adb {args[0]} failed: {p.stderr.strip()}')
    return p.stdout.strip()


def shell(*args):
    return adb('shell', *args)


def wait_for(fn, description, seconds=35):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if answer := fn():
            return answer
        time.sleep(.6)
    raise AssertionError(f'Timed out: {description}')


def nodes():
    if 'dumped to' not in shell('uiautomator', 'dump', '/sdcard/focusguard-smoke.xml'):
        return []
    try:
        window_nodes = list(ET.fromstring(adb('exec-out', 'cat', '/sdcard/focusguard-smoke.xml')).iter('node'))
        # A system Pixel Launcher ANR obscured MainActivity on a hosted run.
        # Close only that system dialog; never hide a FocusGuard ANR or crash.
        if any(n.get('package') == 'android' and n.get('text') == "Pixel Launcher isn't responding"
               for n in window_nodes):
            close = next((n for n in window_nodes if n.get('package') == 'android'
                          and n.get('text') == 'Close app' and n.get('clickable') == 'true'), None)
            if close is not None:
                print('FIXTURE: close system Pixel Launcher ANR dialog', flush=True)
                tap(close)
                return []
        return window_nodes
    except ET.ParseError:
        return []


def text_is(text, seq=None):
    return next((n for n in (nodes() if seq is None else seq) if n.get('text') == text), None)


def tap(node):
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    shell('input', 'tap', str((x1+x2)//2), str((y1+y2)//2))


def wait_text(text, seconds=30):
    # An XML node with no child nodes is falsey, so wrap it when returning it.
    def match():
        n = text_is(text)
        return (n,) if n is not None else None
    return wait_for(match, text, seconds)[0]


def key(code):
    shell('input', 'keyevent', code)


def current():
    result = shell('dumpsys', 'activity', 'activities')
    return '\n'.join(l for l in result.splitlines() if 'mResumedActivity' in l or 'topResumedActivity' in l)


def active(pkg):
    return f'{pkg}/' in current()


def launch_main():
    shell('am', 'start', '-W', '-n', f'{APP}/.MainActivity')


def api(path, method='GET', body=None, token=None, expected=200):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    r = Request(BASE + path, method=method, headers=headers,
                data=None if body is None else json.dumps(body).encode())
    try:
        with urlopen(r, context=TLS, timeout=5) as response:
            status, data = response.status, response.read()
    except HTTPError as e:
        status, data = e.code, e.read()
    if status != expected:
        raise AssertionError(f'{method} {path.split("?")[0]} returned {status}, expected {expected}')
    return json.loads(data) if data else None


def ready():
    try:
        return api('/health')['status'] == 'ok'
    except (OSError, AssertionError):
        return False


def seed_grants(enabled):
    # Only on the disposable emulator, after the onboarding Settings navigation assertions.
    if enabled:
        shell('appops', 'set', APP, 'GET_USAGE_STATS', 'allow')
        shell('settings', 'put', 'secure', 'enabled_accessibility_services', SERVICE)
        shell('settings', 'put', 'secure', 'accessibility_enabled', '1')
    else:
        shell('settings', 'delete', 'secure', 'enabled_accessibility_services')
        shell('settings', 'put', 'secure', 'accessibility_enabled', '0')


def onboarding():
    launch_main()
    wait_text('设置 FocusGuard', 50)
    print('OBSERVED: FocusGuard first-run permission dialog')
    ns = nodes()
    for label in ['使用情况访问', '无障碍服务', '通知 · 可选']:
        assert text_is(label, ns) is not None, f'Missing first-run permission: {label}'
    for index, activity_part in enumerate(['UsageAccess', 'Accessibility']):
        grants = [n for n in nodes() if n.get('text') == '授权']
        assert len(grants) == 3
        tap(grants[index])
        wait_for(lambda: active('com.android.settings'), 'Android Settings is foreground')
        assert activity_part.lower() in current().lower(), 'Unexpected Android Settings activity'
        key('KEYCODE_BACK')
        wait_text('设置 FocusGuard')
    grants = [n for n in nodes() if n.get('text') == '授权']
    tap(grants[2])
    wait_for(lambda: any('permissioncontroller' in (n.get('package') or '') for n in nodes()), 'system notification consent')
    # Use the OS deny control and wait for the app dialog before interacting.
    def deny_notification():
        for node in nodes():
            if (node.get('package', '').endswith('permissioncontroller')
                    and node.get('resource-id', '').endswith(':id/permission_deny_button')
                    and node.get('enabled') == 'true'):
                return (node,)
        return None

    tap(wait_for(deny_notification, 'notification permission deny button')[0])
    wait_for(lambda: not any(n.get('package', '').endswith('permissioncontroller') for n in nodes()),
             'notification dialog closed')
    tap(wait_text('稍后设置'))
    wait_text('设备同步')
    assert text_is('设置 FocusGuard') is None, 'Skip did not dismiss the app dialog'
    key('KEYCODE_HOME')
    wait_for(lambda: not active(APP), 'app moved to background before restart')
    shell('am', 'force-stop', APP)
    launch_main()
    wait_text('设备同步')
    assert text_is('设置 FocusGuard') is None
    print('PASS: first-run disclosure, Usage Access and Accessibility Settings navigation, notification prompt, skip and relaunch')


def fields():
    return [n for n in nodes() if n.get('class') == 'android.widget.EditText']


def pair(code):
    inputs = wait_for(fields, 'pairing fields')
    # Use actual dashboard controls; a tall viewport keeps the two initial fields available.
    assert len(inputs) == 2, f'expected two pairing fields, got {len(inputs)}'
    tap(inputs[0]); shell('input', 'text', BASE); key('KEYCODE_BACK')
    inputs = wait_for(lambda: f if len(f := fields()) == 2 else None, 'both pairing fields')
    tap(inputs[1]); shell('input', 'text', code); key('KEYCODE_BACK')
    tap(wait_text('配对设备'))


def locked_ui():
    wait_text('设备已被锁定', 40)
    labels = [n.get('text') for n in nodes() if n.get('package') == APP and n.get('text')]
    assert labels == ['设备已被锁定'], f'Unexpected lock labels: {labels}'


def launch_ordinary_app():
    for p in ['com.google.android.calculator', 'com.android.calculator2', 'com.google.android.apps.messaging', 'com.android.messaging', 'com.google.android.contacts', 'com.android.contacts', 'com.android.chrome']:
        if shell('cmd', 'package', 'path', p).startswith('package:'):
            shell('monkey', '-p', p, '-c', 'android.intent.category.LAUNCHER', '1')
            return p
    raise AssertionError('No ordinary launchable app fixture')


def scenarios():
    adb('install', 'android/app/build/outputs/apk/debug/app-debug.apk')
    adb('reverse', 'tcp:18787', 'tcp:18787')
    # Retain the same ~540x1260 dp layout with fewer software-rendered pixels.
    shell('wm', 'size', '720x1680')
    shell('wm', 'density', '213')
    shell('input', 'keyevent', 'KEYCODE_WAKEUP')
    shell('wm', 'dismiss-keyguard')
    shell('settings', 'put', 'system', 'screen_off_timeout', '600000')
    onboarding()
    seed_grants(True)
    token = api('/api/v1/auth/register', 'POST', {'email': 'android-smoke@example.test', 'password': 'fixture-only password 1234'}, expected=201)['token']
    code = api('/api/v1/devices/pairing-codes', 'POST', {}, token, 201)['code']
    launch_main()
    pair(code)
    def paired():
        devices = api('/api/v1/devices', token=token)
        return devices[0]['id'] if devices and devices[0]['accessibility_enabled'] == 1 else None
    device = wait_for(paired, 'Android pairs and reports active Accessibility', 50)
    print('PASS: app paired over HTTPS to isolated D1; native device heartbeat received')

    def command(kind):
        cmd = api('/api/v1/commands', 'POST', {'device_id': device, 'command': kind, 'expires_in': 180}, token, 201)['id']
        wait_for(lambda: api(f'/api/v1/devices/{device}/commands/{cmd}', token=token)['status'] == 'executed', f'{kind} device ACK', 55)

    ordinary = launch_ordinary_app()
    wait_for(lambda: active(ordinary), 'ordinary app is available before lock')
    command('lock')
    locked_ui()
    key('KEYCODE_BACK'); locked_ui()
    key('KEYCODE_HOME'); launch_ordinary_app(); locked_ui()
    print('PASS: real remote lock, normal app surfaced restriction, only requested text present, Back did not dismiss')

    key('KEYCODE_SLEEP')
    wait_for(lambda: 'mWakefulness=Asleep' in shell('dumpsys', 'power') or 'mWakefulness=Dozing' in shell('dumpsys', 'power'), 'system sleep')
    key('KEYCODE_WAKEUP')
    shell('wm', 'dismiss-keyguard')
    shell('am', 'start', '-W', '-a', 'android.intent.action.DIAL')
    wait_for(lambda: any(x in current().lower() for x in ['dialer', 'contacts']), 'dialer accessible under restriction')
    # No number is provided, and no outgoing call is made.
    print('PASS: system sleep remains available; phone app opens while restricted (no actual call)')
    launch_ordinary_app(); locked_ui()
    command('unlock')
    wait_for(lambda: not active(APP), 'lock view dismissed after remote unlock')
    launch_ordinary_app(); wait_for(lambda: active(ordinary), 'ordinary app after unlock')
    print('PASS: remote unlock acknowledged and ordinary app usable again')

    command('lock'); locked_ui()
    shell('am', 'start', '-W', '-a', 'android.settings.ACCESSIBILITY_SETTINGS')
    wait_for(lambda: active('com.android.settings'), 'Accessibility Settings still reachable while locked')
    time.sleep(2)
    assert active('com.android.settings'), 'system Settings was intercepted'
    seed_grants(False)
    launch_ordinary_app(); wait_for(lambda: active(ordinary), 'ordinary app after user permission revoked')
    print('PASS: OS Settings stays reachable and disabling Accessibility stops interception')

    seed_grants(True); launch_ordinary_app(); locked_ui()
    api(f'/api/v1/devices/{device}', 'DELETE', None, token, 200)
    wait_for(lambda: not active(APP), 'cached remote lock clears on unbind', 55)
    launch_main(); wait_text('未配对', 40)
    assert not api('/api/v1/devices', token=token)
    print('PASS: server unbind clears device pairing and remote restriction on actual Android app')


class FixtureProxy(BaseHTTPRequestHandler):
    """Terminate CI HTTPS using the job's explicitly pinned certificate."""
    protocol_version = 'HTTP/1.1'

    def relay(self):
        upstream = http.client.HTTPConnection('127.0.0.1', 18786, timeout=10)
        incoming = {k: v for k, v in self.headers.items() if k.lower() not in {'host', 'connection'}}
        try:
            size = int(self.headers.get('Content-Length', '0'))
            upstream.request(self.command, self.path, body=self.rfile.read(size) if size else None, headers=incoming)
            response = upstream.getresponse()
            data = response.read()
            self.send_response(response.status)
            for k, v in response.getheaders():
                if k.lower() not in {'server', 'date', 'transfer-encoding', 'content-length', 'connection'}:
                    self.send_header(k, v)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (OSError, http.client.HTTPException):
            self.send_error(503)
        finally:
            upstream.close()

    do_GET = do_POST = do_PUT = do_DELETE = relay

    def log_message(self, *args):
        pass


proxy = ThreadingHTTPServer(('127.0.0.1', 18787), FixtureProxy)
server_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
server_tls.load_cert_chain(ROOT / 'server.pem', ROOT / 'server.key')
proxy.socket = server_tls.wrap_socket(proxy.socket, server_side=True)
Thread(target=proxy.serve_forever, daemon=True).start()

with (ROOT / 'worker.log').open('w') as log:
    fixture_env = {key: os.environ[key] for key in ['PATH', 'HOME', 'TMPDIR'] if key in os.environ}
    fixture_env['WRANGLER_SEND_METRICS'] = 'false'
    worker = subprocess.Popen([
        'backend/node_modules/.bin/wrangler', 'dev', '--config', str(ROOT / 'wrangler.toml'),
        '--local', '--ip', '127.0.0.1', '--port', '18786',
        '--persist-to', str(ROOT / 'state'),
    ], env=fixture_env, stdout=log, stderr=subprocess.STDOUT)
    try:
        wait_for(ready, 'local HTTPS Worker', 45)
        scenarios()
    except Exception:
        print('Foreground:', current(), flush=True)
        print('UI labels:', [n.get('text') for n in nodes() if n.get('text')], flush=True)
        print('Emulator app diagnostics:', adb('logcat', '-d', '-t', '250', 'AndroidRuntime:E', 'FocusGuard:W', '*:S')[-3500:], flush=True)
        print((ROOT / 'worker.log').read_text()[-5000:], flush=True)
        raise
    finally:
        worker.terminate()
        worker.wait(timeout=10)
        proxy.shutdown()
        proxy.server_close()
