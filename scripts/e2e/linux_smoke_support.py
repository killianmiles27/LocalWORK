"""Small, UI-independent helpers for the Linux packaged-app smoke test."""
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3


def select_python(configured, fallback):
    selected = configured or shutil.which('python3') or fallback
    if not selected or not Path(selected).is_file() or not os.access(selected, os.X_OK):
        raise ValueError(f'Workbench Python is not executable: {selected!r}')
    return selected


def recent_messages(database, limit=30):
    if not database.is_file():
        return []
    with closing(sqlite3.connect(database, timeout=1)) as db:
        try:
            rows = db.execute('SELECT role, body FROM messages ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
        except sqlite3.OperationalError as error:
            if 'no such table: messages' in str(error):
                return []
            raise
    return list(reversed(rows))


def message_persisted(database, text):
    for role, body in recent_messages(database):
        if role == 'user':
            try:
                if json.loads(body).get('text') == text:
                    return True
            except (ValueError, AttributeError, TypeError):
                continue
    return False
