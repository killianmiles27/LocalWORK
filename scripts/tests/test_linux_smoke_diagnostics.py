"""Regression checks for the Linux smoke test's local diagnostics."""
from contextlib import closing
import importlib.util
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

SUPPORT = Path(__file__).resolve().parents[1] / 'e2e' / 'linux_smoke_support.py'


class LinuxSmokeDiagnosticsTest(unittest.TestCase):
    def support(self):
        self.assertTrue(SUPPORT.exists(), 'smoke diagnostic helpers missing')
        spec = importlib.util.spec_from_file_location('linux_smoke_support', SUPPORT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_messages_are_read_from_actual_database_in_order(self):
        support = self.support()
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / 'workbench.db'
            with closing(sqlite3.connect(database)) as db:
                db.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY, role TEXT, body TEXT)')
                db.executemany('INSERT INTO messages VALUES (?, ?, ?)', [(1, 'user', '{"text":"hello"}'), (2, 'error', 'failed')])
                db.commit()
            self.assertEqual(support.recent_messages(database), [('user', '{"text":"hello"}'), ('error', 'failed')])
            self.assertTrue(support.message_persisted(database, 'hello'))
            self.assertFalse(support.message_persisted(database, 'absent'))

    def test_seed_settings_creates_workspace_without_a_conversation(self):
        support = self.support()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            database = home / 'workbench.db'
            self.assertTrue(hasattr(support, 'seed_settings'), 'smoke setup must seed projects_folder')
            support.seed_settings(home, database)
            with closing(sqlite3.connect(database)) as db:
                settings = dict(db.execute('SELECT k, v FROM kv'))
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertEqual(settings['projects_folder'], str(home / 'Documents' / 'LocalWORK Smoke'))
            self.assertTrue(Path(settings['projects_folder']).is_dir())
            self.assertEqual(settings['wizard_done'], '1')
            self.assertEqual(settings['offline'], '1')
            self.assertNotIn('conversations', tables)

    def test_python_probe_reports_version_and_rejects_unusable_interpreter(self):
        support = self.support()
        self.assertTrue(hasattr(support, 'probe_python'), 'smoke setup must preflight the Workbench Python')
        self.assertRegex(support.probe_python(sys.executable, os.environ), r'^3\.\d+ at .+python')
        with self.assertRaisesRegex(ValueError, 'could not run'):
            support.probe_python(os.path.join(tempfile.gettempdir(), 'missing-localwork-python'), os.environ)

    def test_python_selection_falls_back_and_rejects_invalid_override(self):
        support = self.support()
        with patch.object(support.shutil, 'which', return_value=None):
            self.assertEqual(support.select_python('', sys.executable), sys.executable)
        with self.assertRaisesRegex(ValueError, 'not executable'):
            support.select_python(os.path.join(tempfile.gettempdir(), 'missing-localwork-python'), sys.executable)


if __name__ == '__main__':
    unittest.main()
