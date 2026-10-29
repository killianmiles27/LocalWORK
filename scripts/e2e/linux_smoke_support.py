"""Small, UI-independent helpers for the Linux packaged-app smoke test."""
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

PROBE = 'import sys; print(sys.version_info[0]); print(sys.version_info[1]); print(sys.executable)'


def probe_python(program, env):
    try:
        result = subprocess.run([program, '-c', PROBE], capture_output=True, text=True, timeout=30, env=env)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError(f'could not run Workbench Python {program}: {error}') from error
    lines = result.stdout.splitlines()
    if result.returncode or len(lines) < 3:
        detail = (result.stderr or result.stdout).strip()
        raise ValueError(f'Workbench Python {program} failed (exit {result.returncode}): {detail}')
    try:
        version = (int(lines[0]), int(lines[1]))
    except ValueError as error:
        raise ValueError(f'Workbench Python {program} printed an unexpected version: {result.stdout!r}') from error
    if version < (3, 11):
        raise ValueError(f'Workbench Python {program} is {version[0]}.{version[1]}, but the Workbench tools need 3.11 or newer')
    return f'{version[0]}.{version[1]} at {lines[2]}'


def seed_settings(home, database):
    workspace = home / 'Documents' / 'LocalWORK Smoke'
    workspace.mkdir(parents=True)
    with closing(sqlite3.connect(database)) as db:
        db.execute('CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)')
        db.executemany('INSERT INTO kv VALUES (?, ?)',
                       [('wizard_done', '1'), ('offline', '1'), ('projects_folder', str(workspace))])
        db.commit()


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
