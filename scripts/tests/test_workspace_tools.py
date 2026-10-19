"""Isolated MCP protocol tests; no model, browser, or user documents."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SERVER = Path(__file__).resolve().parents[2] / "workbench-mcp" / "server.py"


class WorkspaceTools(unittest.TestCase):
    def test_display_tools_validate_before_reporting_success(self):
        with tempfile.TemporaryDirectory(prefix=".workspace-test-", dir=SERVER.parents[1]) as temp:
            root = Path(temp)
            workspace = root / "workspace"
            workspace.mkdir()
            (workspace / "report.md").write_text("# Fixture", encoding="utf8")
            (root / "outside.md").write_text("private", encoding="utf8")
            calls = [
                ("assemble_document", {"title": "Calculator", "description": "Fixture", "html": "<button>Reset</button>"}),
                ("assemble_document", {"html": ""}),
                ("assemble_document", {"html": "x" * 200001}),
                ("show_document", {"path": "report.md"}),
                ("show_document", {"path": "../outside.md"}),
                ("show_document", {"path": "missing.docx"}),
            ]
            requests = [{"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": args}} for i, (name, args) in enumerate(calls)]
            result = subprocess.run([sys.executable, str(SERVER)], cwd=workspace, input="\n".join(map(json.dumps, requests)) + "\n",
                                    text=True, capture_output=True, timeout=10,
                                    creationflags=0x08000000 if os.name == "nt" else 0, check=True)
            replies = [json.loads(line)["result"] for line in result.stdout.splitlines()]
            self.assertEqual(len(replies), len(calls))
            self.assertEqual([bool(r.get("isError")) for r in replies], [False, True, True, False, True, True])


class RenderUiValidation(unittest.TestCase):
    def call(self, calls):
        requests = [{"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": "render_ui", "arguments": a}} for i, a in enumerate(calls)]
        with tempfile.TemporaryDirectory(prefix=".render-ui-test-", dir=SERVER.parents[1]) as temp:
            result = subprocess.run([sys.executable, str(SERVER)], cwd=temp, input="\n".join(map(json.dumps, requests)) + "\n",
                                    text=True, capture_output=True, timeout=10,
                                    creationflags=0x08000000 if os.name == "nt" else 0, check=True)
        return [json.loads(line)["result"] for line in result.stdout.splitlines()]

    def test_render_ui_accepts_good_specs_and_rejects_bad_ones_with_fixable_messages(self):
        good = {"t": "Col", "c": ["hi", {"t": "Slider", "bind": "$x", "min": 0, "max": 9},
                                  {"t": "Tabs", "items": [{"label": "A", "c": [{"t": "Chart", "kind": "bar", "data": "=$d", "x": "m", "y": ["a"]}]}]},
                                  {"t": "Svg", "w": 10, "h": 10, "c": [{"t": "Rect", "x": 1}]}]}
        deep = {"t": "Text"}
        for _ in range(14):
            deep = {"t": "Col", "c": [deep]}
        cases = [
            ({"title": "ok", "spec": good, "state": {"x": 1}}, False, "Displayed"),
            ({"title": "ok", "spec": json.dumps(good)}, False, "Displayed"),
            ({"title": "x", "spec": {"t": "Marquee"}}, True, "unknown component 'Marquee' at spec; use one of: Col"),
            ({"title": "x", "spec": {"t": "Col", "c": [{"t": "Text"}, {"t": "Blink"}]}}, True, "spec.c[1]"),
            ({"title": "x", "spec": {"t": "Input"}}, True, "needs \"bind\""),
            ({"title": "x", "spec": {"t": "Tabs", "items": []}}, True, "Tabs"),
            ({"title": "x", "spec": {"t": "Svg", "c": [{"t": "Text"}, {"t": "Col"}]}}, True, "unknown Svg child"),
            ({"title": "x", "spec": {"t": "Col", "c": ["a" * 120000]}}, True, "100 KB"),
            ({"title": "x", "spec": deep}, True, "nesting deeper"),
            ({"title": "x", "spec": "not json"}, True, "not valid JSON"),
            ({"title": "x", "spec": {"t": "Text"}, "state": [1]}, True, "state must be an object"),
        ]
        replies = self.call([c[0] for c in cases])
        self.assertEqual(len(replies), len(cases))
        for (args, is_error, needle), reply in zip(cases, replies):
            text = reply["content"][0]["text"]
            self.assertEqual(bool(reply.get("isError")), is_error, text)
            self.assertIn(needle, text)
            if is_error:
                self.assertNotIn("\n", text.strip())


if __name__ == "__main__":
    unittest.main()
