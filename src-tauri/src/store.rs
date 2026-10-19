use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;

pub fn open(dir: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open(dir.join("workbench.db"))?;
    c.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS conversations(
            id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL,
            created INTEGER NOT NULL, updated INTEGER NOT NULL, has_session INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, role TEXT NOT NULL,
            body TEXT NOT NULL, ts INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv, id);
         CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created INTEGER NOT NULL);
         CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, content='memories', content_rowid='id');
         CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid,text) VALUES(new.id,new.text); END;
         CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts,rowid,text) VALUES('delete',old.id,old.text); END;
         CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);",
    )?;
    // Added after the first release; fails harmlessly once the column exists.
    let _ = c.execute("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0", []);
    Ok(c)
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn create_conv(c: &Connection, id: &str, workspace: &str) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO conversations(id,title,workspace,created,updated) VALUES(?1,?2,?3,?4,?4)",
        params![id, "New conversation", workspace, now()],
    )?;
    Ok(())
}

pub fn list_convs(c: &Connection) -> Vec<Value> {
    let mut st = c.prepare("SELECT id,title,workspace,updated,pinned FROM conversations ORDER BY pinned DESC, updated DESC").unwrap();
    st.query_map([], |r| {
        Ok(json!({"id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?,
                  "workspace": r.get::<_, String>(2)?, "updated": r.get::<_, i64>(3)?, "pinned": r.get::<_, i64>(4)? != 0}))
    })
    .unwrap()
    .filter_map(|x| x.ok())
    .collect()
}

pub fn conv_info(c: &Connection, id: &str) -> Option<(String, String, bool)> {
    c.query_row("SELECT title,workspace,has_session FROM conversations WHERE id=?1", [id], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0))
    })
    .ok()
}

pub fn set_has_session(c: &Connection, id: &str) {
    let _ = c.execute("UPDATE conversations SET has_session=1 WHERE id=?1", [id]);
}

pub fn rename(c: &Connection, id: &str, title: &str) {
    let _ = c.execute("UPDATE conversations SET title=?2 WHERE id=?1", params![id, title]);
}

pub fn set_pinned(c: &Connection, id: &str, on: bool) {
    let _ = c.execute("UPDATE conversations SET pinned=?2 WHERE id=?1", params![id, on as i64]);
}

/// Chats whose title or user/assistant text contains `q` (case-insensitive for ASCII), newest first.
pub fn search(c: &Connection, q: &str) -> Vec<String> {
    let q = q.trim();
    if q.is_empty() {
        return vec![];
    }
    let esc: String = q.chars().flat_map(|ch| if matches!(ch, '%' | '_' | '!') { vec!['!', ch] } else { vec![ch] }).collect();
    let pat = format!("%{esc}%");
    let Ok(mut st) = c.prepare(
        "SELECT id FROM conversations WHERE title LIKE ?1 ESCAPE '!'
            OR id IN (SELECT conv FROM messages WHERE role IN ('user','assistant') AND body LIKE ?1 ESCAPE '!')
         ORDER BY pinned DESC, updated DESC LIMIT 200",
    ) else { return vec![] };
    st.query_map([pat], |r| r.get(0)).map(|it| it.filter_map(|x| x.ok()).collect()).unwrap_or_default()
}

pub fn message(c: &Connection, conv: &str, id: i64) -> Option<(String, Value)> {
    c.query_row("SELECT role,body FROM messages WHERE conv=?1 AND id=?2", params![conv, id], |r| {
        let body: String = r.get(1)?;
        Ok((r.get(0)?, serde_json::from_str(&body).unwrap_or(Value::Null)))
    })
    .ok()
}

pub fn users_after(c: &Connection, conv: &str, id: i64) -> usize {
    c.query_row("SELECT COUNT(*) FROM messages WHERE conv=?1 AND id>?2 AND role='user'", params![conv, id], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as usize
}

/// Removes message `id` and everything after it (edit and regenerate). Row ids are never reused.
pub fn truncate_from(c: &Connection, conv: &str, id: i64) {
    let _ = c.execute("DELETE FROM messages WHERE conv=?1 AND id>=?2", params![conv, id]);
    let _ = c.execute("DELETE FROM kv WHERE k=?1", [format!("ctx:{conv}")]);
}

pub fn delete_conv(c: &Connection, id: &str) {
    let _ = c.execute("DELETE FROM messages WHERE conv=?1", [id]);
    let _ = c.execute("DELETE FROM conversations WHERE id=?1", [id]);
    let _ = c.execute("DELETE FROM kv WHERE k IN (?1, ?2)", params![format!("ctx:{id}"), format!("titled:{id}")]);
}

pub fn add_msg(c: &Connection, conv: &str, role: &str, body: &Value) {
    let _ = c.execute(
        "INSERT INTO messages(conv,role,body,ts) VALUES(?1,?2,?3,?4)",
        params![conv, role, body.to_string(), now()],
    );
    let _ = c.execute("UPDATE conversations SET updated=?2 WHERE id=?1", params![conv, now()]);
}

/// Rows are only ever appended, or cut from the end by `truncate_from` (the UI then drops its cache), so
/// `after` lets the UI fetch just the rows it has not seen yet.
pub fn messages(c: &Connection, conv: &str, after: i64) -> Vec<Value> {
    let mut st = c.prepare("SELECT id,role,body,ts FROM messages WHERE conv=?1 AND id>?2 ORDER BY id").unwrap();
    st.query_map(params![conv, after], |r| {
        let body: String = r.get(2)?;
        Ok(json!({"id": r.get::<_, i64>(0)?, "role": r.get::<_, String>(1)?,
                  "body": serde_json::from_str::<Value>(&body).unwrap_or(Value::Null), "ts": r.get::<_, i64>(3)?}))
    })
    .unwrap()
    .filter_map(|x| x.ok())
    .collect()
}

pub fn kv_get(c: &Connection, k: &str) -> Option<String> {
    c.query_row("SELECT v FROM kv WHERE k=?1", [k], |r| r.get(0)).ok()
}

pub fn kv_set(c: &Connection, k: &str, v: &str) {
    let _ = c.execute("INSERT INTO kv(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v", params![k, v]);
}

pub fn recent_memories(c: &Connection, n: i64) -> Vec<(i64, String)> {
    let Ok(mut st) = c.prepare("SELECT id,text FROM memories ORDER BY id DESC LIMIT ?1") else { return vec![] };
    st.query_map([n], |r| Ok((r.get(0)?, r.get(1)?))).map(|it| it.filter_map(|x| x.ok()).collect()).unwrap_or_default()
}

pub fn delete_memory(c: &Connection, id: i64) {
    let _ = c.execute("DELETE FROM memories WHERE id=?1", [id]);
}
