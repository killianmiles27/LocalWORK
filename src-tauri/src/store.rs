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
         CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);",
    )?;
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
    let mut st = c.prepare("SELECT id,title,workspace,updated FROM conversations ORDER BY updated DESC").unwrap();
    st.query_map([], |r| {
        Ok(json!({"id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?,
                  "workspace": r.get::<_, String>(2)?, "updated": r.get::<_, i64>(3)?}))
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

pub fn delete_conv(c: &Connection, id: &str) {
    let _ = c.execute("DELETE FROM messages WHERE conv=?1", [id]);
    let _ = c.execute("DELETE FROM conversations WHERE id=?1", [id]);
}

pub fn add_msg(c: &Connection, conv: &str, role: &str, body: &Value) {
    let _ = c.execute(
        "INSERT INTO messages(conv,role,body,ts) VALUES(?1,?2,?3,?4)",
        params![conv, role, body.to_string(), now()],
    );
    let _ = c.execute("UPDATE conversations SET updated=?2 WHERE id=?1", params![conv, now()]);
}

pub fn messages(c: &Connection, conv: &str) -> Vec<Value> {
    let mut st = c.prepare("SELECT id,role,body,ts FROM messages WHERE conv=?1 ORDER BY id").unwrap();
    st.query_map([conv], |r| {
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
