"""Seed synthetic files and chat into ONLY the harness's isolated app-data folder."""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

data, workspace, office = map(Path, sys.argv[1:4])
if not any(p.name.startswith("lw-e2e-") for p in data.parents):
    raise SystemExit("Refusing to seed outside an lw-e2e run")
workspace.mkdir(parents=True, exist_ok=True)
(workspace / "memo.md").write_text("# Current memo\n\nRevenue: EUR 95500. Profit: EUR 34100.", encoding="utf8")
(workspace / "sales.csv").write_text("month,revenue,cost\nJanuary,12000,7500\nFebruary,15000,9200\n", encoding="utf8")

for ext, commands in [
    ("docx", [{"command": "add", "parent": "/", "type": "paragraph", "props": {"text": "Automation Word memo"}}]),
    ("xlsx", [{"command": "set", "path": "/Sheet1/A1", "props": {"value": "Automation spreadsheet"}}]),
    ("pptx", [{"command": "add", "parent": "/", "type": "slide", "props": {"layout": "Title Slide", "title": "Automation slide deck", "text": "Synthetic acceptance fixture"}}]),
]:
    filename = workspace / f"fixture.{ext}"
    batch = workspace / f".build-{ext}.json"
    batch.write_text(json.dumps(commands), encoding="utf8")
    for args in [["create", str(filename)], ["batch", str(filename), "--input", str(batch)], ["close", str(filename)]]:
        result = subprocess.run([str(office), *args], capture_output=True, text=True, timeout=45, creationflags=0x08000000)
        if result.returncode:
            raise SystemExit(result.stdout + result.stderr)

# Seed a previous version to exercise the real reader/recovery commands. Revision
# capture itself is covered separately by the native approval-hook tests.
source = "\\\\?\\" + str((workspace / "memo.md").resolve())
key = 0xcbf29ce484222325
for byte in source.encode("utf8"):
    key = ((key ^ byte) * 0x100000001b3) & 0xffffffffffffffff
revision_id = "0123456789abcdef0123456789abcdef"
revision_dir = data / "document-revisions" / f"{key:016x}"
revision_dir.mkdir(parents=True)
previous = b"# Previous memo\n\nPreserve this previous version."
(revision_dir / revision_id).write_bytes(previous)
(revision_dir / f"{revision_id}.json").write_text(json.dumps({"id": revision_id, "created": int(time.time() * 1000) - 60000, "size": len(previous), "source": source}), encoding="utf8")

widget = '''<h2>Interactive fixture</h2><label>Count <output id="count">1</output></label>
<button onclick="document.getElementById('count').textContent=Number(document.getElementById('count').textContent)+1">Add one</button>
<button onclick="sendPrompt('Compare these assumptions')">Suggest follow-up</button>'''
db = sqlite3.connect(data / "workbench.db")
db.executescript("""
CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,has_session INTEGER NOT NULL DEFAULT 0);
CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conv TEXT NOT NULL,role TEXT NOT NULL,body TEXT NOT NULL,ts INTEGER NOT NULL);
CREATE TABLE kv(k TEXT PRIMARY KEY,v TEXT NOT NULL);
""")
now = int(time.time() * 1000)
db.execute("INSERT INTO conversations VALUES(?,?,?,?,?,0)", ("workspace-fixture", "Automation: workspace", str(workspace), now, now))
db.execute("INSERT INTO kv VALUES('wizard_done','1')")
db.execute("INSERT INTO kv VALUES('projects_folder',?)", (str(workspace / "chats"),))
for role, body in [
    ("assistant", {"text": "Synthetic acceptance fixture. No model-generated claims are being evaluated in this chat. [External link](https://example.com/localwork-check)"}),
    ("tool", {"status": "success", "request": {"name": "workbench__assemble_document", "args": {"title": "Interactive fixture", "description": "A local test counter", "html": widget}}, "output": "Fixture"}),
    ("tool", {"status": "success", "request": {"name": "workbench__show_document", "args": {"path": "memo.md", "title": "Test memo"}}, "output": "Fixture"}),
]:
    db.execute("INSERT INTO messages(conv,role,body,ts) VALUES(?,?,?,?)", ("workspace-fixture", role, json.dumps(body), now))
db.commit()
db.close()
print("Seeded synthetic Word, Excel, slides, Markdown, a previous revision, and an interactive visual.")
