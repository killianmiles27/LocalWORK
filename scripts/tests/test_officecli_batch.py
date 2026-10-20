"""Focused tests for inline OfficeCLI batch forwarding."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SERVER = Path(__file__).resolve().parents[2] / "workbench-mcp" / "server.py"
SPEC = importlib.util.spec_from_file_location("workbench_server_batch", SERVER)
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class OfficeCliBatch(unittest.TestCase):
    def test_inline_commands_are_serialized_without_a_scratch_file(self):
        commands = [{"command": "set", "path": "/Sheet1/A1", "props": {"value": "Name"}}]
        with patch.object(server.subprocess, "run", return_value=type("Result", (), {"stdout": "ok", "stderr": "", "returncode": 0})()) as office:
            result = server.call_tool("officecli", {"args": ["batch", "sheet.xlsx"], "commands": commands})

        self.assertEqual(result, "ok")
        argv = office.call_args.args[0]
        self.assertEqual(argv[1:3], ["batch", "sheet.xlsx"])
        self.assertEqual(argv[3], "--commands")
        self.assertEqual(json.loads(argv[4]), commands)
        self.assertEqual(argv[-1], "--json")

    def test_batch_returns_counts_instead_of_cell_logs(self):
        payload = {"success": True, "data": {"results": [
            {"index": i, "success": True, "output": f"Updated /Sheet1/A{i}: value=x"}
            for i in range(1, 41)
        ], "summary": {"total": 40, "executed": 40, "succeeded": 40, "failed": 0, "skipped": 0}}}
        result = type("Result", (), {"stdout": json.dumps(payload), "stderr": "", "returncode": 0})()
        with patch.object(server.subprocess, "run", return_value=result) as office:
            output = server.call_tool("officecli", {"args": ["batch", "sheet.xlsx"]})
        self.assertIn("40/40 operations succeeded", output)
        self.assertNotIn("Updated /Sheet1", output)
        self.assertIn("--json", office.call_args.args[0])

    def test_batch_failure_keeps_first_operation_and_error(self):
        payload = {"success": False, "data": {"results": [
            {"index": 18, "success": False, "error": "Sheet not found: Nope", "item": {"command": "set", "path": "/Nope/A1"}}
        ], "summary": {"total": 25, "executed": 25, "succeeded": 24, "failed": 1, "skipped": 0}}}
        result = type("Result", (), {"stdout": json.dumps(payload), "stderr": "", "returncode": 1})()
        with patch.object(server.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, r"24/25 succeeded.*operation 19 \(/Nope/A1\).*Sheet not found: Nope"):
                server.call_tool("officecli", {"args": ["batch", "sheet.xlsx"]})

    def test_legacy_input_argument_still_passes_through(self):
        with patch.object(server.subprocess, "run", return_value=type("Result", (), {"stdout": "ok", "stderr": "", "returncode": 0})()) as office:
            server.call_tool("officecli", {"args": ["batch", "sheet.xlsx", "--input", "build.json"]})

        self.assertEqual(office.call_args.args[0][1:], ["batch", "sheet.xlsx", "--input", "build.json", "--json"])

    def test_inline_commands_require_batch_target_and_object_array(self):
        with self.assertRaisesRegex(ValueError, "paired"):
            server.call_tool("officecli", {"args": ["view", "sheet.xlsx"], "commands": [{"command": "set"}]})
        with self.assertRaisesRegex(ValueError, "command objects"):
            server.call_tool("officecli", {"args": ["batch", "sheet.xlsx"], "commands": ["set"]})

    def test_large_batch_uses_workspace_temp_file_and_preserves_unicode(self):
        commands = [{"command": "set", "path": "/Sheet1/A1", "props": {"value": "€雪", "note": "x" * server.MAX_INLINE_COMMANDS_UTF16_UNITS}}]
        with tempfile.TemporaryDirectory() as workspace, patch.object(server.os, "getcwd", return_value=workspace):
            def run(argv, **kwargs):
                input_arg = argv[argv.index("--input") + 1]
                temp_file = Path(workspace) / input_arg
                self.assertTrue(temp_file.is_file())
                self.assertEqual(json.loads(temp_file.read_text(encoding="utf-8")), commands)
                self.assertEqual(Path(input_arg).parts[0], ".localwork-tmp")
                return type("Result", (), {"stdout": "ok", "stderr": "", "returncode": 0})()

            with patch.object(server.subprocess, "run", side_effect=run):
                self.assertEqual(server.call_tool("officecli", {"args": ["batch", "sheet.xlsx"], "commands": commands}), "ok")

            self.assertFalse((Path(workspace) / ".localwork-tmp").exists())

    def test_large_batch_temp_file_is_removed_when_cli_fails(self):
        commands = [{"command": "set", "path": "/Sheet1/A1", "props": {"value": "x" * server.MAX_INLINE_COMMANDS_UTF16_UNITS}}]
        for failure in (type("Result", (), {"stdout": "", "stderr": "bad batch", "returncode": 1})(), OSError("CLI unavailable")):
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as workspace, patch.object(server.os, "getcwd", return_value=workspace):
                temp_paths = []

                def run(argv, **kwargs):
                    path = Path(workspace) / argv[argv.index("--input") + 1]
                    self.assertTrue(path.is_file())
                    temp_paths.append(path)
                    if isinstance(failure, Exception):
                        raise failure
                    return failure

                with patch.object(server.subprocess, "run", side_effect=run):
                    with self.assertRaises((RuntimeError, OSError)):
                        server.call_tool("officecli", {"args": ["batch", "sheet.xlsx"], "commands": commands})

                self.assertTrue(temp_paths)
                self.assertFalse(temp_paths[0].exists())
                self.assertFalse((Path(workspace) / ".localwork-tmp").exists())


if __name__ == "__main__":
    unittest.main()
