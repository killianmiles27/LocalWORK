"""Focused tests for the app-side OfficeCLI verification bundle."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SERVER = Path(__file__).resolve().parents[2] / "workbench-mcp" / "server.py"
SPEC = importlib.util.spec_from_file_location("workbench_server", SERVER)
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class OfficeCliVerify(unittest.TestCase):
    def test_docx_defaults_to_ordinary_stats(self):
        def run(command, **kwargs):
            return type("Result", (), {"stdout": "result for " + " ".join(command[1:]), "stderr": "", "returncode": 0})()

        with patch.object(server.subprocess, "run", side_effect=run) as office:
            result = server.call_tool("officecli", {"args": ["verify", "report.docx"]})

        self.assertIn("Verification commands completed", result)
        for label in ("validate", "issues", "outline", "text", "Word stats"):
            self.assertIn(f"[{label}: OK]", result)
        self.assertEqual(office.call_count, 5)
        self.assertEqual(office.call_args_list[-1].args[0][1:], ["view", "report.docx", "stats"])
        self.assertEqual(office.call_args_list[-1].kwargs["timeout"], 120)

    def test_optional_docx_page_count_uses_bounded_timeout(self):
        def run(command, **kwargs):
            return type("Result", (), {"stdout": "stats", "stderr": "", "returncode": 0})()

        with patch.object(server.subprocess, "run", side_effect=run) as office:
            result = server.call_tool("officecli", {"args": ["verify", "report.docx", "--page-count"]})

        self.assertIn("[Word page-count stats: OK]", result)
        self.assertEqual(office.call_args_list[-1].args[0][1:], ["view", "report.docx", "stats", "--page-count"])
        self.assertEqual(office.call_args_list[-1].kwargs["timeout"], 20)

    def test_xlsx_and_pptx_run_shared_checks_without_word_stats(self):
        for path in ("sheet.xlsx", "slides.pptx"):
            with self.subTest(path=path), patch.object(server.subprocess, "run", return_value=type("Result", (), {"stdout": "ok", "stderr": "", "returncode": 0})()) as office:
                result = server.call_tool("officecli", {"args": ["verify", path]})
                self.assertIn("[text: OK]", result)
                self.assertNotIn("page-count stats", result)
                self.assertEqual(office.call_count, 4)

    def test_failed_check_keeps_all_results_and_never_says_passed(self):
        def run(command, **kwargs):
            failed = command[1] == "validate"
            return type("Result", (), {"stdout": "validation error" if failed else "ok", "stderr": "", "returncode": 2 if failed else 0})()

        with patch.object(server.subprocess, "run", side_effect=run) as office:
            result = server.call_tool("officecli", {"args": ["verify", "report.docx"]})

        self.assertIn("FAILED or INCOMPLETE; do not report it as passed", result)
        self.assertIn("[validate: FAILED (exit 2)]", result)
        self.assertIn("[Word stats: OK]", result)
        self.assertEqual(office.call_count, 5)

    def test_page_count_timeout_is_failed_and_explicit(self):
        def run(command, **kwargs):
            if command[-1] == "--page-count":
                raise server.subprocess.TimeoutExpired(command, kwargs["timeout"])
            return type("Result", (), {"stdout": "ok", "stderr": "", "returncode": 0})()

        with patch.object(server.subprocess, "run", side_effect=run) as office:
            result = server.call_tool("officecli", {"args": ["verify", "report.docx", "--page-count"]})

        self.assertIn("FAILED or INCOMPLETE; do not report it as passed", result)
        self.assertIn("[Word page-count stats: FAILED (could not run)]", result)
        self.assertIn("timed out", result)
        self.assertEqual(office.call_args_list[-1].kwargs["timeout"], 20)

    def test_truncation_is_explicit_and_names_how_to_fetch_more(self):
        large = "x" * 4000
        with patch.object(server.subprocess, "run", return_value=type("Result", (), {"stdout": large, "stderr": "", "returncode": 0})()):
            result = server.call_tool("officecli", {"args": ["verify", "report.xlsx"]})

        self.assertIn("Output truncated; 800 characters omitted", result)
        self.assertIn("rerun the corresponding individual officecli command", result)
        self.assertIn("One or more command outputs were truncated", result)

    def test_unsupported_or_malformed_verify_args_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "supports only"):
            server.call_tool("officecli", {"args": ["verify", "report.pdf"]})
        with self.assertRaisesRegex(ValueError, "expects"):
            server.call_tool("officecli", {"args": ["verify"]})
        with self.assertRaisesRegex(ValueError, "supported only"):
            server.call_tool("officecli", {"args": ["verify", "sheet.xlsx", "--page-count"]})
        with self.assertRaisesRegex(ValueError, "expects"):
            server.call_tool("officecli", {"args": ["verify", "report.docx", "--page-count", "extra"]})


if __name__ == "__main__":
    unittest.main()
