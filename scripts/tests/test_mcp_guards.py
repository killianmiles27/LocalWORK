"""Tests for structured refusals and the workspace_info preflight."""
import importlib.util
import json
import os
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

SERVER = Path(__file__).resolve().parents[2] / "workbench-mcp" / "server.py"
SPEC = importlib.util.spec_from_file_location("workbench_server_guards", SERVER)
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class StructuredRefusals(unittest.TestCase):
    def test_third_identical_call_is_a_structured_refusal(self):
        args = {"query": "guard-test-unique"}
        with patch.object(server, "call_tool", return_value="result") as tool:
            first = server.guarded_call("memory_search", args)
            second = server.guarded_call("memory_search", args)
            third = server.guarded_call("memory_search", args)
        self.assertEqual(first, "result")
        self.assertTrue(second.startswith("Note:"))
        body = json.loads(third)
        self.assertEqual(body["error_code"], "repeated_call")
        self.assertIs(body["write_performed"], False)
        self.assertIs(body["retryable"], False)
        self.assertEqual(tool.call_count, 2)

    def test_unknown_tool_raises_structured_refusal(self):
        with self.assertRaises(ValueError) as ctx:
            server.call_tool("no_such_tool", {})
        self.assertEqual(json.loads(str(ctx.exception))["error_code"], "unknown_tool")


class WorkspaceInfoPreflight(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        old = os.getcwd()
        os.chdir(self.tmp.name)
        self.addCleanup(os.chdir, old)

    def test_missing_command_is_not_found(self):
        out = server.call_tool("workspace_info", {"commands": ["definitely-not-a-real-cmd-xyz"]})
        self.assertIn("definitely-not-a-real-cmd-xyz: not found", out)

    def test_officecli_uses_bundled_path(self):
        with patch.object(server, "OFFICECLI", "C:/bundle/officecli.exe"):
            out = server.call_tool("workspace_info", {"commands": ["officecli"]})
        self.assertIn("found at C:/bundle/officecli.exe", out)

    def test_paths_existing_missing_and_outside(self):
        Path("out.txt").write_text("hello")
        out = server.call_tool("workspace_info", {"paths": ["out.txt", "nope.docx", "../escape.txt"]})
        lines = out.splitlines()
        self.assertIn("path out.txt: exists, 5 bytes, modified ", lines[0])
        self.assertEqual(lines[1], "path nope.docx: missing")
        self.assertIn("outside the workspace", lines[2])

    def test_no_params_lists_files(self):
        self.assertEqual(server.call_tool("workspace_info", {}), "(empty workspace)")
        Path("a.txt").write_text("x")
        self.assertIn("a.txt  1 bytes", server.call_tool("workspace_info", {}))


if __name__ == "__main__":
    unittest.main()
