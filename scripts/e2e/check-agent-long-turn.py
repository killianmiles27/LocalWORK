"""Exercise one long JSONL turn with a local stub model and native compaction endpoint."""
import argparse
import json
import os
import pathlib
import queue
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


USER_REQUEST = "Read all six synthetic source files and summarize their distinct codes."
USER_MARKER = "LONG_TURN_USER_REQUEST_32768"
READ_COUNT = 6
SOURCE_CHARS = 20_000
WAIT_SECONDS = 50


class StubModel(BaseHTTPRequestHandler):
    def __init__(self, *args, root, **kwargs):
        self.root = root
        super().__init__(*args, **kwargs)

    records = []
    errors = []
    issued_reads = 0
    compactions = 0
    lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def _json(self, status, body):
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"capabilities": {"chat_compaction": True}})
        else:
            self._json(404, {"error": "unknown stub route"})

    def do_POST(self):
        try:
            request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            if self.path == "/v1/chat/compact":
                messages = request.get("messages")
                if not isinstance(messages, list):
                    raise AssertionError("native compaction request omitted messages")
                # Fixture metric only: intentionally deterministic, not a tokenizer claim.
                tokens = len(json.dumps(messages, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) // 4
                with self.lock:
                    type(self).compactions += 1
                    type(self).records.append({"kind": "native_compact", "at": time.monotonic(), "tokens": tokens, "messages": messages})
                self._json(200, {
                    "messages": messages,
                    "compacted": False,
                    "before_tokens": tokens,
                    "after_tokens": tokens,
                    "retained_recent_count": len(messages),
                    "summary": None,
                })
                return
            if self.path != "/v1/chat/completions":
                self._json(404, {"error": "unknown stub route"})
                return
            messages = request.get("messages", [])
            checkpoint = any(
                "Create a factual continuation checkpoint" in str(message.get("content", ""))
                for message in messages if isinstance(message, dict)
            )
            if checkpoint:
                kind = "checkpoint"
                response = {"role": "assistant", "content": "<summary>Continue the one requested six-file review. Preserve the task and all verified source findings.</summary>"}
            else:
                with self.lock:
                    index = type(self).issued_reads
                    if index < READ_COUNT:
                        type(self).issued_reads += 1
                if index < READ_COUNT:
                    kind = "read"
                    tool_name = self._read_tool_name(request.get("tools", []))
                    if not tool_name:
                        raise AssertionError("model request did not expose a Read tool with file_path")
                    call_id = f"long-turn-read-{index + 1}"
                    arguments = json.dumps({"file_path": str(self.root / f"source-{index + 1}.txt")})
                    response = {"role": "assistant", "content": None, "tool_calls": [{
                        "id": call_id,
                        "type": "function",
                        "function": {"name": tool_name, "arguments": arguments},
                    }]}
                else:
                    kind = "final"
                    response = {"role": "assistant", "content": "Reviewed all six synthetic source files and preserved the original request."}
            compact_json = json.dumps(messages, ensure_ascii=False, separators=(",", ":"))
            record = {
                "kind": kind,
                "at": time.monotonic(),
                "stream": bool(request.get("stream")),
                "max_tokens": request.get("max_tokens"),
                "fixture_prompt_tokens": len(compact_json.encode("utf-8")) // 4,
                "messages": messages,
            }
            with self.lock:
                type(self).records.append(record)
            self._completion(request, response, record["fixture_prompt_tokens"])
        except Exception as exc:
            with self.lock:
                type(self).errors.append(repr(exc))
            try:
                self._json(500, {"error": str(exc)})
            except (BrokenPipeError, ConnectionResetError):
                pass

    @staticmethod
    def _read_tool_name(tools):
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            function = tool.get("function", tool)
            if not isinstance(function, dict):
                continue
            name = function.get("name")
            schema = function.get("parameters", function.get("input_schema", {}))
            if name and str(name).lower() == "read" and isinstance(schema, dict):
                properties = schema.get("properties", {})
                required = schema.get("required", [])
                if "file_path" in properties or "file_path" in required:
                    return name
        return None

    def _completion(self, request, message, prompt_tokens):
        usage = {"prompt_tokens": prompt_tokens, "completion_tokens": 20, "total_tokens": prompt_tokens + 20}
        finish = "tool_calls" if message.get("tool_calls") else "stop"
        if not request.get("stream"):
            self._json(200, {"choices": [{"message": message, "finish_reason": finish}], "usage": usage})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        chunks = []
        if message.get("tool_calls"):
            call = message["tool_calls"][0]
            chunks.append({"choices": [{"index": 0, "delta": {"tool_calls": [{
                "index": 0,
                "id": call["id"],
                "type": "function",
                "function": call["function"],
            }]}}]})
        elif message.get("content"):
            chunks.append({"choices": [{"index": 0, "delta": {"content": message["content"]}}]})
        chunks.append({"choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": usage})
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps(chunk, separators=(",", ":")) + "\n\n").encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def pair_tool_messages(messages):
    pending = set()
    for message in messages:
        if not isinstance(message, dict):
            continue
        if message.get("role") == "assistant":
            for call in message.get("tool_calls", []) or []:
                call_id = call.get("id") if isinstance(call, dict) else None
                if not call_id or call_id in pending:
                    return False, f"missing or duplicate tool call id: {call_id!r}"
                pending.add(call_id)
        if message.get("role") == "tool":
            call_id = message.get("tool_call_id")
            if not call_id or call_id not in pending:
                return False, f"orphan tool result: {call_id!r}"
            pending.remove(call_id)
    if pending:
        return False, f"tool calls without results: {sorted(pending)}"
    return True, "paired"


def saved_compact_counts(root):
    counts = []
    for path in root.rglob("*.json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        stack = [value]
        while stack:
            current = stack.pop()
            if isinstance(current, dict):
                for key, item in current.items():
                    if key.lower() in ("compact_count", "compactcount") and isinstance(item, int):
                        counts.append((path, item))
                    else:
                        stack.append(item)
            elif isinstance(current, list):
                stack.extend(current)
    return counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", required=True, help="existing parent directory for isolated fixture artifacts")
    parser.add_argument("--agent", help="aionrs.exe path; defaults to app/vendor/aionrs.exe")
    args = parser.parse_args()
    work = pathlib.Path(args.work).resolve(strict=True)
    if not work.is_dir():
        parser.error("--work must be an existing directory")
    root = pathlib.Path(tempfile.mkdtemp(prefix="agent-long-turn-", dir=work)).resolve()
    for index in range(1, READ_COUNT + 1):
        path = root / f"source-{index}.txt"
        rows = []
        n = 0
        while sum(map(len, rows)) < SOURCE_CHARS:
            rows.append(f"Source {index} record {n:04d}: distinct evidence category {index}-{n % 17:02d}; figures {1000 + index * n}; verified fixture text.\n")
            n += 1
        path.write_text("".join(rows)[:SOURCE_CHARS], encoding="utf-8")
    (root / ".aionrs.toml").write_text(
        "[compact]\nenabled = true\ncontext_window = 32768\noutput_reserve = 1024\n"
        "autocompact_threshold_pct = 80\nautocompact_buffer = 2458\nemergency_buffer = 1638\n\n"
        "[providers.openai.compat]\nnative_compaction_path = \"/chat/compact\"\n",
        encoding="utf-8",
    )

    handler = lambda *a, **kw: StubModel(*a, root=root, **kw)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    exe = pathlib.Path(args.agent).resolve() if args.agent else pathlib.Path(__file__).resolve().parents[2] / "vendor" / "aionrs.exe"
    if not exe.is_file():
        server.shutdown()
        parser.error(f"agent executable not found: {exe}")
    env = os.environ.copy()
    isolated = root / "profile"
    for folder in ("roaming", "local", "home", "temp"):
        (isolated / folder).mkdir(parents=True, exist_ok=True)
    env.update(
        APPDATA=str(isolated / "roaming"),
        LOCALAPPDATA=str(isolated / "local"),
        USERPROFILE=str(isolated / "home"),
        HOME=str(isolated / "home"),
        TEMP=str(isolated / "temp"),
        TMP=str(isolated / "temp"),
        NO_PROXY="127.0.0.1,localhost",
        no_proxy="127.0.0.1,localhost",
    )
    proc = subprocess.Popen(
        [str(exe), "--json-stream", "--provider", "openai", "--api-key", "fixture-key", "--model", "fixture-model",
         "--base-url", f"http://127.0.0.1:{server.server_port}/v1", "--project-dir", str(root), "--max-tokens", "1024",
         "--session-id", "long-turn-fixture", "--no-color"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        env=env, cwd=root, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    events = []
    event_queue = queue.Queue()
    stderr = []

    def read_stdout():
        try:
            for line in proc.stdout:
                event = json.loads(line)
                event["_observed_at"] = time.monotonic()
                events.append(event)
                event_queue.put(event)
        except Exception as exc:
            event_queue.put({"type": "_reader_error", "message": repr(exc)})
        finally:
            event_queue.put({"type": "_eof"})

    def read_stderr():
        stderr.extend(proc.stderr.readlines())

    threading.Thread(target=read_stdout, daemon=True).start()
    threading.Thread(target=read_stderr, daemon=True).start()

    def wait_for(predicate, timeout=WAIT_SECONDS):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                event = event_queue.get(timeout=min(0.25, deadline - time.monotonic()))
            except queue.Empty:
                if proc.poll() is not None:
                    raise AssertionError(f"agent exited {proc.returncode}; stderr: {''.join(stderr)[-4000:]}")
                continue
            if event.get("type") in ("error", "_reader_error"):
                raise AssertionError(f"agent reported an error: {event}")
            if event.get("type") == "_eof":
                raise AssertionError(f"agent stdout closed; stderr: {''.join(stderr)[-4000:]}")
            if event.get("type") in ("tool_request", "tool_running"):
                call_id = event.get("call_id")
                tool = event.get("tool", {})
                if not call_id:
                    if event.get("type") == "tool_request":
                        raise AssertionError(f"tool request omitted call_id: {event}")
                else:
                    tool_name = tool.get("name") or event.get("tool_name", "")
                    if tool_name.lower() != "read":
                        raise AssertionError(f"unexpected fixture tool: {tool_name}")
                    if event.get("type") == "tool_request":
                        proc.stdin.write(json.dumps({"type": "tool_approve", "call_id": call_id, "scope": "once"}) + "\n")
                        proc.stdin.flush()
            if predicate(event):
                return event
        raise AssertionError("timed out waiting for agent event")

    try:
        ready = wait_for(lambda event: event.get("type") == "ready")
        if ready.get("version") != "0.2.11":
            raise AssertionError(f"unexpected agent version: {ready}")
        proc.stdin.write(json.dumps({"type": "message", "msg_id": "long-turn-request", "content": f"{USER_REQUEST} {USER_MARKER}"}) + "\n")
        proc.stdin.flush()
        wait_for(lambda event: event.get("type") == "stream_end" and event.get("msg_id") == "long-turn-request")
        time.sleep(0.2)

        compaction_notices = [event for event in events if event.get("type") == "info" and event.get("message", "").startswith("Autocompact:")]
        if not compaction_notices:
            raise AssertionError("no automatic compaction notice occurred")
        if StubModel.issued_reads != READ_COUNT:
            raise AssertionError(f"expected {READ_COUNT} Read calls, observed {StubModel.issued_reads}")
        read_events = [event for event in events if event.get("type") in ("tool_request", "tool_running") and (event.get("tool", {}).get("name") or event.get("tool_name", "")).lower() == "read"]
        result_events = [event for event in events if event.get("type") == "tool_result"]
        request_ids = [event.get("call_id") for event in read_events]
        result_ids = [event.get("call_id") for event in result_events]
        if request_ids != result_ids or len(request_ids) != READ_COUNT:
            raise AssertionError(f"tool call/result IDs did not pair in order: {request_ids!r} vs {result_ids!r}")

        records = list(StubModel.records)
        checkpoint_records = [record for record in records if record.get("kind") == "checkpoint"]
        if not checkpoint_records:
            raise AssertionError("the streaming continuation-checkpoint path was not exercised")
        final_records = [record for record in records if record.get("kind") == "final"]
        compact_records = [record for record in records if record.get("kind") == "native_compact"]
        if not compact_records or not final_records or final_records[-1]["at"] <= compact_records[-1]["at"]:
            raise AssertionError("normal final generation did not continue after native checkpoint validation")
        if final_records[-1]["at"] <= compaction_notices[0]["_observed_at"]:
            raise AssertionError("normal model generation did not continue after the automatic compaction notice")
        if len([record for record in records if record.get("kind") == "read"]) != READ_COUNT:
            raise AssertionError("model did not return all six read rounds")
        paired, detail = pair_tool_messages(final_records[-1]["messages"])
        if not paired:
            raise AssertionError(f"tool-call/result groups were not paired in the final request: {detail}")
        final_users = [str(message.get("content", "")) for message in final_records[-1]["messages"] if message.get("role") == "user"]
        if not any(USER_MARKER in content for content in final_users):
            raise AssertionError("original user request was missing from the final model request")
        if StubModel.errors:
            raise AssertionError(f"stub server errors: {StubModel.errors}")
        if any("context" in str(event).lower() and event.get("type") == "error" for event in events):
            raise AssertionError("context error occurred")
        compact_counts = saved_compact_counts(root)
        if not compact_counts or max(value for _, value in compact_counts) < 1:
            raise AssertionError(f"saved compact count was not at least one: {compact_counts}")

        (root / "events.json").write_text(json.dumps(events, indent=2), encoding="utf-8")
        (root / "requests.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
        (root / "stderr.txt").write_text("".join(stderr), encoding="utf-8")
        print(json.dumps({
            "status": "PASS",
            "agent_version": ready.get("version"),
            "read_rounds": StubModel.issued_reads,
            "automatic_compactions": len(compaction_notices),
            "streaming_checkpoints": len(checkpoint_records),
            "native_checkpoint_validations": len(compact_records),
            "saved_compact_count": max(value for _, value in compact_counts),
            "final_prompt_fixture_tokens": final_records[-1]["fixture_prompt_tokens"],
            "artifact": str(root),
        }, indent=2))
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
        server.shutdown()
        server.server_close()
        (root / "events.json").write_text(json.dumps(events, indent=2), encoding="utf-8")
        (root / "requests.json").write_text(json.dumps(StubModel.records, indent=2), encoding="utf-8")
        (root / "stderr.txt").write_text("".join(stderr), encoding="utf-8")


if __name__ == "__main__":
    main()
