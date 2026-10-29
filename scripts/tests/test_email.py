"""Email export tests use only synthetic messages and the MCP protocol."""
import json
import mailbox
import os
from email.message import EmailMessage
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SERVER = Path(__file__).resolve().parents[2] / "workbench-mcp" / "server.py"


class EmailTools(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()

    def call(self, arguments):
        request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "read_email", "arguments": arguments}}
        result = subprocess.run([sys.executable, str(SERVER)], cwd=self.workspace, input=json.dumps(request) + "\n", text=True, capture_output=True, check=True, timeout=15)
        return json.loads(result.stdout)["result"]

    def read(self, **args):
        result = self.call(args)
        self.assertFalse(result.get("isError"), result)
        return json.loads(result["content"][0]["text"])

    def message(self, subject="Plans", sender="Alice <alice@example.test>", body="Hello team"):
        msg = EmailMessage()
        msg["From"] = sender
        msg["To"] = "Bob <bob@example.test>"
        msg["Cc"] = "Carol <carol@example.test>"
        msg["Date"] = "Tue, 01 Jul 2025 12:00:00 +0000"
        msg["Subject"] = subject
        msg.set_content(body)
        return msg

    def test_eml_metadata_body_and_attachment(self):
        msg = self.message()
        msg["Reply-To"] = "reply@example.test"
        msg.add_attachment(b"abcde", maintype="application", subtype="octet-stream", filename="file.bin")
        (self.workspace / "mail.eml").write_bytes(msg.as_bytes())
        result = self.read(path="mail.eml")
        self.assertEqual(result["subject"], "Plans")
        self.assertIn("alice@example.test", result["from"])
        self.assertIn("bob@example.test", result["to"])
        self.assertIn("carol@example.test", result["cc"])
        self.assertIn("2025", result["date"])
        self.assertIn(["Reply-To", "reply@example.test"], result["headers"])
        self.assertIn("Hello team", result["body"])
        self.assertEqual(result["attachments"], [{"name": "file.bin", "type": "application/octet-stream", "size": 5}])

    def test_html_fallback_excludes_scripts_and_remote_images(self):
        msg = EmailMessage()
        msg["Subject"] = "HTML"
        msg.set_content('<p>Hello <b>world</b></p><script>bad()</script><img src="https://example.test/pixel">', subtype="html")
        (self.workspace / "html.eml").write_bytes(msg.as_bytes())
        body = self.read(path="html.eml")["body"]
        self.assertIn("Hello world", body)
        self.assertNotIn("bad()", body)
        self.assertNotIn("example.test", body)

    def test_mbox_threads_filter_limit_and_order(self):
        box = mailbox.mbox(self.workspace / "inbox.mbox")
        first = self.message("Plans")
        first["Message-ID"] = "<first@example.test>"
        second = self.message("Re: Plans", "Bob <bob@example.test>")
        second["Message-ID"] = "<second@example.test>"
        second["References"] = "<first@example.test>"
        third = self.message("Different", "Alice <alice@example.test>")
        third["In-Reply-To"] = "<second@example.test>"
        fourth = self.message("Fwd: Plans")
        fourth["X-Folder"] = "Archive"
        for msg in (first, second, third, fourth):
            box.add(msg)
        box.close()
        result = self.read(path="inbox.mbox")
        self.assertEqual([[m["subject"] for m in t["messages"]] for t in result["threads"]], [["Plans", "Re: Plans", "Different", "Fwd: Plans"]])
        result = self.read(path="inbox.mbox", sender="bob", limit=1)
        self.assertEqual(result["threads"][0]["messages"][0]["subject"], "Re: Plans")
        result = self.read(path="inbox.mbox", folder="Archive")
        self.assertEqual(result["threads"][0]["messages"][0]["subject"], "Fwd: Plans")
        result = self.read(path="inbox.mbox", limit=2)
        self.assertEqual(sum(len(t["messages"]) for t in result["threads"]), 2)
        self.assertTrue(result["truncated"])

    def test_path_escape_and_symlink_refused(self):
        (self.root / "outside.eml").write_text("Subject: secret\n\nsecret", encoding="utf8")
        result = self.call({"path": "../outside.eml"})
        self.assertTrue(result.get("isError"))
        self.assertIn("inside the workspace", result["content"][0]["text"])
        try:
            (self.workspace / "link.eml").symlink_to(self.root / "outside.eml")
        except OSError:
            return  # Windows may not permit creating symlinks.
        result = self.call({"path": "link.eml"})
        self.assertTrue(result.get("isError"))

    def test_msg_reports_actionable_limitation(self):
        (self.workspace / "outlook.msg").write_bytes(b"fixture")
        result = self.call({"path": "outlook.msg"})
        self.assertTrue(result.get("isError"))
        self.assertIn(".eml", result["content"][0]["text"])

    def test_large_mailbox_response_is_valid_bounded_json(self):
        box = mailbox.mbox(self.workspace / "large.mbox")
        for i in range(40):
            box.add(self.message(f"Subject {i}", body="x" * 3000))
        box.close()
        result = self.call({"path": "large.mbox", "limit": 40})
        self.assertFalse(result.get("isError"), result)
        text = result["content"][0]["text"]
        self.assertLessEqual(len(text), 22000)
        data = json.loads(text)
        self.assertTrue(data["truncated"])
        self.assertTrue(data["threads"])

    def test_eml_control_characters_do_not_break_output_cap(self):
        msg = self.message(body="\x01" * 11000)
        (self.workspace / "large.eml").write_bytes(msg.as_bytes())
        result = self.call({"path": "large.eml"})
        self.assertFalse(result.get("isError"), result)
        text = result["content"][0]["text"]
        self.assertLessEqual(len(text), 22000)
        self.assertTrue(json.loads(text)["body_truncated"])

    def test_invalid_message_limit_refused(self):
        box = mailbox.mbox(self.workspace / "empty.mbox")
        box.close()
        for limit in (0, 51, True, "2"):
            with self.subTest(limit=limit):
                self.assertTrue(self.call({"path": "empty.mbox", "limit": limit}).get("isError"))

    def test_tool_is_registered(self):
        request = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        result = subprocess.run([sys.executable, str(SERVER)], cwd=self.workspace, input=json.dumps(request) + "\n", text=True, capture_output=True, check=True, timeout=15)
        self.assertIn("read_email", [tool["name"] for tool in json.loads(result.stdout)["result"]["tools"]])


if __name__ == "__main__":
    unittest.main()
