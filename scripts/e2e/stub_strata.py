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
ap.add_argument("--fit-max-tokens", action="store_true")
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
        if self.path == "/status":
            return self.reply(200, {"tokens_per_s": 23.5})
        if self.path == "/v1/status":
            return self.reply(200, {"last_timings": {"predicted_per_second": 21.0}})
        return self.reply(200, {})

    def do_POST(self):
        if self.headers.get("Authorization") != "Bearer " + key:
            return self.reply(401, {"error": "unauthorized"})
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        if self.path == "/v1/chat/completions" and request.get("stream"):
            print("Fixture authenticated streaming chat: /v1/chat/completions", flush=True)
        if not request.get("stream"):
            return self.reply(200, {"choices": [{"message": {"role": "assistant", "content": "Fixture reply"}, "finish_reason": "stop"}]})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        user_messages = [m for m in request.get("messages", []) if m.get("role") == "user"]
        slow = bool(user_messages) and "E2E_STOP_STREAM" in json.dumps(user_messages[-1])
        print(f"Fixture completion: slow={slow}", flush=True)
        try:
            for _ in range(300 if slow else 1):
                chunk = {"choices": [{"index": 0, "delta": {"content": "Fixture reply"}}]}
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                self.wfile.flush()
                if slow:
                    time.sleep(.1)
            final = {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 3, "total_tokens": 103}}
            self.wfile.write(('data: ' + json.dumps(final) + '\n\ndata: [DONE]\n\n').encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


http.server.ThreadingHTTPServer((a.host, a.port), H).serve_forever()
