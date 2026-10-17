"""Browser output retains results and recoverable long snapshots without code echoes."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "workbench-mcp"))
import browser


class BrowserOutput(unittest.TestCase):
    def test_cli_eval_error_is_a_failure_even_with_exit_zero(self):
        previous = os.getcwd()
        browser._failed_evaluations = 0
        with tempfile.TemporaryDirectory() as temp:
            try:
                os.chdir(temp)
                raw = '### Error\nTypeError: missing property\n' + 'long stack frame\n' * 200
                with patch.object(browser.os.path, 'exists', return_value=True), patch.object(browser, 'CLI', 'cli'), patch.object(browser, '_ensure_open'), patch.object(browser, '_run', return_value=(0, raw)):
                    with self.assertRaisesRegex(RuntimeError, 'missing property') as first:
                        browser.run({'command': 'eval', 'args': ['() => missing.value']})
                    self.assertLess(len(str(first.exception)), 500)
                    self.assertEqual(Path('.browser/last-error.txt').read_text(encoding='utf-8'), raw.strip())
                    with self.assertRaisesRegex(RuntimeError, 'change approach'):
                        browser.run({'command': 'eval', 'args': ['() => another.missing']})
                with patch.object(browser.os.path, 'exists', return_value=True), patch.object(browser, 'CLI', 'cli'), patch.object(browser, '_ensure_open'), patch.object(browser, '_run', return_value=(0, '### Result\n42')):
                    self.assertIn('42', browser.run({'command':'eval','args':['() => 42']}))
                    self.assertEqual(browser._failed_evaluations, 0)
            finally:
                os.chdir(previous)
                browser._failed_evaluations = 0

    def test_slim_drops_inert_wrappers_but_keeps_content_and_clickable_targets(self):
        body = '- generic [ref=f1e2]:\n - generic [ref=f1e3] [cursor=pointer]\n - button [ref=f1e4] [cursor=pointer]\n - generic [ref=f1e5]: Japan\n - searchbox "Search" [ref=f1e6]'
        slim = browser._slim(body)
        self.assertNotIn('f1e2', slim)
        for kept in ('f1e3', 'f1e4', 'Japan', 'searchbox'):
            self.assertIn(kept, slim)

    def test_wait_uses_bounded_delay_then_supported_snapshot_command(self):
        with patch.object(browser.os.path, 'exists', return_value=True), patch.object(browser, 'CLI', 'cli'), patch.object(browser, '_ensure_open'), patch.object(browser.time, 'sleep') as sleep, patch.object(browser, '_run', return_value=(0, '### Result\nloaded')) as run:
            self.assertEqual(browser.run({'command': 'wait', 'args': ['2']}), '### Result\nloaded')
            sleep.assert_called_once_with(2)
            run.assert_called_once_with(['snapshot'])
            for bad in ('31', '-1', 'NaN', 'forever'):
                with self.assertRaises(ValueError):
                    browser.run({'command': 'wait', 'args': [bad]})

    def test_removes_echo_but_keeps_result_and_events(self):
        raw = '### Result\n"Japan"\n### Ran Playwright code\n```js\nlong script\n```\n### Events\nPage loaded\n'
        self.assertEqual(browser._result_text(raw), '### Result\n"Japan"\n### Events\nPage loaded')
        self.assertEqual(browser._result_text('### Result\n42\n### Ran Playwright code\ncode'), '### Result\n42')

    def test_truncated_snapshot_can_be_read_after_cleanup(self):
        previous = os.getcwd()
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2]) as temp:
            try:
                os.chdir(temp)
                Path('.browser').mkdir()
                body = 'visible control\n' * 500 + 'last control'
                Path('.browser/page.yml').write_text(body, encoding='utf-8')
                output = browser._inline_snapshots('- [Snapshot](.browser/page.yml)')
                browser._clean_snapshots()
                self.assertIn('snapshot-latest.yml', output)
                self.assertEqual(Path('.browser/snapshot-latest.yml').read_text(encoding='utf-8'), body)
                self.assertFalse(Path('.browser/page.yml').exists())
                inline = '### Page\n- Page URL: https://example.com\n### Snapshot\n```yaml\n' + body + '\n```\n### Events\nloaded'
                clipped = browser._inline_snapshots(inline)
                self.assertIn('https://example.com', clipped)
                self.assertIn('### Events\nloaded', clipped)
                self.assertIn('snapshot-latest.yml', clipped)
                self.assertLess(len(clipped), 4500)
                browser._clean_snapshots()
                self.assertIn('last control', Path('.browser/snapshot-latest.yml').read_text(encoding='utf-8'))
            finally:
                os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
