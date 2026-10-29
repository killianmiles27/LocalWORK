"""Contract checks for the deterministic desktop model fixture."""
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
                    request = urllib.request.Request(url + '/v1/chat/completions', data=json.dumps({'messages': [{'role': 'user', 'content': 'hello'}]}).encode(), headers={'Authorization': 'Bearer fixture-key', 'Content-Type': 'application/json'})
                    with urllib.request.urlopen(request, timeout=5) as response:
                        self.assertEqual(json.load(response)['choices'][0]['message']['content'], 'Fixture reply')
                    output.seek(0)
                    self.assertIn('Fixture chat request: /v1/chat/completions', output.read())
                finally:
                    if os.name == 'nt':
                        subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)], check=False, capture_output=True)
                    else:
                        os.killpg(proc.pid, signal.SIGTERM)
                    proc.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
