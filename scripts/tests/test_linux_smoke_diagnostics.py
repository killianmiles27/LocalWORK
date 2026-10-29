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

    def test_python_selection_falls_back_and_rejects_invalid_override(self):
        support = self.support()
        with patch.object(support.shutil, 'which', return_value=None):
            self.assertEqual(support.select_python('', sys.executable), sys.executable)
        with self.assertRaisesRegex(ValueError, 'not executable'):
            support.select_python(os.path.join(tempfile.gettempdir(), 'missing-localwork-python'), sys.executable)


if __name__ == '__main__':
    unittest.main()
