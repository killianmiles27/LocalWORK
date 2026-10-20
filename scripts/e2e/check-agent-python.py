"""Run bounded Python ExecCommand smoke checks through aionrs JSONL and a local model stub."""
import argparse
import json
import os
import pathlib
import queue
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


WAIT_SECONDS = 12
CALLS = [
    ("print", "print('agent_python_print_ok')"),
    ("stdlib", "import json, pathlib; print(json.dumps({'stdlib': pathlib.Path('.').name}))"),
    ("missing_module", "import localwork_module_that_does_not_exist"),
]


class StubModel(BaseHTTPRequestHandler):
    called = set()
    lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        latest_user = next((str(message.get("content", "")) for message in reversed(request.get("messages", []))
                            if message.get("role") == "user"), "")
        kind = next((name for name, _code in CALLS if name in latest_user), None)
        tools = request.get("tools", [])
        exec_tool = next((tool for tool in tools if
                          (tool.get("function", tool).get("name", "")).lower() == "execcommand"), None)
        with self.lock:
            issue_tool = kind in {name for name, _code in CALLS} and kind not in type(self).called
            if issue_tool:
                type(self).called.add(kind)
        if issue_tool and exec_tool:
            name = exec_tool.get("function", exec_tool).get("name")
            python, code = self.server.python, dict(CALLS)[kind]
            if os.name == "nt":
                quote_ps = lambda value: "'" + value.replace("'", "''") + "'"
                command = f"& {quote_ps(python)} -c {quote_ps(code)}"
            else:
                command = f"{shlex.quote(python)} -c {shlex.quote(code)}"
            arguments = {"cmd": command, "timeout": 5000}
            if os.name == "nt":
                arguments["shell"] = "powershell"
            message = {"role": "assistant", "content": None, "tool_calls": [{
                "id": f"python-smoke-{kind}", "type": "function",
                "function": {"name": name, "arguments": json.dumps(arguments)},
            }]}
        else:
            message = {"role": "assistant", "content": "Python smoke checks completed."}
        finish = "tool_calls" if message.get("tool_calls") else "stop"
        if not request.get("stream"):
            data = json.dumps({"choices": [{"message": message, "finish_reason": finish}]}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if message.get("tool_calls"):
            call = message["tool_calls"][0]
            delta = {"tool_calls": [{"index": 0, "id": call["id"], "type": "function", "function": call["function"]}]}
        else:
            delta = {"content": message.get("content", "")}
        chunks = [{"choices": [{"index": 0, "delta": delta}]},
                  {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}]
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps(chunk, separators=(",", ":")) + "\n\n").encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, help="Python executable to exercise")
    parser.add_argument("--work", required=True, help="existing parent directory for isolated fixture artifacts")
    parser.add_argument("--agent", help="aionrs executable; defaults to app/vendor/aionrs.exe")
    parser.add_argument("--keep", action="store_true", help="preserve isolated fixture artifacts")
    args = parser.parse_args()
    work = pathlib.Path(args.work).resolve(strict=True)
    if not work.is_dir():
        parser.error("--work must be an existing directory")
    python = str(pathlib.Path(args.python).resolve(strict=True))
    root = pathlib.Path(tempfile.mkdtemp(prefix="agent-python-", dir=work)).resolve()
    server = ThreadingHTTPServer(("127.0.0.1", 0), StubModel)
    server.python = python
    threading.Thread(target=server.serve_forever, daemon=True).start()
    agent = pathlib.Path(args.agent).resolve() if args.agent else pathlib.Path(__file__).resolve().parents[2] / "vendor" / "aionrs.exe"
    if not agent.is_file():
        server.shutdown()
        parser.error(f"agent executable not found: {agent}")
    env = os.environ.copy()
    isolated = root / "profile"
    for folder in ("roaming", "local", "home", "temp"):
        (isolated / folder).mkdir(parents=True, exist_ok=True)
    env.update(APPDATA=str(isolated / "roaming"), LOCALAPPDATA=str(isolated / "local"),
               USERPROFILE=str(isolated / "home"), HOME=str(isolated / "home"),
               TEMP=str(isolated / "temp"), TMP=str(isolated / "temp"),
               NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
    proc = subprocess.Popen(
        [str(agent), "--json-stream", "--provider", "openai", "--api-key", "fixture-key",
         "--model", "fixture-model", "--base-url", f"http://127.0.0.1:{server.server_port}/v1",
         "--project-dir", str(root), "--max-tokens", "512", "--no-color"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", env=env, cwd=root,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    events, event_queue, stderr = [], queue.Queue(), []

    def read_stdout():
        for line in proc.stdout:
            event = json.loads(line)
            events.append(event)
            event_queue.put(event)
        event_queue.put({"type": "_eof"})

    threading.Thread(target=read_stdout, daemon=True).start()
    threading.Thread(target=lambda: stderr.extend(proc.stderr.readlines()), daemon=True).start()

    def wait_for(predicate):
        deadline = time.monotonic() + WAIT_SECONDS
        while time.monotonic() < deadline:
            try:
                event = event_queue.get(timeout=0.2)
            except queue.Empty:
                if proc.poll() is not None:
                    raise AssertionError(f"agent exited {proc.returncode}: {''.join(stderr)[-3000:]}")
                continue
            if event.get("type") in ("error", "_eof"):
                raise AssertionError(f"agent ended unexpectedly: {event}; {''.join(stderr)[-3000:]}")
            if event.get("type") == "tool_request":
                proc.stdin.write(json.dumps({"type": "tool_approve", "call_id": event["call_id"], "scope": "once"}) + "\n")
                proc.stdin.flush()
            if predicate(event):
                return event
        raise AssertionError("timed out waiting for bounded agent Python smoke event")

    try:
        ready = wait_for(lambda event: event.get("type") == "ready")
        if ready.get("version") != "0.2.11":
            raise AssertionError(f"unexpected agent version: {ready}")
        for index, (kind, _code) in enumerate(CALLS):
            msg_id = f"python-{kind}"
            prompt = f"Use ExecCommand exactly once to run Python smoke case {kind}."
            proc.stdin.write(json.dumps({"type": "message", "msg_id": msg_id, "content": prompt}) + "\n")
            proc.stdin.flush()
            wait_for(lambda event: event.get("type") == "stream_end" and event.get("msg_id") == msg_id)
            results = [event for event in events if event.get("type") == "tool_result"]
            if len(results) <= index:
                raise AssertionError(f"case {kind} produced no ExecCommand result")
            content = str(results[index].get("output", ""))
            status = str(results[index].get("status", ""))
            if kind == "print" and ("Exit code: 0" not in content or "agent_python_print_ok" not in content):
                raise AssertionError(f"Python print did not complete: {content}")
            if kind == "stdlib" and ("Exit code: 0" not in content or '"stdlib"' not in content):
                raise AssertionError(f"Python standard-library script did not complete: {content}")
            if kind == "missing_module" and ("No module named" not in content or "timed out" in content.lower() or "error" not in status.lower()):
                raise AssertionError(f"missing import should fail promptly with its Python error: {content}; status={status}")
        print(json.dumps({"status": "PASS", "version": ready["version"], "cases": [name for name, _ in CALLS],
                          "artifacts": str(root) if args.keep else "removed"}, indent=2))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)
        server.shutdown()
        if not args.keep:
            if root.parent != work:
                raise RuntimeError(f"refusing to remove fixture outside requested parent: {root}")
            shutil.rmtree(root)


if __name__ == "__main__":
    main()
