"""Disk-backed local delivery. This module never calls the Fusion API."""
import base64
import json
import os
from pathlib import Path
import re
import threading
import time
import urllib.request
import urllib.error
from urllib.parse import urlsplit
import uuid


def bridge_dir():
    if os.environ.get('TRACE_BRIDGE_DIR'):
        return Path(os.environ['TRACE_BRIDGE_DIR'])
    if os.name == 'nt':
        return Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData/Local'))) / 'Trace'
    return Path.home() / 'Library/Application Support/Trace'


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temp.open('w', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Transport:
    def __init__(self, directory=None):
        self.directory = Path(directory) if directory else bridge_dir()
        self.outbox = self.directory / 'fusion-outbox'
        self.outbox.mkdir(parents=True, exist_ok=True)
        self.wake = threading.Event()
        self.stopped = threading.Event()
        self.thread = None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def connection(self):
        value = json.loads((self.directory / 'connection.json').read_text(encoding='utf-8'))
        url = urlsplit(value.get('url', ''))
        if (value.get('version') != 1 or url.scheme != 'http' or url.hostname != '127.0.0.1'
                or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment
                or not value.get('instanceId') or not re.fullmatch(r'trc_[a-f0-9]{64}', value.get('uploadToken', ''))):
            raise ValueError('Invalid Trace connection record')
        with self.opener.open(value['url'].rstrip('/') + '/api/health', timeout=2) as response:
            health = json.load(response)
        if health.get('service') != 'trace-backend' or health.get('instanceId') != value['instanceId']:
            raise ValueError('Trace connection has changed')
        return value

    def enqueue(self, event, image_path, event_path):
        if not image_path or not Path(image_path).is_file():
            return {'ok': False, 'queued': False, 'message': 'Viewport missing; checkpoint kept locally.'}
        event = dict(event)
        event.pop('remoteUpload', None)
        event.setdefault('id', str(uuid.uuid4()))
        if Path(image_path).stat().st_size > 8 * 1024 * 1024:
            return {'ok': False, 'queued': False, 'message': 'Viewport exceeds 8 MB; checkpoint kept locally.'}
        payload = {'event': event, 'viewport': {'filename': 'viewport.png', 'contentType': 'image/png',
                   'base64': base64.b64encode(Path(image_path).read_bytes()).decode('ascii')}}
        record = {'payload': payload, 'eventPath': str(event_path), 'attempts': 0, 'retryAt': 0, 'blocked': False}
        atomic_json(self.outbox / (uuid.uuid4().hex + '.json'), record)
        self.wake.set()
        return {'ok': False, 'queued': True, 'message': 'Saved locally and queued for Trace. No manual connection setup needed.'}

    def tick(self):
        paths = sorted(self.outbox.glob('*.json'))
        connected = False
        issue = ''
        try:
            connection = self.connection()
            connected = True
        except Exception:
            connection = None
            issue = 'Waiting for Trace'
        blocked = 0
        for path in paths:
            if self.stopped.is_set():
                break
            try:
                record = json.loads(path.read_text(encoding='utf-8'))
                if record.get('blocked'):
                    blocked += 1
                    continue
                if not connection or record.get('retryAt', 0) > time.time():
                    continue
                request = urllib.request.Request(connection['url'].rstrip('/') + '/api/events',
                    data=json.dumps(record['payload']).encode('utf-8'), method='POST',
                    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + connection['uploadToken'],
                             'User-Agent': 'DesignRecorderFusion/0.5'})
                try:
                    with self.opener.open(request, timeout=8) as response:
                        result = json.load(response)
                    if result.get('ok') is not True or not result.get('eventId'):
                        raise ValueError('Trace did not acknowledge checkpoint')
                    # If this write fails, retain the outbox item. Retry is idempotent.
                    event_file = Path(record['eventPath'])
                    event = json.loads(event_file.read_text(encoding='utf-8'))
                    event['remoteUpload'] = {'ok': True, 'queued': False, 'response': result}
                    atomic_json(event_file, event)
                    path.unlink()
                except Exception as exc:
                    record['attempts'] += 1
                    record['retryAt'] = time.time() + min(300, 5 * 2 ** min(record['attempts'], 6))
                    # Authentication/connection failures may repair on restart. Invalid
                    # evidence and ID conflicts need attention, without discarding data.
                    record['blocked'] = isinstance(exc, urllib.error.HTTPError) and exc.code in (400, 409, 413, 415, 422)
                    record['error'] = 'Upload rejected (HTTP %s)' % exc.code if isinstance(exc, urllib.error.HTTPError) else 'Upload interrupted; will retry'
                    blocked += int(record['blocked'])
                    atomic_json(path, record)
                    issue = record['error']
            except Exception:
                blocked += 1
                issue = 'An outbox item needs attention; original checkpoint retained'
        atomic_json(self.directory / 'fusion-status.json', {'version':'0.6.0','updatedAt':time.time(),
                    'connected':connected,'queued':len(list(self.outbox.glob('*.json'))),'blocked':blocked,'message':issue})

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stopped.clear()
        def run():
            while not self.stopped.is_set():
                self.wake.clear()
                try:
                    self.tick()
                except Exception:
                    pass  # Evidence remains on disk even if status cannot be written.
                self.wake.wait(10)
        self.thread = threading.Thread(target=run, name='Trace delivery', daemon=True)
        self.thread.start()

    def stop(self):
        self.stopped.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=12)


def fusion_is_foreground():
    """Read window ownership only. No keyboard hook or Fusion API is used."""
    if os.name != 'nt':
        return False
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.WinDLL('user32', use_last_error=True)
        user32.GetForegroundWindow.restype = wintypes.HWND
        user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        pid = wintypes.DWORD()
        window = user32.GetForegroundWindow()
        user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
        return bool(window) and pid.value == os.getpid()
    except Exception:
        return False


class CheckpointShortcuts:
    """Watch short-lived local requests; only the callback may queue a Fusion event."""
    def __init__(self, callback, directory=None, foreground=fusion_is_foreground, clock=time.time):
        self.directory = Path(directory) if directory else bridge_dir()
        self.callback = callback
        self.foreground = foreground
        self.clock = clock
        self.started_at = clock() * 1000
        self.last_id = None
        self.stopped = threading.Event()
        self.thread = None

    def tick(self):
        now = self.clock() * 1000
        foreground = self.foreground()
        atomic_json(self.directory / 'fusion-shortcut-status.json', {
            'version': 1, 'addinVersion': '0.6.0', 'updatedAt': now,
            'foreground': foreground,
        })
        path = self.directory / 'checkpoint-request.json'
        try:
            if path.stat().st_size > 4096:
                return
            request = json.loads(path.read_text(encoding='utf-8'))
            if (not isinstance(request, dict) or request.get('version') != 1
                    or request.get('command') != 'record-checkpoint'
                    or not isinstance(request.get('id'), str)
                    or not re.fullmatch(r'[0-9a-f-]{36}', request['id'])
                    or request['id'] == self.last_id):
                return
            # Mark once before dispatch, including rejected/stale requests.
            self.last_id = request['id']
            requested = request.get('requestedAt')
            expires = request.get('expiresAt')
            if (not isinstance(requested, (int, float)) or not isinstance(expires, (int, float))
                    or not self.started_at <= requested <= now + 1000
                    or not requested < expires <= requested + 5000
                    or now > expires or not foreground):
                return
            connection = json.loads((self.directory / 'connection.json').read_text(encoding='utf-8'))
            if not request.get('instanceId') or request['instanceId'] != connection.get('instanceId'):
                return
            self.callback(request)
        except (OSError, ValueError, TypeError):
            return

    def can_dispatch(self, request, active_command, busy=False):
        # Recheck on Fusion's UI thread: the user may have moved focus, opened a
        # modeling command or left Fusion busy after the file was consumed.
        return (not busy and active_command == 'SelectCommand'
                and self.foreground() and self.clock() * 1000 <= request.get('expiresAt', 0))

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stopped.clear()
        def run():
            while not self.stopped.is_set():
                try:
                    self.tick()
                except Exception:
                    pass
                self.stopped.wait(0.25)
        self.thread = threading.Thread(target=run, name='Trace checkpoint shortcut', daemon=True)
        self.thread.start()

    def stop(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=2)
        try:
            atomic_json(self.directory / 'fusion-shortcut-status.json', {
                'version': 1, 'addinVersion': '0.6.0', 'updatedAt': 0, 'foreground': False,
            })
        except OSError:
            pass
