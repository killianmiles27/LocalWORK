#!/usr/bin/python3
"""Exercise the packaged desktop and existing deterministic Strata fixture under Xvfb.

Run inside dbus-run-session and xvfb-run with python3-pyatspi installed.
"""
from collections import deque
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request

import pyatspi

ROOT = Path(__file__).resolve().parents[2]
CHAT_MARKER = 'Fixture authenticated streaming chat: /v1/chat/completions'


def descendants(node):
    yield node
    try:
        for child in node:
            yield from descendants(child)
    except Exception:
        # WebKit can replace accessibility nodes while React renders.
        return


def find_control(name):
    for node in descendants(pyatspi.Registry.getDesktop(0)):
        try:
            if node.name == name and node.getState().contains(pyatspi.STATE_SHOWING):
                return node
        except Exception:
            continue
    return None


def wait_for(label, predicate, processes, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        for name, process in processes:
            if process.poll() is not None:
                raise RuntimeError(f'{name} exited with {process.returncode} while waiting for {label}')
        try:
            value = predicate()
            if value:
                return value
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(.25)
    raise TimeoutError(f'timed out waiting for {label}')


def main(appimage):
    with tempfile.TemporaryDirectory(prefix='localwork-linux-smoke-') as tmp:
        work = Path(tmp)
        data = work / 'data' / 'Workbench'
        processes = []
        try:
            data.mkdir(parents=True)
            config = work / 'model.json'
            config.write_text(json.dumps({'model_name': 'stub-model', 'args': []}))
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            (data / 'settings.json').write_text(json.dumps({
                'modelSource': 'server', 'serverPort': str(port), 'serverKey': 'fixture-key',
                'workbenchPython': os.environ.get('LOCALWORK_SMOKE_PYTHON', sys.executable),
            }))
            with sqlite3.connect(data / 'workbench.db') as db:
                db.execute('CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)')
                db.executemany('INSERT INTO kv VALUES (?, ?)', [('wizard_done', '1'), ('offline', '1')])
            env = {**os.environ, 'HOME': str(work), 'XDG_DATA_HOME': str(work / 'data'),
                   'XDG_CONFIG_HOME': str(work / 'config'), 'XDG_CACHE_HOME': str(work / 'cache'),
                   'STRATA_API_KEY': 'fixture-key', 'E2E_LOAD_SECONDS': '0',
                   'APPIMAGE_EXTRACT_AND_RUN': '1', 'LIBGL_ALWAYS_SOFTWARE': '1',
                   'WEBKIT_DISABLE_COMPOSITING_MODE': '1', 'ACCESSIBILITY_ENABLED': '1'}
            with (work / 'stub.log').open('w') as stub_log, (work / 'app.log').open('w') as app_log:
                stub = subprocess.Popen([sys.executable, '-u', str(ROOT / 'scripts/e2e/stub_strata.py'),
                                         '--config', str(config), '--host', '127.0.0.1', '--port', str(port)],
                                        env=env, stdout=stub_log, stderr=subprocess.STDOUT, start_new_session=True)
                processes.append(('stub', stub))
                wait_for('stub health', lambda: urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1).status == 200, processes)
                app = subprocess.Popen([appimage], env=env, stdout=app_log, stderr=subprocess.STDOUT, start_new_session=True)
                processes.append(('AppImage', app))
                wait_for('visible Message field', lambda: find_control('Message'), processes)
                # The WebKit textarea is visible through AT-SPI but does not expose EditableText.
                # Use its screen bounds to click and type real X11 keyboard events instead.
                wait_for('model-ready Send button', lambda: find_control('Send'), processes)
                message = wait_for('visible Message field after model readiness', lambda: find_control('Message'), processes)
                window = wait_for('visible LocalWORK X11 window', lambda: subprocess.run(
                    ['xdotool', 'search', '--onlyvisible', '--name', '^LocalWORK$'],
                    capture_output=True, text=True, timeout=5).stdout.splitlines() or None, processes)[-1]
                bounds = message.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                if bounds.width <= 0 or bounds.height <= 0 or bounds.x < 0 or bounds.y < 0:
                    raise RuntimeError(f'invalid Message field bounds: {bounds}')
                subprocess.run(['xdotool', 'windowfocus', '--sync', window], check=True, timeout=5)
                subprocess.run(['xdotool', 'mousemove', '--sync', str(bounds.x + bounds.width // 2),
                                str(bounds.y + bounds.height // 2), 'click', '1'], check=True, timeout=5)
                subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '1',
                                'Hello from the Linux smoke test'], check=True, timeout=10)
                wait_for('enabled Send button after typing', lambda: (button if (button := find_control('Send')) and button.getState().contains(pyatspi.STATE_ENABLED) else None), processes)
                subprocess.run(['xdotool', 'key', '--clearmodifiers', 'Return'], check=True, timeout=5)
                wait_for('authenticated streaming chat request to stub', lambda: CHAT_MARKER in (work / 'stub.log').read_text(), processes)
                print('Packaged app displayed the composer and sent a chat request to the stub.', flush=True)
        except Exception:
            traceback.print_exc()
            for name in ('app.log', 'stub.log'):
                path = work / name
                print(f'--- {name} (last 100 lines) ---', file=sys.stderr)
                if path.exists():
                    with path.open(errors='replace') as log:
                        print(''.join(deque(log, maxlen=100)), file=sys.stderr)
                else:
                    print('(not created)', file=sys.stderr)
            logs = data / 'logs'
            if logs.exists():
                for path in logs.glob('*.log'):
                    print(f'--- {path.name} ---\n{path.read_text(errors="replace")}', file=sys.stderr)
            raise
        finally:
            for _, process in reversed(processes):
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            for _, process in reversed(processes):
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: linux-smoke.py /path/to/LocalWORK.AppImage')
    main(str(Path(sys.argv[1]).resolve()))
