"""Cross-chat memory is off: tools/list must not offer memory tools, and calls to them are refused."""
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SERVER = Path(__file__).resolve().parents[2] / "workbench-mcp" / "server.py"


def load_server():
    """Import server.py with a scripted stdin, so its JSON-RPC loop returns instead of reading the terminal."""
    stdin = io.StringIO(
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}) + "\n"
        + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}) + "\n"
    )
    stdout = io.StringIO()
    spec = importlib.util.spec_from_file_location("workbench_server_memory", SERVER)
    module = importlib.util.module_from_spec(spec)
    with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout):
        spec.loader.exec_module(module)
    replies = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
    return module, {r["id"]: r for r in replies}


class MemoryToolsRemoved(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server, cls.replies = load_server()

    def test_tools_list_has_no_memory_tools(self):
        tools = self.replies[2]["result"]["tools"]
        names = [t["name"] for t in tools]
        self.assertEqual([n for n in names if n.startswith("memory")], [])
        for removed in ("memory_save", "memory_search", "memory_forget"):
            self.assertNotIn(removed, names)

    def test_tools_list_is_still_usable(self):
        names = [t["name"] for t in self.replies[2]["result"]["tools"]]
        for expected in ("officecli", "web_search", "web_fetch", "workspace_info"):
            self.assertIn(expected, names)
        for tool in self.replies[2]["result"]["tools"]:
            self.assertIn("description", tool)
            self.assertIn("inputSchema", tool)

    def test_dispatcher_refuses_removed_tools(self):
        for removed in ("memory_save", "memory_search", "memory_forget"):
            with self.subTest(tool=removed), self.assertRaises(ValueError) as ctx:
                self.server.call_tool(removed, {"text": "x", "query": "x", "id": 1})
            body = json.loads(str(ctx.exception))
            self.assertEqual(body["error_code"], "tool_removed")
            self.assertIs(body["write_performed"], False)
            self.assertIn("cross-chat memory is switched off", body["message"])

    def test_removed_tools_are_not_treated_as_idempotent(self):
        self.assertNotIn("memory_search", self.server.IDEMPOTENT)


if __name__ == "__main__":
    unittest.main()
