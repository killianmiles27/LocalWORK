"""Stand-in for Strata's serve/server.py, used by run-all.ps1 so lifecycle tests do not load a 70 GB model.

Same contract as the real server (MODEL-HANDOFF.md): --engine/--config/--host/--port, STRATA_API_KEY from the
environment, public /health, protected /v1/models. It also starts a grandchild process (like Strata's engine under
its Python launcher) so the tests can prove the whole tree is killed. A config whose --native file is missing
exits with an error, which is how T-L6 ("bad gguf path") is reproduced.
"""
import argparse, http.server, json, os, subprocess, sys, threading, time

ap = argparse.ArgumentParser()
ap.add_argument("--engine")
ap.add_argument("--config")
ap.add_argument("--host", default="127.0.0.1")
ap.add_argument("--port", type=int)
a = ap.parse_args()

cfg = json.load(open(a.config, encoding="utf-8"))
args = cfg.get("args", [])
if "--native" in args:
    gguf = args[args.index("--native") + 1]
    if not os.path.exists(gguf):
        print("ERROR: model file not found: " + gguf, flush=True)
        sys.exit(2)

key = os.environ.get("STRATA_API_KEY", "")
out = os.environ.get("E2E_KEY_OUT")
if out:
    open(out, "w").write(key)  # lets T-S5 look for this exact value in the app's logs

flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
grandchild = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(36000)"], creationflags=flags)
time.sleep(float(os.environ.get("E2E_LOAD_SECONDS", "2")))  # pretend to load the model


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *x):
        pass

    def reply(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"status": "ok"})
        if self.headers.get("Authorization") != "Bearer " + key:
            return self.reply(401, {"error": "unauthorized"})
        if self.path.startswith("/v1/models"):
            return self.reply(200, {"data": [{"id": cfg.get("model_name", "stub")}]})
        return self.reply(200, {})


http.server.ThreadingHTTPServer((a.host, a.port), H).serve_forever()
