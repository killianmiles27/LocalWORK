//! Turns a stored chat into Markdown, retaining private reasoning and tool diagnostics.
use serde_json::Value;

fn s(v: &Value) -> String {
    match v {
        Value::String(t) => t.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn code_block(value: &str) -> String {
    // Pick a fence longer than any run in untrusted content so it cannot end the block.
    let (longest, _) = value
        .chars()
        .fold((0usize, 0usize), |(longest, current), ch| {
            if ch == '`' {
                let current = current + 1;
                (longest.max(current), current)
            } else {
                (longest, 0)
            }
        });
    let fence = "`".repeat(3usize.max(longest + 1));
    format!("{fence}\n{value}\n{fence}\n")
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn timestamp(m: &Value) -> String {
    m["ts"]
        .as_i64()
        .map(|n| format!("{n} ms since Unix epoch"))
        .unwrap_or_else(|| "unknown".into())
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
                out.push_str(&format!("> Timestamp: {}\n\n", timestamp(m)));
                out.push_str(s(&b["text"]).trim());
                out.push('\n');
            }
            "assistant" => {
                let t = s(&b["text"]);
                let thinking = s(&b["thinking"]);
                if t.trim().is_empty() && thinking.trim().is_empty() {
                    continue;
                }
                if last != "assistant" && last != "tool" {
                    out.push_str("\n## Assistant\n");
                }
                if !t.trim().is_empty() {
                    out.push('\n');
                    out.push_str(t.trim());
                    out.push('\n');
                }
                if !thinking.trim().is_empty() {
                    out.push_str("\n<details>\n<summary>Thinking</summary>\n\n");
                    out.push_str(&code_block(thinking.trim()));
                    out.push_str("\n</details>\n");
                }
            }
            "tool" => {
                if last != "assistant" && last != "tool" {
                    out.push_str("\n## Assistant\n");
                }
                let request = &b["request"];
                let name = s(if request["tool"].is_null() {
                    if request["name"].is_null() {
                        &b["name"]
                    } else {
                        &request["name"]
                    }
                } else {
                    &request["tool"]
                });
                let name = name.rsplit("__").next().unwrap_or(&name).to_string();
                let status = s(&b["status"]);
                let note = match status.as_str() {
                    "error" => " (failed)",
                    "cancelled" => " (declined)",
                    _ => "",
                };
                out.push_str(&format!(
                    "\n> Tool: `{name}`{note}\n> Status: {}\n> Timestamp: {}\n",
                    if status.is_empty() {
                        "unknown"
                    } else {
                        &status
                    },
                    timestamp(m)
                ));
                if !request.is_null() {
                    let args = if !request["args"].is_null() {
                        &request["args"]
                    } else {
                        request
                    };
                    out.push_str("\n<details>\n<summary>Tool arguments</summary>\n\n");
                    out.push_str(&code_block(
                        &serde_json::to_string_pretty(args).unwrap_or_else(|_| args.to_string()),
                    ));
                    out.push_str("\n</details>\n");
                }
                if !b["output"].is_null() {
                    out.push_str("\n<details>\n<summary>Tool output");
                    if b["output_type"].as_str().is_some_and(|v| !v.is_empty()) {
                        out.push_str(&format!(" ({})", html_escape(&s(&b["output_type"]))));
                    }
                    out.push_str("</summary>\n\n");
                    out.push_str(&code_block(&s(&b["output"])));
                    out.push_str("\n</details>\n");
                }
            }
            "notice" => out.push_str(&format!("\n*{}*\n", s(&b["text"]).trim())),
            "error" => {
                let t = if b.is_string() {
                    s(b)
                } else {
                    s(&b["message"])
                };
                out.push_str(&format!("\n> Error: {}\n", t.trim()));
            }
            _ => continue,
        }
        last = if role == "tool" { "tool" } else { role };
    }
    out.push_str("\n---\n\nDiagnostic limits: tool outputs are stored with a maximum of 6,000 characters, so longer outputs are truncated.\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fences_exceed_embedded_runs_even_when_the_text_ends_normally() {
        let raw = "before\n```\n</details>\n``````\nafter";
        let fenced = code_block(raw);
        assert_eq!(fenced.lines().next(), Some("```````"));
        assert!(fenced.contains(raw));
        assert_eq!(fenced.lines().last(), Some("```````"));
    }

    #[test]
    fn includes_thinking_only_and_combined_assistant_records() {
        let msgs = vec![
            json!({"role": "assistant", "ts": 10, "body": {"thinking": "reasoning only"}}),
            json!({"role": "assistant", "ts": 20, "body": {"text": "Answer", "thinking": "worked it out"}}),
        ];
        let md = chat_markdown("Test", &msgs);
        assert_eq!(md.matches("## Assistant").count(), 1);
        assert_eq!(md.matches("<summary>Thinking</summary>").count(), 2);
        assert!(md.contains("reasoning only"));
        assert!(md.contains("\nAnswer\n"));
    }

    #[test]
    fn exports_tool_diagnostics_safely_with_status_and_timestamp() {
        let msgs = vec![json!({"role": "tool", "ts": 1234, "body": {
            "status": "error", "name": "mcp__files__read", "output_type": "text</summary><script>alert(1)</script>",
            "request": {"tool": "mcp__files__read", "args": {"path": "</details> ``` <script>"}},
            "output": "failed </details> ```\n```"
        }})];
        let md = chat_markdown("Test", &msgs);
        assert!(md.contains("> Tool: `read` (failed)"));
        assert!(md.contains("> Status: error"));
        assert!(md.contains("> Timestamp: 1234 ms since Unix epoch"));
        assert!(md.contains("<summary>Tool arguments</summary>"));
        assert!(md.contains("<summary>Tool output (text&lt;/summary&gt;&lt;script&gt;alert(1)&lt;/script&gt;)</summary>"));
        assert!(!md.contains("text</summary>"));
        assert!(
            md.contains("</details>"),
            "code contents should remain exact"
        );
        assert!(md.contains("<script>"), "code contents should remain exact");
        assert!(
            md.contains("\n````\nfailed </details> ```\n```\n````\n"),
            "fence must exceed the longest embedded backtick run"
        );
        assert!(md.contains(
            "Diagnostic limits: tool outputs are stored with a maximum of 6,000 characters"
        ));
    }

    #[test]
    fn preserves_normal_turn_text_and_failed_tool_notes() {
        let msgs = vec![
            json!({"role": "user", "ts": 7, "body": {"text": "Hi"}}),
            json!({"role": "assistant", "body": {"text": "Looking."}}),
            json!({"role": "tool", "ts": 42, "body": {"name": "browser", "status": "cancelled", "request": {"name": "mcp__w__browser"}, "output": "stopped"}}),
            json!({"role": "assistant", "body": {"text": "Done."}}),
        ];
        let md = chat_markdown("Test", &msgs);
        assert_eq!(md.matches("## Assistant").count(), 1);
        assert!(md.contains("## You\n\n> Timestamp: 7 ms since Unix epoch\n\nHi"));
        assert!(md.contains("> Tool: `browser` (declined)"));
        assert!(md.contains("\nDone.\n"));
        assert!(md.contains("> Timestamp: 42 ms since Unix epoch"));
    }
}
