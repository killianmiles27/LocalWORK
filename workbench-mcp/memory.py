"""Long-term memory for the workbench: short notes about the user, stored in the app database (SQLite + FTS5)."""
import os, re, sqlite3, time

DB = os.environ.get("WORKBENCH_DB", "")


def _db():
    if not DB:
        raise RuntimeError("memory database is not configured")
    c = sqlite3.connect(DB, timeout=10)
    c.execute("create table if not exists memories(id integer primary key autoincrement, text text not null, created integer not null)")
    c.execute("create virtual table if not exists memories_fts using fts5(text, content='memories', content_rowid='id')")
    c.executescript("""
    create trigger if not exists memories_ai after insert on memories begin insert into memories_fts(rowid,text) values(new.id,new.text); end;
    create trigger if not exists memories_ad after delete on memories begin insert into memories_fts(memories_fts,rowid,text) values('delete',old.id,old.text); end;
    """)
    return c


def memory_save(text):
    text = " ".join(str(text).split())
    if not text:
        raise ValueError("text is empty")
    c = _db()
    dup = c.execute("select id from memories where lower(text)=lower(?)", (text,)).fetchone()
    if dup:
        return f"Already remembered (#{dup[0]}): {text}"
    cur = c.execute("insert into memories(text,created) values(?,?)", (text, int(time.time() * 1000)))
    c.commit()
    return f"Saved memory #{cur.lastrowid}: {text}"


def memory_search(query, limit=8):
    c = _db()
    terms = [t for t in re.findall(r"\w+", str(query)) if len(t) > 1]
    rows = []
    if terms:
        q = " OR ".join(f'"{t}"' for t in terms)
        rows = c.execute("select m.id,m.text from memories_fts f join memories m on m.id=f.rowid where memories_fts match ? order by rank limit ?", (q, int(limit))).fetchall()
    if not rows:
        rows = c.execute("select id,text from memories order by id desc limit ?", (int(limit),)).fetchall() if not terms else []
    return "\n".join(f"#{i}: {t}" for i, t in rows) or "No matching memories."


def memory_forget(id):
    c = _db()
    n = c.execute("delete from memories where id=?", (int(id),)).rowcount
    c.commit()
    return f"Forgot memory #{id}." if n else f"No memory #{id}."
