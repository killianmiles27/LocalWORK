"""Exercise bounded agent recovery and real OfficeCLI artifact creation without a model server."""
import argparse
import json
import os
import pathlib
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.etree import ElementTree


WAIT_SECONDS = 55
TASK_MARKER = "RECOVERY_FIXTURE_BUDGET_REPORT"
PLAN_STEPS = [
    {"text": "Create the synthetic summary workbook and chart", "status": "todo"},
    {"text": "Write the report with explicit assumptions", "status": "todo"},
    {"text": "Verify both deliverables", "status": "todo"},
]
XLSX_COMMANDS = [
    {"command": "set", "path": "/Sheet1/A1", "props": {"value": "Category"}},
    {"command": "set", "path": "/Sheet1/B1", "props": {"value": "Monthly units"}},
    {"command": "set", "path": "/Sheet1/A2", "props": {"value": "Rent"}},
    {"command": "set", "path": "/Sheet1/B2", "props": {"value": 1200}},
    {"command": "set", "path": "/Sheet1/A3", "props": {"value": "Food"}},
    {"command": "set", "path": "/Sheet1/B3", "props": {"value": 450}},
    {"command": "set", "path": "/Sheet1/A4", "props": {"value": "Transit"}},
    {"command": "set", "path": "/Sheet1/B4", "props": {"value": 120}},
    {"command": "set", "path": "/Sheet1/A5", "props": {"value": "Total"}},
    {"command": "set", "path": "/Sheet1/B5", "props": {"formula": "SUM(B2:B4)"}},
    {"command": "add", "parent": "/Sheet1", "type": "chart",
     "props": {"chartType": "column", "dataRange": "Sheet1!A1:B4", "title": "Synthetic monthly budget", "anchor": "D2:J18"}},
]
REPORT_TEXT = (
    "Synthetic budget report",
    "Assumptions: all figures are invented monthly units; no currency is specified or implied.",
    "Rent is 1200 units, food is 450 units, and transit is 120 units per month.",
    "Total monthly spending is 1770 units, calculated by the workbook formula.",
)


class StubModel(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if self.path == "/v1/chat/compact":
            messages = request.get("messages", [])
            self._json(200, {"messages": messages, "compacted": False,
                             "before_tokens": 100, "after_tokens": 100,
                             "retained_recent_count": len(messages), "summary": None})
            return
        with self.server.lock:
            step = self.server.step
            self.server.step += 1
            self.server.requests.append({"step": step, "messages": request.get("messages", [])})
        tool_index = self._find_tool(request.get("tools", []))
        scenario = self.server.scenario

        if step == 0:
            response = self._tool_call(tool_index, "ToolSearch", {"query": "update_plan"}, "search-plan")
        elif step == 1:
            response = self._tool_call(tool_index, "ToolSearch", {"query": "officecli"}, "search-officecli")
        elif step == 2:
            response = self._tool_call(tool_index, "update_plan", {"steps": PLAN_STEPS}, "plan-open")
        elif scenario == "always-truncated" and step in (3, 4, 5):
            self._send_truncated(request, repeated=False)
            return
        elif scenario in ("output-limit", "repeated-reasoning") and step == 3:
            self._send_truncated(request, repeated=scenario == "repeated-reasoning")
            return
        else:
            response = self._action_for_step(step, tool_index, scenario)
        if response.get("tool_calls"):
            function = response["tool_calls"][0]["function"]
            with self.server.lock:
                self.server.issued_tools.append({"name": function["name"], "arguments": json.loads(function["arguments"])})
        self._send_completion(request, response)

    @staticmethod
    def _find_tool(tools):
        for index, tool in enumerate(tools):
            function = tool.get("function", tool)
            if isinstance(function, dict):
                yield index, function.get("name", "")

    def _tool_call(self, tool_index, wanted, arguments, call_id):
        matches = [(index, name) for index, name in tool_index if name == wanted or name.rsplit("__", 1)[-1] == wanted]
        if not matches:
            return {"role": "assistant", "content": f"fixture could not find tool {wanted}"}
        index, name = matches[0]
        return {"role": "assistant", "content": None, "tool_calls": [{
            "id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)},
        }]}

    def _action_for_step(self, step, tool_index, scenario):
        if scenario == "unfinished-plan":
            if step == 7:
                return {"role": "assistant", "content": "Artifacts are ready; finishing the original request."}
            if 3 <= step <= 6:
                step += 1
        actions = {
            4: ("officecli", {"args": ["create", "summary.xlsx"]}, "create-xlsx"),
            5: ("officecli", {"args": ["batch", "summary.xlsx"], "commands": XLSX_COMMANDS}, "fill-xlsx"),
            6: ("officecli", {"args": ["create", "report.docx"]}, "create-docx"),
            7: ("officecli", {"args": ["batch", "report.docx"], "commands": [
                {"command": "add", "parent": "/body", "type": "paragraph",
                 "props": {"text": text, "firstLineIndent": "0.5in"}}
                for text in REPORT_TEXT
            ]}, "write-docx"),
            8: ("officecli", {"args": ["verify", "summary.xlsx"]}, "verify-xlsx"),
            9: ("officecli", {"args": ["verify", "report.docx"]}, "verify-docx"),
            10: ("officecli", {"args": ["close", "summary.xlsx"]}, "close-xlsx"),
            11: ("officecli", {"args": ["close", "report.docx"]}, "close-docx"),
        }
        if step == 12:
            return self._tool_call(tool_index, "update_plan", {
                "steps": [{"text": item["text"], "status": "done"} for item in PLAN_STEPS]
            }, "plan-done")
        if step == 13:
            return {"role": "assistant", "content": "The workbook and report are complete and verified."}
        wanted, arguments, call_id = actions.get(step, (None, None, None))
        return self._tool_call(tool_index, wanted, arguments, call_id) if wanted else {
            "role": "assistant", "content": "The workbook and report are complete and verified."
        }

    def _send_completion(self, request, message):
        finish = "tool_calls" if message.get("tool_calls") else "stop"
        usage = {"prompt_tokens": 400, "completion_tokens": 20, "total_tokens": 420}
        if not request.get("stream"):
            self._json(200, {"choices": [{"message": message, "finish_reason": finish}], "usage": usage})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        delta = {"tool_calls": [{"index": 0, "id": message["tool_calls"][0]["id"], "type": "function",
                                  "function": message["tool_calls"][0]["function"]}]} if message.get("tool_calls") else {"content": message.get("content", "")}
        chunks = [{"choices": [{"index": 0, "delta": delta}]},
                  {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": usage,
                   "timings": {"prompt_n": 400, "prompt_ms": 1.2, "predicted_n": 20, "predicted_ms": 4.0, "predicted_per_second": 5000, "cache_n": 0}}]
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps(chunk, separators=(",", ":")) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _send_truncated(self, request, repeated):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        chunks = []
        if repeated:
            thought = "Reconsider the same plan instead of executing the next step. " * 30
            chunks.extend({"choices": [{"index": 0, "delta": {"reasoning_content": thought}}]} for _ in range(6))
        else:
            chunks.append({"choices": [{"index": 0, "delta": {"content": "The report is still being prepared."}}]})
        chunks.append({"choices": [{"index": 0, "delta": {}, "finish_reason": "length"}],
                       "usage": {"prompt_tokens": 400, "completion_tokens": 512, "total_tokens": 912}})
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps(chunk, separators=(",", ":")) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _json(self, status, body):
        data = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def run_scenario(args, scenario, root):
    case = root / scenario
    case.mkdir()
    if scenario == "repeated-reasoning":
        (case / ".aionrs.toml").write_text(
            '[providers.openai.compat]\nnative_compaction_path = "/chat/compact"\n', encoding="utf-8")
    server = ThreadingHTTPServer(("127.0.0.1", 0), StubModel)
    server.scenario = scenario
    server.step = 0
    server.lock = threading.Lock()
    server.requests = []
    server.issued_tools = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    agent = pathlib.Path(args.agent).resolve() if args.agent else pathlib.Path(__file__).resolve().parents[2] / "vendor" / "aionrs.exe"
    if not agent.is_file():
        server.shutdown()
        raise FileNotFoundError(f"agent executable not found: {agent}")
    python = str(pathlib.Path(args.python).resolve(strict=True))
    officecli = str(pathlib.Path(args.officecli).resolve(strict=True))
    env = os.environ.copy()
    profile = case / "profile"
    for folder in ("roaming", "local", "home", "temp", "cache"):
        (profile / folder).mkdir(parents=True, exist_ok=True)
    env.update(APPDATA=str(profile / "roaming"), LOCALAPPDATA=str(profile / "local"),
               USERPROFILE=str(profile / "home"), HOME=str(profile / "home"), TEMP=str(profile / "temp"), TMP=str(profile / "temp"),
               WORKBENCH_DATA=str(profile / "cache"), WORKBENCH_DB=str(profile / "cache" / "fixture.db"),
               OFFICECLI_EXE=officecli, NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
    mcp_script = pathlib.Path(__file__).resolve().parents[2] / "workbench-mcp" / "server.py"
    proc = subprocess.Popen(
        [str(agent), "--json-stream", "--provider", "openai", "--api-key", "fixture-key", "--model", "fixture-model",
         "--base-url", f"http://127.0.0.1:{server.server_port}/v1", "--project-dir", str(case),
         "--max-turns", "40", "--max-tokens", "1024", "--no-color"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        env=env, cwd=case, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    events, event_queue, stderr = [], queue.Queue(), []

    def read_stdout():
        try:
            for line in proc.stdout:
                event = json.loads(line)
                events.append(event)
                event_queue.put(event)
        except Exception as exc:
            event_queue.put({"type": "_reader_error", "error": repr(exc)})
        finally:
            event_queue.put({"type": "_eof"})

    threading.Thread(target=read_stdout, daemon=True).start()
    threading.Thread(target=lambda: stderr.extend(proc.stderr.readlines()), daemon=True).start()

    def send(value):
        proc.stdin.write(json.dumps(value) + "\n")
        proc.stdin.flush()

    def wait_for(predicate, seconds=WAIT_SECONDS):
        deadline = time.monotonic() + min(seconds, 60)
        while time.monotonic() < deadline:
            try:
                event = event_queue.get(timeout=min(0.25, deadline - time.monotonic()))
            except queue.Empty:
                if proc.poll() is not None:
                    raise AssertionError(f"agent exited {proc.returncode}: {''.join(stderr)[-3000:]}")
                continue
            if event.get("type") in ("error", "_reader_error", "_eof"):
                raise AssertionError(f"agent ended unexpectedly: {event}; {''.join(stderr)[-3000:]}")
            if event.get("type") == "tool_request":
                send({"type": "tool_approve", "call_id": event["call_id"], "scope": "once"})
            if predicate(event):
                return event
        raise AssertionError(f"timed out after {seconds}s waiting for agent event")

    try:
        ready = wait_for(lambda event: event.get("type") == "ready")
        send({"type": "add_mcp_server", "name": "workbench", "transport": "stdio", "command": python,
              "args": ["-u", str(mcp_script)], "env": {"OFFICECLI_EXE": officecli, "WORKBENCH_DATA": str(profile / "cache"),
              "WORKBENCH_DB": str(profile / "cache" / "fixture.db")}})
        wait_for(lambda event: event.get("type") == "mcp_ready")
        send({"type": "message", "msg_id": f"recovery-{scenario}",
              "content": f"{TASK_MARKER}: create summary.xlsx with formula and chart plus report.docx. Use only synthetic monthly budget data (rent 1200, food 450, transit 120), explicitly say units and no currency is specified. Make a plan and verify both deliverables."})
        wait_for(lambda event: event.get("type") == "stream_end" and event.get("msg_id") == f"recovery-{scenario}")
        metrics = [json.loads(event["message"].removeprefix("Request metrics: ")) for event in events
                   if event.get("type") == "info" and str(event.get("message", "")).startswith("Request metrics: ")]
        if not any("request_wall_ms" in metric for metric in metrics):
            raise AssertionError("rebuilt agent did not emit per-request wall/token diagnostics")
        if not any(metric.get("phase") == "provider_timing" and metric.get("timings", {}).get("prompt_ms") == 1.2 for metric in metrics):
            raise AssertionError("rebuilt agent discarded provider-reported prompt/decode timings")
        if args.keep:
            (case / "events.json").write_text(json.dumps(events, indent=2), encoding="utf-8")
            (case / "model-requests.json").write_text(json.dumps(server.requests, indent=2), encoding="utf-8")
        notices = [str(event.get("message", "")) for event in events if event.get("type") == "info"
                   and ("Generation recovery:" in str(event.get("message", ""))
                        or "Run incomplete:" in str(event.get("message", "")))]
        incomplete = [str(event.get("message", "")) for event in events if "Run incomplete" in str(event)]
        if scenario == "always-truncated":
            recovery_count = sum("Generation recovery:" in notice for notice in notices)
            if recovery_count != 2 or not incomplete:
                raise AssertionError(f"expected two bounded generation recoveries and an incomplete-run notice; events={events[-15:]}")
            if (case / "summary.xlsx").exists() or (case / "report.docx").exists():
                raise AssertionError("always-truncated fixture unexpectedly created deliverables")
        else:
            expected_notice = {
                "output-limit": "Generation recovery: response output limit reached",
                "repeated-reasoning": "Generation recovery: repeated reasoning detected",
                "unfinished-plan": "Generation recovery: the plan has unfinished work",
            }.get(scenario)
            if expected_notice and not any(expected_notice in notice for notice in notices):
                raise AssertionError(f"expected recovery notice {expected_notice!r}; observed: {notices}")
            verify_deliverables(case, events, server.issued_tools)
        return {"scenario": scenario, "agent_version": ready.get("version"), "notices": notices,
                "tool_results": sum(event.get("type") == "tool_result" for event in events),
                "artifacts": sorted(path.name for pattern in ("*.xlsx", "*.docx") for path in case.glob(pattern))}
    finally:
        try:
            if proc.poll() is None:
                send({"type": "stop"})
                proc.wait(timeout=8)
        except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
        server.shutdown()
        server.server_close()


def verify_deliverables(case, events, issued_tools):
    workbook, report = case / "summary.xlsx", case / "report.docx"
    if not workbook.is_file() or not report.is_file():
        raise AssertionError(f"missing deliverable(s): {workbook.exists()=}, {report.exists()=}")
    with zipfile.ZipFile(workbook) as archive:
        names = set(archive.namelist())
        if not any(name.endswith("/charts/chart1.xml") for name in names):
            raise AssertionError("workbook ZIP has no embedded chart")
        sheet = archive.read("xl/worksheets/sheet1.xml").decode("utf-8")
        if "SUM(B2:B4)" not in sheet:
            raise AssertionError("workbook does not contain the expected total formula")
    with zipfile.ZipFile(report) as archive:
        document = ElementTree.fromstring(archive.read("word/document.xml"))
        words = " ".join(node.text or "" for node in document.iter() if node.tag.endswith("}t"))
        for required in ("Synthetic budget report", "no currency is specified or implied", "1770 units"):
            if required not in words:
                raise AssertionError(f"report is missing required text {required!r}: {words}")
    completed = [event for event in events if event.get("type") == "tool_result"
                 and str(event.get("tool_name", "")).rsplit("__", 1)[-1] == "update_plan"]
    plan_updates = [item for item in issued_tools if item["name"].rsplit("__", 1)[-1] == "update_plan"]
    if not completed or not plan_updates:
        raise AssertionError("no completed update_plan tool result was observed")
    statuses = [step.get("status") for step in plan_updates[-1]["arguments"].get("steps", [])]
    if len(statuses) != len(PLAN_STEPS) or any(status != "done" for status in statuses):
        raise AssertionError(f"final plan update did not mark every step done: {statuses}")
    tool_names = [item["name"].rsplit("__", 1)[-1] for item in issued_tools]
    for filename in ("summary.xlsx", "report.docx"):
        verify = [i for i, item in enumerate(issued_tools) if item["name"].rsplit("__", 1)[-1] == "officecli"
                  and item["arguments"].get("args") == ["verify", filename]]
        close = [i for i, item in enumerate(issued_tools) if item["name"].rsplit("__", 1)[-1] == "officecli"
                 and item["arguments"].get("args") == ["close", filename]]
        plan_done = [i for i, item in enumerate(issued_tools) if item["name"].rsplit("__", 1)[-1] == "update_plan"
                     and all(step.get("status") == "done" for step in item["arguments"].get("steps", []))]
        if not verify or not close or not plan_done or not verify[-1] < close[-1] < plan_done[-1]:
            raise AssertionError(f"expected OfficeCLI verify then close for {filename} before final plan update; calls={tool_names}")
    verification_results = [event for event in events if event.get("type") == "tool_result"
                            and str(event.get("tool_name", "")).rsplit("__", 1)[-1] == "officecli"
                            and ("Verification commands completed" in str(event.get("output", ""))
                                 or "Verification bundle FAILED" in str(event.get("output", "")))]
    if len(verification_results) < 2:
        summary = [(event.get("tool_name"), str(event.get("output", ""))[:140])
                   for event in events if event.get("type") == "tool_result"]
        raise AssertionError(f"OfficeCLI did not return verification bundles for both files: {summary}")
    for event in verification_results[-2:]:
        output = str(event.get("output", ""))
        if "Verification commands completed" not in output or "FAILED" in output or "INCOMPLETE" in output:
            raise AssertionError(f"OfficeCLI verification reported a failure: {output}")
        if "Found 0 issue(s):" not in output:
            raise AssertionError(f"OfficeCLI reported document issues: {output}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", required=True, help="existing parent directory for isolated fixture runs")
    parser.add_argument("--python", required=True, help="Python runtime used to launch workbench-mcp")
    parser.add_argument("--officecli", required=True, help="bundled OfficeCLI executable")
    parser.add_argument("--agent", help="aionrs executable; defaults to app/vendor/aionrs.exe")
    parser.add_argument("--scenario", action="append", choices=("output-limit", "repeated-reasoning", "always-truncated", "unfinished-plan"),
                        help="scenario to run; repeat the option to select a subset (default: output-limit)")
    parser.add_argument("--keep", action="store_true", help="preserve isolated fixture outputs")
    args = parser.parse_args()
    parent = pathlib.Path(args.work).resolve(strict=True)
    if not parent.is_dir():
        parser.error("--work must be an existing directory")
    scenarios = args.scenario or ["output-limit"]
    root = pathlib.Path(tempfile.mkdtemp(prefix="agent-recovery-", dir=parent)).resolve()
    if root.parent != parent:
        raise RuntimeError(f"fixture directory escaped requested parent: {root}")
    results = []
    try:
        for scenario in scenarios:
            results.append(run_scenario(args, scenario, root))
        print(json.dumps({"status": "PASS", "scenarios": results, "fixture_root": str(root) if args.keep else "removed"}, indent=2))
    finally:
        if not args.keep:
            if root.parent != parent:
                raise RuntimeError(f"refusing to remove fixture outside requested parent: {root}")
            last_error = None
            for attempt in range(6):
                try:
                    shutil.rmtree(root)
                    last_error = None
                    break
                except PermissionError as exc:
                    last_error = exc
                    time.sleep(0.2 * (attempt + 1))
            if last_error is not None:
                raise RuntimeError(f"fixture files remain locked under {root}: {last_error}") from last_error


if __name__ == "__main__":
    main()
