//! Edit and regenerate: cut a chat back to just before one of its user messages. Both the app's rows
//! and the agent's own session (aionrs `state.json`, which `--resume` replays) are cut, so the model
//! does not remember the removed turns. Files the agent changed are left as they are.
use crate::store;
use rusqlite::Connection;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn session_file(workspace: &Path, conv: &str) -> PathBuf {
    workspace.join(".aionrs").join("sessions").join("sessions").join(conv).join("state.json")
}

/// The text of a typed user turn; `None` for tool results and other non-text user entries.
fn user_text(m: &Value) -> Option<String> {
    if m["role"] != "user" {
        return None;
    }
    let blocks = m["content"].as_array()?;
    if blocks.iter().any(|b| b["type"] != "text") {
        return None;
    }
    Some(blocks.iter().filter_map(|b| b["text"].as_str()).collect::<String>())
}

/// Drops the session's messages from the user turn with `text` on. The turn is found by counting typed
/// user turns from the end (`later` of them come after it) and must match `text`, so a summarized
/// (compacted) or otherwise unmatched history is refused instead of cut in the wrong place.
pub fn trim_session(state: &mut Value, text: &str, later: usize) -> Result<(), String> {
    let msgs = state["messages"].as_array_mut().ok_or("The chat's session has no messages")?;
    let users: Vec<usize> = msgs.iter().enumerate().filter(|(_, m)| user_text(m).is_some()).map(|(i, _)| i).collect();
    let at = users.len().checked_sub(later + 1).map(|k| users[k]);
    match at {
        Some(i) if user_text(&msgs[i]).is_some_and(|t| t.trim() == text.trim()) => {
            msgs.truncate(i);
            Ok(())
        }
        _ => Err("That message was summarized to save space, so the chat can't go back to it.".into()),
    }
}

/// Cuts chat `conv` back to before user message `msg_id` and returns that message's text.
/// The caller must have stopped the chat's agent.
pub fn rewind(c: &Connection, conv: &str, msg_id: i64) -> Result<String, String> {
    let (_, workspace, _) = store::conv_info(c, conv).ok_or("Unknown chat")?;
    let (role, body) = store::message(c, conv, msg_id).ok_or("That message no longer exists")?;
    if role != "user" {
        return Err("Only your own messages can be edited".into());
    }
    let text = body["text"].as_str().unwrap_or("").to_string();
    let path = session_file(Path::new(&workspace), conv);
    if path.is_file() {
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut state: Value = serde_json::from_str(&raw).map_err(|e| format!("Could not read the chat's session: {e}"))?;
        trim_session(&mut state, &text, store::users_after(c, conv, msg_id))?;
        std::fs::write(path.with_extension("json.bak"), &raw).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&state).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }
    store::truncate_from(c, conv, msg_id);
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(t: &str) -> Value { json!({"role": "user", "content": [{"type": "text", "text": t}]}) }
    fn reply(t: &str) -> Value { json!({"role": "assistant", "content": [{"type": "text", "text": t}]}) }
    fn tool_result() -> Value { json!({"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}) }

    fn state() -> Value {
        json!({"messages": [user("a"), reply("1"), user("b"), reply("call"), tool_result(), reply("2"), user("c"), reply("3")]})
    }

    #[test]
    fn cuts_before_the_matching_turn_and_skips_tool_results() {
        let mut s = state();
        trim_session(&mut s, "b", 1).unwrap();
        assert_eq!(s["messages"].as_array().unwrap().len(), 2);
        let mut s = state();
        trim_session(&mut s, "c", 0).unwrap();
        assert_eq!(s["messages"].as_array().unwrap().len(), 6);
        let mut s = state();
        trim_session(&mut s, "a", 2).unwrap();
        assert!(s["messages"].as_array().unwrap().is_empty());
    }

    #[test]
    fn refuses_when_history_does_not_line_up() {
        let mut s = state();
        assert!(trim_session(&mut s, "x", 1).is_err());
        assert!(trim_session(&mut s, "a", 5).is_err());
        assert_eq!(s, state(), "a refused cut leaves the session untouched");
    }

    #[test]
    fn rewinds_rows_and_session_together() {
        let dir = std::env::temp_dir().join(format!("lw-rewind-{}", store::now()));
        std::fs::create_dir_all(&dir).unwrap();
        let c = store::open(&dir).unwrap();
        store::create_conv(&c, "c1", &dir.to_string_lossy()).unwrap();
        for (role, t) in [("user", "a"), ("assistant", "1"), ("user", "b"), ("assistant", "2")] {
            store::add_msg(&c, "c1", role, &json!({"text": t}));
        }
        let file = session_file(&dir, "c1");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, json!({"id": "c1", "messages": [user("a"), reply("1"), user("b"), reply("2")]}).to_string()).unwrap();
        let b = store::messages(&c, "c1", 0)[2]["id"].as_i64().unwrap();
        assert_eq!(rewind(&c, "c1", b).unwrap(), "b");
        assert_eq!(store::messages(&c, "c1", 0).len(), 2);
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved["messages"].as_array().unwrap().len(), 2);
        assert_eq!(saved["id"], "c1");
        assert!(file.with_extension("json.bak").is_file());
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
