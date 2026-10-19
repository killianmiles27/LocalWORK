//! Turns a stored chat into a readable Markdown file. Tool calls become one-line notes, so the
//! export reads like the conversation rather than a log.
use serde_json::Value;

fn s(v: &Value) -> String {
    match v {
        Value::String(t) => t.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub fn chat_markdown(title: &str, msgs: &[Value]) -> String {
    let mut out = format!("# {}\n", title.trim());
    let mut last = "";
    for m in msgs {
        let role = m["role"].as_str().unwrap_or("");
        let b = &m["body"];
        match role {
            "user" => {
                out.push_str("\n## You\n\n");
                out.push_str(s(&b["text"]).trim());
                out.push('\n');
            }
            "assistant" => {
                let t = s(&b["text"]);
                if t.trim().is_empty() {
                    continue;
                }
                if last != "assistant" && last != "tool" {
                    out.push_str("\n## Assistant\n");
                }
                out.push('\n');
                out.push_str(t.trim());
                out.push('\n');
            }
            "tool" => {
                if last != "assistant" && last != "tool" {
                    out.push_str("\n## Assistant\n");
                }
                let name = s(if b["request"]["name"].is_null() { &b["name"] } else { &b["request"]["name"] });
                let name = name.rsplit("__").next().unwrap_or(&name).to_string();
                let note = match b["status"].as_str() {
                    Some("error") => " (failed)",
                    Some("cancelled") => " (declined)",
                    _ => "",
                };
                out.push_str(&format!("\n> Tool: `{name}`{note}\n"));
            }
            "notice" => out.push_str(&format!("\n*{}*\n", s(&b["text"]).trim())),
            "error" => {
                let t = if b.is_string() { s(b) } else { s(&b["message"]) };
                out.push_str(&format!("\n> Error: {}\n", t.trim()));
            }
            _ => continue,
        }
        last = if role == "tool" { "tool" } else { role };
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_turns_and_tool_notes() {
        let msgs = vec![
            json!({"role": "user", "body": {"text": "Hi"}}),
            json!({"role": "assistant", "body": {"text": "Looking.", "thinking": "x"}}),
            json!({"role": "tool", "body": {"name": "browser", "status": "error", "request": {"name": "mcp__w__browser"}}}),
            json!({"role": "assistant", "body": {"text": "Done."}}),
        ];
        let md = chat_markdown("Test", &msgs);
        assert_eq!(md.matches("## Assistant").count(), 1);
        assert!(md.contains("## You\n\nHi"));
        assert!(md.contains("> Tool: `browser` (failed)"));
        assert!(!md.contains("x\n"));
    }
}
