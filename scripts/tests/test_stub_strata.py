"""Contract checks for the deterministic desktop model fixture."""
import ast
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request


class StubStrataTest(unittest.TestCase):
    def test_authenticated_chat_is_logged(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'model.json'
            config.write_text(json.dumps({'model_name': 'stub-model', 'args': []}))
            log = Path(tmp) / 'stub.log'
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            env = {**os.environ, 'STRATA_API_KEY': 'fixture-key', 'E2E_LOAD_SECONDS': '0'}
            with log.open('w+') as output:
                proc = subprocess.Popen([sys.executable, '-u', 'scripts/e2e/stub_strata.py', '--config', str(config), '--port', str(port)], stdout=output, stderr=subprocess.STDOUT, env=env, start_new_session=os.name != 'nt')
                try:
                    url = f'http://127.0.0.1:{port}'
                    for _ in range(100):
                        try:
                            urllib.request.urlopen(url + '/health', timeout=1).close()
                            break
                        except (OSError, urllib.error.URLError):
                            time.sleep(.05)
                    # Read the exact marker used by the smoke harness without importing pyatspi.
                    tree = ast.parse(Path('scripts/e2e/linux-smoke.py').read_text())
                    markers = [ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                               and any(isinstance(target, ast.Name) and target.id == 'CHAT_MARKER' for target in node.targets)]
                    self.assertEqual(len(markers), 1, 'smoke harness must define CHAT_MARKER')
                    marker = markers[0]
                    self.assertTrue(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                                        and node.func.id == 'wait_for' and any(
                                            isinstance(child, ast.Name) and child.id == 'CHAT_MARKER'
                                            for child in ast.walk(node)) for node in ast.walk(tree)),
                                    'smoke harness must wait for CHAT_MARKER')
                    body = json.dumps({'stream': True, 'messages': [{'role': 'user', 'content': 'hello'}]}).encode()
                    def request(key, path='/v1/chat/completions'):
                        return urllib.request.Request(url + path, data=body, headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
                    with self.assertRaises(urllib.error.HTTPError) as denied:
                        urllib.request.urlopen(request('wrong-key'), timeout=5)
                    self.assertEqual(denied.exception.code, 401)
                    denied.exception.close()
                    output.seek(0)
                    self.assertNotIn(marker, output.read())
                    # A different endpoint must not satisfy the chat assertion either.
                    with urllib.request.urlopen(request('fixture-key', '/other'), timeout=5) as response:
                        response.read()
                    output.seek(0)
                    self.assertNotIn(marker, output.read())
                    with urllib.request.urlopen(request('fixture-key'), timeout=5) as response:
                        self.assertIn(b'Fixture reply', response.read())
                    output.seek(0)
                    logged = output.read()
                    self.assertIn(marker, logged)
                    self.assertNotIn('fixture-key', logged)
                finally:
                    if os.name == 'nt':
                        subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)], check=False, capture_output=True)
                    else:
                        os.killpg(proc.pid, signal.SIGTERM)
                    proc.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
