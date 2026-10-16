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


if __name__ == "__main__":
    unittest.main()
