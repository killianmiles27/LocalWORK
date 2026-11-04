#!/usr/bin/env python3
"""DEV ONLY: an OpenAI-compatible bridge to a ChatGPT Codex subscription.

LocalWORK normally talks to Strata on loopback. This script lets a developer point the
app at a local OpenAI-compatible endpoint backed by the Codex subscription already signed
in on this PC, so UI and agent work can be tested without loading a local model.

    python scripts/dev/codex_bridge.py --port 18080

It is not packaged, not started by release builds, and it sends prompts to OpenAI. Treat
it as a development tool only. Credentials are read from %USERPROFILE%\\.codex\\auth.json
(or ~/.codex/auth.json); nothing is written, refreshed, or logged.

Endpoints: GET /health, GET /v1/models, GET/POST /settings, POST /v1/chat/completions.
Streaming chat completions and tool calls are supported.
"""
from __future__ import annotations

import argparse
import base64
import http.client
import json
import os
import random
import ssl
import string
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
OPENAI_URL = "https://api.openai.com/v1/responses"
USER_AGENT = "codex_cli_rs/0.166.0"

STATE = {
    "effort": "low",
    "last_tps": None,
    "model": "gpt-6-luna",
}
STATE_LOCK = threading.Lock()


class BridgeError(Exception):
    """An error that maps to an HTTP status and a safe, human-readable message."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# -------------------------------------------------------------------------------------- credentials


def default_auth_path() -> str:
    home = os.path.expanduser("~")
    return os.path.join(home, ".codex", "auth.json")


def jwt_claims(token: str) -> dict:
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    pad = "=" * (-len(parts[1]) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(parts[1] + pad))
    except Exception:
        return {}


def load_credentials(path: str) -> dict:
    """Return {'token', 'account_id', 'api_key', 'kind'} without ever printing secrets."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        raise BridgeError(503, f"No Codex login found at {path}. Sign in with the Codex CLI (`codex login`) first.")
    except Exception as exc:
        raise BridgeError(503, f"Could not read the Codex login at {path}: {exc}")

    tokens = data.get("tokens") or {}
    token = (tokens.get("access_token") or "").strip()
    account = (tokens.get("account_id") or "").strip()
    api_key = (data.get("OPENAI_API_KEY") or "").strip()
    if token:
        claims = jwt_claims(token)
        exp = claims.get("exp")
        if isinstance(exp, (int, float)) and exp < time.time() - 30:
            raise BridgeError(401, "The Codex login has expired. Open Codex (or run `codex login`) once, then retry.")
        return {"token": token, "account_id": account, "api_key": "", "kind": "chatgpt"}
    if api_key:
        return {"token": api_key, "account_id": "", "api_key": api_key, "kind": "openai"}
    raise BridgeError(503, "The Codex login file has no usable token. Run `codex login` and retry.")


# ---------------------------------------------------------------------------------------- translation


def text_of(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for part in content:
            if isinstance(part, str):
                out.append(part)
            elif isinstance(part, dict):
                if part.get("type") in (None, "text", "input_text", "output_text"):
                    out.append(str(part.get("text") or ""))
                elif part.get("type") == "image_url":
                    # Kept out of the text channel; handled by content_parts().
                    continue
        return "".join(out)
    return str(content)


def content_parts(content, assistant: bool = False) -> list:
    """Translate OpenAI message content into Responses API input content."""
    parts = []
    if isinstance(content, str):
        parts.append({"type": "output_text" if assistant else "input_text", "text": content})
        return parts
    if isinstance(content, list):
        for part in content:
            if isinstance(part, str):
                parts.append({"type": "output_text" if assistant else "input_text", "text": part})
                continue
            if not isinstance(part, dict):
                continue
            kind = part.get("type")
            if kind == "image_url":
                image = part.get("image_url")
                url = image.get("url") if isinstance(image, dict) else image
                if url:
                    parts.append({"type": "input_image", "image_url": url})
            else:
                text = part.get("text")
                if text:
                    parts.append({"type": "output_text" if assistant else "input_text", "text": str(text)})
    if not parts:
        parts.append({"type": "output_text" if assistant else "input_text", "text": ""})
    return parts


def translate_tools(tools) -> list:
    out = []
    for tool in tools or []:
        if not isinstance(tool, dict):
            continue
        if tool.get("type") != "function":
            continue
        fn = tool.get("function") if isinstance(tool.get("function"), dict) else tool
        name = fn.get("name")
        if not name:
            continue
        item = {
            "type": "function",
            "name": name,
            "description": fn.get("description") or "",
            "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
            "strict": False,
        }
        out.append(item)
    return out


def translate_tool_choice(choice):
    if choice in (None, "auto"):
        return "auto"
    if choice in ("none", "required"):
        return choice
    if isinstance(choice, dict):
        fn = choice.get("function") or choice
        name = fn.get("name")
        if name:
            return {"type": "function", "name": name}
    return "auto"


def build_payload(body: dict, model: str, default_effort: str) -> dict:
    instructions = []
    items = []
    for message in body.get("messages") or []:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if role in ("system", "developer"):
            text = text_of(content).strip()
            if text:
                instructions.append(text)
        elif role == "user":
            items.append({"type": "message", "role": "user", "content": content_parts(content)})
        elif role == "assistant":
            text = text_of(content)
            if text:
                items.append({"type": "message", "role": "assistant", "content": content_parts(text, assistant=True)})
            for call in message.get("tool_calls") or []:
                if not isinstance(call, dict):
                    continue
                fn = call.get("function") or {}
                if not fn.get("name"):
                    continue
                items.append({
                    "type": "function_call",
                    "call_id": call.get("id") or "call_" + rand_id(18),
                    "name": fn["name"],
                    "arguments": fn.get("arguments") or "{}",
                })
        elif role in ("tool", "function"):
            call_id = message.get("tool_call_id") or message.get("name") or "call_unknown"
            items.append({"type": "function_call_output", "call_id": call_id, "output": text_of(content)})

    if not items:
        items.append({"type": "message", "role": "user", "content": [{"type": "input_text", "text": ""}]})

    payload = {
        "model": model,
        "input": items,
        "stream": True,
        "store": False,
        "parallel_tool_calls": bool(body.get("parallel_tool_calls", True)),
        "tool_choice": translate_tool_choice(body.get("tool_choice")),
        "reasoning": {"effort": (body.get("reasoning_effort") or default_effort or "low"), "summary": "auto"},
    }
    if instructions:
        payload["instructions"] = "\n\n".join(instructions)
    tools = translate_tools(body.get("tools"))
    if tools:
        payload["tools"] = tools
    limit = body.get("max_completion_tokens") or body.get("max_tokens")
    if isinstance(limit, int) and limit > 0:
        payload["max_output_tokens"] = limit
    return payload


def rand_id(n: int = 24) -> str:
    return "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(n))


# ------------------------------------------------------------------------------------------ upstream


class Upstream:
    """One streaming request to the Codex (or OpenAI) Responses API."""

    def __init__(self, creds: dict, payload: dict):
        self.creds = creds
        self.payload = payload
        self.conn = None
        self.response = None
        self.text = []
        self.reasoning = []
        self.calls: list[dict] = []
        self.usage = {}
        self.status = "completed"

    def open(self):
        payload = dict(self.payload)
        if self.creds["kind"] == "chatgpt":
            host, path = "chatgpt.com", "/backend-api/codex/responses"
            headers = {
                "Authorization": "Bearer " + self.creds["token"],
                "chatgpt-account-id": self.creds["account_id"],
                "OpenAI-Beta": "responses=experimental",
                "originator": "codex_cli_rs",
                "session_id": str(random.randint(10000000, 99999999)),
            }
        else:
            host, path = "api.openai.com", "/v1/responses"
            headers = {"Authorization": "Bearer " + self.creds["token"]}
        headers.update({
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "User-Agent": USER_AGENT,
            "Connection": "keep-alive",
        })
        self.conn = http.client.HTTPSConnection(host, 443, timeout=600, context=ssl.create_default_context())
        try:
            self.conn.request("POST", path, body=json.dumps(payload), headers=headers)
            self.response = self.conn.getresponse()
        except Exception as exc:
            raise BridgeError(502, f"Could not reach the Codex backend: {exc}")
        if self.response.status != 200:
            raw = self.response.read().decode("utf-8", "replace")
            message = raw
            try:
                parsed = json.loads(raw)
                message = (parsed.get("error") or {}).get("message") or parsed.get("message") or raw
            except Exception:
                pass
            if self.response.status in (401, 403):
                raise BridgeError(401, "Codex rejected the login. Open Codex (or run `codex login`) once, then retry.")
            if self.response.status == 429:
                raise BridgeError(429, "The Codex subscription is rate limited or out of quota. Wait a moment and retry.")
            raise BridgeError(502, f"Codex answered HTTP {self.response.status}: {str(message)[:300]}")

    def events(self):
        """Yield decoded SSE event dicts from the upstream response."""
        while True:
            line = self.response.readline()
            if not line:
                return
            line = line.strip()
            if not line or line.startswith(b":"):
                continue
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                return
            try:
                yield json.loads(data)
            except Exception:
                continue


# ---------------------------------------------------------------------------------------- bridge API


def error_body(message: str, kind: str = "upstream_error", code: str | None = None) -> dict:
    return {"error": {"message": message, "type": kind, "code": code}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LocalWORKCodexBridge/0.1"
    sys_version = ""

    def log_message(self, fmt, *args):
        # Never log request bodies or headers: they can carry prompts and tokens.
        sys.stderr.write("[bridge] " + (fmt % args) + "\n")

    # -- helpers -------------------------------------------------------------------------
    def send_json(self, status: int, body: dict):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            value = json.loads(raw)
        except Exception:
            raise BridgeError(400, "The request body is not valid JSON.")
        if not isinstance(value, dict):
            raise BridgeError(400, "The request body must be a JSON object.")
        return value

    def authorized(self) -> bool:
        expected = self.server.api_key  # type: ignore[attr-defined]
        if not expected:
            return True
        got = self.headers.get("Authorization") or ""
        return got == "Bearer " + expected

    def host_ok(self) -> bool:
        """Only accept requests addressed to the loopback listener (blocks DNS-rebinding pages)."""
        port = self.server.server_address[1]  # type: ignore[attr-defined]
        host = (self.headers.get("Host") or "").strip().lower()
        return host in (f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}")

    # -- routes --------------------------------------------------------------------------
    def do_GET(self):
        if not self.host_ok():
            return self.send_json(400, error_body("Wrong Host header.", "bad_request"))
        path = urllib.parse.urlparse(self.path).path
        if path == "/health":
            body = {"status": "ok", "bridge": "localwork-codex", "model": STATE["model"], "max_context": self.server.context}  # type: ignore[attr-defined]
            return self.send_json(200, body)
        if path == "/v1/models":
            if not self.authorized():
                return self.send_json(401, error_body("Missing or wrong API key.", "auth_error"))
            model = {"id": STATE["model"], "object": "model", "created": int(time.time()), "owned_by": "openai"}
            return self.send_json(200, {"object": "list", "data": [model]})
        if path == "/settings":
            if not self.authorized():
                return self.send_json(401, error_body("Missing or wrong API key.", "auth_error"))
            return self.send_json(200, {"defaults": {"reasoning_effort": STATE["effort"]}})
        if path in ("/status", "/v1/status"):
            tps = STATE["last_tps"]
            return self.send_json(200, {"tokens_per_s": tps, "last_timings": {"predicted_per_second": tps}})
        return self.send_json(404, error_body("Unknown endpoint.", "not_found"))

    def do_POST(self):
        if not self.host_ok():
            return self.send_json(400, error_body("Wrong Host header.", "bad_request"))
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/settings":
                if not self.authorized():
                    return self.send_json(401, error_body("Missing or wrong API key.", "auth_error"))
                body = self.read_json()
                defaults = body.get("defaults") or {}
                effort = defaults.get("reasoning_effort") if isinstance(defaults, dict) else None
                if effort in ("none", "minimal", "low", "medium", "high", "xhigh"):
                    STATE["effort"] = effort
                return self.send_json(200, {"ok": True, "defaults": {"reasoning_effort": STATE["effort"]}})
            if path != "/v1/chat/completions":
                return self.send_json(404, error_body("Unknown endpoint.", "not_found"))
            if not self.authorized():
                return self.send_json(401, error_body("Missing or wrong API key.", "auth_error"))
            body = self.read_json()
            self.chat(body)
        except BridgeError as exc:
            self.send_json(exc.status, error_body(exc.message))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as exc:  # Keep the bridge alive on unexpected failures.
            sys.stderr.write(f"[bridge] unhandled error: {type(exc).__name__}: {exc}\n")
            self.send_json(500, error_body("The dev Codex bridge hit an unexpected error. See its console."))

    # -- chat completions ----------------------------------------------------------------
    def chat(self, body: dict):
        stream = bool(body.get("stream"))
        creds = load_credentials(self.server.auth_path)  # type: ignore[attr-defined]
        payload = build_payload(body, STATE["model"], STATE["effort"])
        upstream = Upstream(creds, payload)
        upstream.open()

        completion_id = "chatcmpl-" + rand_id(20)
        created = int(time.time())
        model = body.get("model") or STATE["model"]

        if not stream:
            calls, text, reasoning, finish, usage = consume(upstream)
            message = {"role": "assistant", "content": text or None}
            if reasoning:
                message["reasoning_content"] = reasoning
            if calls:
                message["tool_calls"] = [{
                    "id": c["id"], "type": "function",
                    "function": {"name": c["name"], "arguments": c["arguments"]},
                } for c in calls]
            out = {
                "id": completion_id, "object": "chat.completion", "created": created, "model": model,
                "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": usage,
            }
            return self.send_json(200, out)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        write_lock = threading.Lock()
        stop = threading.Event()

        def emit(obj: dict):
            with write_lock:
                self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode())
                self.wfile.flush()

        def keepalive():
            while not stop.wait(15):
                try:
                    with write_lock:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                except Exception:
                    return

        threading.Thread(target=keepalive, daemon=True).start()

        def chunk(delta: dict, finish=None):
            emit({
                "id": completion_id, "object": "chat.completion.chunk", "created": created, "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            })

        index_of: dict[str, int] = {}
        arg_seen: dict[str, int] = {}
        started = time.time()
        output_tokens = 0
        try:
            chunk({"role": "assistant", "content": ""})
            for event in upstream.events():
                kind = event.get("type")
                if kind == "response.output_text.delta":
                    delta = event.get("delta") or ""
                    if delta:
                        chunk({"content": delta})
                elif kind in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta"):
                    delta = event.get("delta") or ""
                    if delta:
                        chunk({"reasoning_content": delta})
                elif kind == "response.output_item.added":
                    item = event.get("item") or {}
                    if item.get("type") == "function_call":
                        index = len(index_of)
                        key = item.get("id") or item.get("call_id") or f"call_{index}"
                        index_of[key] = index
                        arg_seen[key] = 0
                        chunk({"tool_calls": [{
                            "index": index,
                            "id": item.get("call_id") or item.get("id") or rand_id(18),
                            "type": "function",
                            "function": {"name": item.get("name") or "", "arguments": ""},
                        }]})
                elif kind == "response.function_call_arguments.delta":
                    key = event.get("item_id") or ""
                    index = index_of.get(key)
                    if index is None:
                        # Some servers omit output_item.added; start the call lazily.
                        index = len(index_of)
                        index_of[key] = index
                        chunk({"tool_calls": [{
                            "index": index, "id": "call_" + rand_id(18), "type": "function",
                            "function": {"name": event.get("name") or "", "arguments": ""},
                        }]})
                    delta = event.get("delta") or ""
                    if delta:
                        arg_seen[key] = arg_seen.get(key, 0) + len(delta)
                        chunk({"tool_calls": [{"index": index, "function": {"arguments": delta}}]})
                elif kind == "response.output_item.done":
                    item = event.get("item") or {}
                    if item.get("type") == "function_call":
                        key = item.get("id") or item.get("call_id") or ""
                        index = index_of.get(key)
                        args = item.get("arguments") or ""
                        if index is not None and args and arg_seen.get(key, 0) == 0:
                            chunk({"tool_calls": [{"index": index, "function": {"arguments": args}}]})
                elif kind == "response.completed":
                    response = event.get("response") or {}
                    usage = response.get("usage") or {}
                    output_tokens = int(usage.get("output_tokens") or 0)
                    self.record_usage(usage)
                elif kind == "response.incomplete":
                    upstream.status = "incomplete"
                elif kind in ("response.failed", "error"):
                    response = event.get("response") or event
                    err = response.get("error") or response
                    message = err.get("message") if isinstance(err, dict) else str(err)
                    emit({"error": {"message": message or "The model request failed.", "type": "upstream_error"}})
                    break

            elapsed = max(time.time() - started, 0.001)
            if output_tokens:
                with STATE_LOCK:
                    STATE["last_tps"] = round(output_tokens / elapsed, 1)
            finish = "length" if upstream.status == "incomplete" else ("tool_calls" if index_of else "stop")
            chunk({}, finish)
            emit({"id": completion_id, "object": "chat.completion.chunk", "created": created, "model": model,
                  "choices": [], "usage": self.openai_usage(upstream.usage)})
            with write_lock:
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            stop.set()
            try:
                upstream.conn.close()
            except Exception:
                pass

    def record_usage(self, usage: dict):
        self.upstream_usage = usage  # type: ignore[attr-defined]

    def openai_usage(self, usage: dict) -> dict:
        usage = usage or getattr(self, "upstream_usage", {}) or {}
        prompt = int(usage.get("input_tokens") or 0)
        completion = int(usage.get("output_tokens") or 0)
        return {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": int(usage.get("total_tokens") or prompt + completion),
        }


def consume(upstream: Upstream):
    """Drain a stream into a non-streaming completion."""
    calls: dict[int, dict] = {}
    text: list[str] = []
    reasoning: list[str] = []
    finish = "stop"
    usage = {}
    for event in upstream.events():
        kind = event.get("type")
        if kind == "response.output_text.delta":
            text.append(event.get("delta") or "")
        elif kind in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta"):
            reasoning.append(event.get("delta") or "")
        elif kind == "response.output_item.added":
            item = event.get("item") or {}
            if item.get("type") == "function_call":
                calls[len(calls)] = {
                    "id": item.get("call_id") or item.get("id") or "call_" + rand_id(18),
                    "name": item.get("name") or "",
                    "arguments": item.get("arguments") or "",
                }
        elif kind == "response.function_call_arguments.delta":
            if calls:
                calls[max(calls)]["arguments"] += event.get("delta") or ""
        elif kind == "response.completed":
            usage = (event.get("response") or {}).get("usage") or {}
        elif kind == "response.incomplete":
            finish = "length"
        elif kind in ("response.failed", "error"):
            err = (event.get("response") or event).get("error") or {}
            raise BridgeError(502, err.get("message") or "The model request failed.")
    if calls:
        finish = "tool_calls"
    prompt = int(usage.get("input_tokens") or 0)
    completion = int(usage.get("output_tokens") or 0)
    return (
        list(calls.values()),
        "".join(text),
        "".join(reasoning),
        finish,
        {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": int(usage.get("total_tokens") or prompt + completion)},
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Dev-only OpenAI-compatible bridge to a ChatGPT Codex subscription.")
    ap.add_argument("--host", default="127.0.0.1", help="Bind address (loopback only by default).")
    ap.add_argument("--port", type=int, default=18080, help="Port to listen on.")
    ap.add_argument("--model", default="gpt-6-luna", help="Model id passed to the Codex backend.")
    ap.add_argument("--effort", default="low", choices=["none", "minimal", "low", "medium", "high", "xhigh"],
                    help="Default reasoning effort. The app can change it with POST /settings.")
    ap.add_argument("--context", type=int, default=131072, help="Context window reported on /health.")
    ap.add_argument("--auth", default=default_auth_path(), help="Path to the Codex auth.json.")
    ap.add_argument("--api-key", default=os.environ.get("CODEX_BRIDGE_KEY", ""),
                    help="Require this bearer token (or set CODEX_BRIDGE_KEY). Empty accepts any key.")
    args = ap.parse_args()

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        sys.stderr.write("The bridge only binds loopback. Use --host 127.0.0.1.\n")
        return 2

    STATE["model"] = args.model
    STATE["effort"] = args.effort

    try:
        creds = load_credentials(args.auth)
    except BridgeError as exc:
        sys.stderr.write(f"[bridge] {exc.message}\n")
        return 1
    if creds["kind"] == "chatgpt" and not creds["account_id"]:
        sys.stderr.write("[bridge] The Codex login has no account id. Run `codex login` again.\n")
        return 1

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    server.auth_path = args.auth            # type: ignore[attr-defined]
    server.api_key = args.api_key           # type: ignore[attr-defined]
    server.context = args.context           # type: ignore[attr-defined]
    print(f"[bridge] listening on http://{args.host}:{args.port} model={args.model} effort={args.effort} "
          f"context={args.context} backend={creds['kind']}", flush=True)
    print("[bridge] DEV ONLY: prompts are sent to OpenAI through the Codex subscription.", flush=True)
    if not server.api_key:  # type: ignore[attr-defined]
        print("[bridge] WARNING: no API key; any local process can use this endpoint until you stop it.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[bridge] stopped", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
