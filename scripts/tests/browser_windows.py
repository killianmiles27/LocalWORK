"""Regression check for quiet Playwright browser launch and lifecycle on Windows.

Run from the repository root with the bundled vendor files present:
    python scripts/tests/browser_windows.py
"""
import ctypes
import json
import os
import pathlib
import sys
import tempfile
import threading
import uuid
from ctypes import wintypes


if os.name != "nt":
    raise SystemExit("This focused browser window test requires Windows.")

ROOT = pathlib.Path(__file__).resolve().parents[2]
os.environ["BROWSER_NODE"] = str(ROOT / "vendor" / "node" / "node.exe")
os.environ["BROWSER_CLI"] = str(ROOT / "vendor" / "playwright" / "node_modules" / "@playwright" / "cli" / "playwright-cli.js")
os.environ["BROWSER_BROWSERS"] = str(ROOT / "vendor" / "browsers")
os.environ["CI"] = "1"  # skip the CLI's update check; this test uses only about:blank
os.environ["BROWSER_SESSION"] = "quiet-test-" + uuid.uuid4().hex[:12]


user32 = ctypes.windll.user32


def visible_windows(class_name):
    found = set()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        cls = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(hwnd, cls, len(cls))
        if cls.value != class_name:
            return True
        found.add(int(hwnd))
        return True

    user32.EnumWindows(visit, 0)
    return found


def main():
    profiles = tempfile.TemporaryDirectory(prefix="localwork-browser-profiles-")
    workspace = tempfile.TemporaryDirectory(prefix="localwork-browser-workspace-")
    os.environ["BROWSER_PROFILES"] = profiles.name
    spawn_log = pathlib.Path(profiles.name) / "spawns.jsonl"
    os.environ["LOCALWORK_WINDOWS_HIDE_LOG"] = str(spawn_log)
    sys.path.insert(0, str(ROOT / "workbench-mcp"))
    import browser

    stop_monitor = threading.Event()
    baseline_consoles = visible_windows("ConsoleWindowClass")
    baseline_browsers = visible_windows("Chrome_WidgetWin_1")
    new_consoles = set()
    new_browsers = set()
    records = []

    def monitor():
        while not stop_monitor.is_set():
            new_consoles.update(visible_windows("ConsoleWindowClass") - baseline_consoles)
            new_browsers.update(visible_windows("Chrome_WidgetWin_1") - baseline_browsers)
            stop_monitor.wait(0.01)

    monitor_thread = threading.Thread(target=monitor, daemon=True)
    monitor_thread.start()
    old_cwd = os.getcwd()
    try:
        os.chdir(workspace.name)
        opened = browser.run({"command": "open"})
        if "opened" not in opened.lower() and "open" not in opened.lower():
            raise RuntimeError(f"Browser did not report a successful open: {opened}")
        if visible_windows("Chrome_WidgetWin_1") - baseline_browsers:
            raise RuntimeError("The background browser showed a visible window")
        snapshot = browser.run({"command": "snapshot"})
        if "about:blank" not in snapshot and "Page" not in snapshot:
            raise RuntimeError(f"Unexpected about:blank snapshot output: {snapshot}")
        browser.run({"command": "close"})
        if visible_windows("Chrome_WidgetWin_1") - baseline_browsers:
            raise RuntimeError("The isolated browser window remained visible after close")
        records = [json.loads(line) for line in spawn_log.read_text(encoding="utf-8").splitlines()]
        browser_spawns = [r for r in records if pathlib.Path(r["command"]).name.lower() == "chrome-headless-shell.exe"]
        if not records or any(not r["windowsHide"] for r in records):
            raise RuntimeError(f"A Playwright child spawn did not set windowsHide: {records}")
        if not browser_spawns:
            raise RuntimeError(f"The daemon did not report spawning headless Chromium: {records}")
    finally:
        try:
            browser.run({"command": "close"})
        except Exception:
            pass
        os.chdir(old_cwd)
        stop_monitor.set()
        monitor_thread.join(timeout=2)
        os.environ.pop("LOCALWORK_WINDOWS_HIDE_LOG", None)
        os.environ.pop("BROWSER_SESSION", None)
        os.environ.pop("BROWSER_PROFILES", None)
        profiles.cleanup()
        workspace.cleanup()

    if new_consoles:
        raise RuntimeError(f"New visible console windows appeared during browser launch: {sorted(new_consoles)}")
    if new_browsers:
        raise RuntimeError(f"New visible browser windows appeared: {sorted(new_browsers)}")
    print("PASS: headless browser opened about:blank, returned a snapshot, closed, and showed no browser or console window")
    print(f"PASS: {len(records)} Playwright child spawns set windowsHide, including Chromium")


if __name__ == "__main__":
    main()
