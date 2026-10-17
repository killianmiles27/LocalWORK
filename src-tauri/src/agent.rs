//! One aionrs process per conversation, spoken to over JSON Lines (--json-stream).
//! The host owns the approval policy: aionrs runs in its default "ask for everything" mode and every
//! tool_request is answered here, either automatically by policy or by the user through the UI.
use crate::{documents, paths, policy, store, strata, supervisor};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

pub type Db = Arc<Mutex<Connection>>;

const SYSTEM_PROMPT: &str = include_str!("../system-prompt.md");

#[derive(Default)]
struct Inner {
    stdin: Option<ChildStdin>,
    ready: bool,
    processing: bool,
    queue: Vec<Value>,
    remembered: Vec<String>,
    pending: HashMap<String, Value>,
}

pub struct Agent {
    pub conv: String,
    pub workspace: PathBuf,
    child: Mutex<Option<Child>>,
    inner: Mutex<Inner>,
    auto_edit: Mutex<bool>,
    stopping: AtomicBool,
}

pub type Agents = Arc<Mutex<HashMap<String, Arc<Agent>>>>;

fn write_line(inner: &mut Inner, v: &Value) {
    if let Some(s) = inner.stdin.as_mut() {
        let _ = writeln!(s, "{}", v);
        let _ = s.flush();
    }
}

fn dispatch_next(inner: &mut Inner) {
    // aionrs handles approvals/Stop while running a message, but drops additional
    // Message commands. Serialize user turns and internal /context requests.
    if inner.ready && !inner.processing && !inner.queue.is_empty() {
        let message = inner.queue.remove(0);
        inner.processing = true;
        write_line(inner, &message);
    }
}

// Preserve a document before known file mutations, including approved MCP OfficeCLI edits.
// Arbitrary shell scripts are outside this guarantee; never describe this as a filesystem sandbox.
fn mutation_path<'a>(category: &str, tool: &str, args: &'a Value) -> Option<&'a str> {
    let args = args.get("arguments").unwrap_or(args);
    if category == "edit" {
        return ["file_path", "path", "filePath", "output", "file"].iter()
            .find_map(|key| args.get(*key).and_then(Value::as_str));
    }
    if tool.to_lowercase().ends_with("officecli") {
        let argv = args.get("args")?.as_array()?;
        let command = argv.first()?.as_str()?.to_ascii_lowercase();
        if !matches!(command.as_str(), "view" | "get" | "query" | "list" | "validate" | "verify" | "info" | "help" | "inspect" | "read" | "page_count") {
            return argv.get(1)?.as_str();
        }
    }
    None
}

fn preserve_document(workspace: &std::path::Path, category: &str, tool: &str, args: &Value, explicitly_approved: bool) -> Result<(), String> {
    if let Some(path) = mutation_path(category, tool, args) {
        // An explicit outside-workspace approval retains its original meaning. This workspace's
        // history does not ingest files from other folders as a side effect of that approval.
        if explicitly_approved {
            if let (Ok(root), Ok(file)) = (workspace.canonicalize(), workspace.join(path).canonicalize()) {
                if !file.starts_with(root) { return Ok(()); }
            }
        }
        documents::snapshot(workspace, path).map_err(|e| format!("Could not preserve the previous document revision: {e}. The edit was not approved."))?;
    }
    Ok(())
}

#[cfg(test)]
mod revision_tests {
    use super::*;

    #[test]
    fn mutation_capture_covers_direct_edits_and_office_batches_only() {
        let direct = json!({"file_path":"memo.md"});
        assert_eq!(mutation_path("edit", "Write", &direct), Some("memo.md"));
        let batch = json!({"arguments":{"args":["batch", "deck.pptx", "--input", ".build.json"]}});
        assert_eq!(mutation_path("mcp", "workbench__officecli", &batch), Some("deck.pptx"));
        assert!(mutation_path("mcp", "workbench__officecli", &json!({"args":["view","deck.pptx","html"]})).is_none());
        assert!(mutation_path("mcp", "workbench__officecli", &json!({"args":["verify","report.docx"]})).is_none());
        assert!(mutation_path("exec", "ExecCommand", &json!({"command":"arbitrary script"})).is_none());
    }

    #[test]
    fn explicit_external_edit_is_not_blocked_by_workspace_history() {
        let temp = std::env::temp_dir().join(format!("lw-revision-approval-{:016x}", rand::random::<u64>()));
        let workspace = temp.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let external = temp.join("outside.md");
        std::fs::write(&external, "original").unwrap();
        let args = json!({"file_path":external.to_str().unwrap()});
        assert!(preserve_document(&workspace, "edit", "Write", &args, true).is_ok());
        assert_eq!(std::fs::read_to_string(&external).unwrap(), "original");
        // Both paths are freshly created descendants of the unique test directory.
        std::fs::remove_file(external).unwrap();
        std::fs::remove_dir(workspace).unwrap();
        std::fs::remove_dir(temp).unwrap();
    }
}

impl Agent {
    pub fn set_auto_edit(&self, v: bool) {
        *self.auto_edit.lock().unwrap() = v;
    }

    pub fn send(&self, msg: Value) {
        let mut g = self.inner.lock().unwrap();
        g.queue.push(msg);
        dispatch_next(&mut g);
    }

    pub fn stop_turn(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let mut g = self.inner.lock().unwrap();
        write_line(&mut g, &json!({"type": "stop"}));
    }

    pub fn answer(&self, call_id: &str, allow: bool, remember: bool) {
        let tool = self.inner.lock().unwrap().pending.remove(call_id);
        let Some(tool) = tool else { return };
        if allow {
            let name = tool.get("tool").and_then(Value::as_str).unwrap_or("");
            let category = tool.get("category").and_then(Value::as_str).unwrap_or("");
            if let Err(reason) = preserve_document(&self.workspace, category, name, &tool["args"], true) {
                write_line(&mut self.inner.lock().unwrap(), &json!({"type":"tool_deny", "call_id":call_id, "reason":reason}));
                return;
            }
            let mut g = self.inner.lock().unwrap();
            if remember {
                g.remembered.push(name.to_string());
            }
            write_line(&mut g, &json!({"type": "tool_approve", "call_id": call_id, "scope": "once"}));
        } else {
            write_line(&mut self.inner.lock().unwrap(), &json!({"type": "tool_deny", "call_id": call_id, "reason": "The user declined this action."}));
        }
    }

    /// Close stdin (clean exit), give it a moment, then kill the tree.
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        {
            let mut g = self.inner.lock().unwrap();
            g.stdin = None;
        }
        let child = self.child.lock().unwrap().take();
        if let Some(mut c) = child {
            let pid = c.id();
            for _ in 0..5 {
                if matches!(c.try_wait(), Ok(Some(_))) {
                    supervisor::forget(&paths::data_dir(), pid);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            supervisor::kill_tree(pid);
            let _ = c.wait();
            supervisor::forget(&paths::data_dir(), pid);
        }
    }
}

const COMPACT_MARK: &str = "# managed by LocalWORK";

/// Keep the model's real window in the project config while preserving unrelated settings.
fn compact_config(old: &str, window: u64) -> Result<String, String> {
    let mut config = old.parse::<toml_edit::DocumentMut>().map_err(|e| format!("Invalid .aionrs.toml: {e}"))?;
    let reserve = (window / 10).clamp(1024, 4096).min(window / 4);
    let trigger = window * 8 / 10;
    let buffer = window.saturating_sub(reserve).saturating_sub(trigger);
    if config.get("compact").is_none() {
        config["compact"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let compact = config["compact"].as_table_like_mut().ok_or("The compact configuration must be a TOML table")?;
    compact.insert("enabled", toml_edit::value(true));
    for (key, value) in [("context_window", window), ("output_reserve", reserve), ("autocompact_buffer", buffer), ("autocompact_threshold_pct", 80), ("emergency_buffer", (window / 20).min(1500))] {
        compact.insert(key, toml_edit::value(i64::try_from(value).map_err(|_| "Context limit is too large")?));
    }
    let text = config.to_string();
    Ok(if old.is_empty() { format!("{COMPACT_MARK}\n{text}") } else { text })
}

fn write_compact_config(workspace: &std::path::Path) -> Result<(), String> {
    let path = workspace.join(".aionrs.toml");
    let old = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("Could not read context configuration {}: {e}", path.display())),
    };
    let text = compact_config(&old, strata::context_window())?;
    if text != old {
        std::fs::write(&path, text).map_err(|e| format!("Could not configure automatic context compaction {}: {e}", path.display()))?;
    }
    Ok(())
}

/// aionrs reports a projected percentage, not exact token counts (the counts use rounded k suffixes).
fn context_percent(message: &str) -> Option<f64> {
    if !message.starts_with("Context Usage") { return None; }
    message.lines().find_map(|line| {
        let (counts, rest) = line.trim().split_once(" tokens (")?;
        if !counts.contains('/') { return None; }
        let pct = rest.split('%').next()?.parse::<f64>().ok()?;
        (pct.is_finite() && pct >= 0.0).then_some(pct)
    })
}

pub fn get_or_start(
    app: &AppHandle,
    agents: &Agents,
    db: &Db,
    st: &strata::Shared,
    conv: &str,
) -> Result<Arc<Agent>, String> {
    if let Some(a) = agents.lock().unwrap().get(conv) {
        return Ok(a.clone());
    }
    let (workspace, has_session) = {
        let c = db.lock().unwrap();
        let (_, ws, hs) = store::conv_info(&c, conv).ok_or("unknown conversation")?;
        (PathBuf::from(ws), hs)
    };
    let (port, key, model) = {
        let g = st.lock().unwrap();
        if g.status.state != "ready" {
            return Err("The model is not ready yet.".into());
        }
        (g.status.port, g.key.clone(), g.status.model.clone())
    };
    write_compact_config(&workspace)?;
    let vendor = paths::vendor_dir();
    let exe = vendor.join("aionrs.exe");
    let mut cmd = Command::new(&exe);
    cmd.args(["--json-stream", "--provider", "openai", "--base-url", &format!("http://127.0.0.1:{port}/v1")])
        .args(["--api-key", &key, "--model", &model, "--max-turns", "60", "--no-color"])
        // Without this aionrs asks for 20k output tokens, which cannot fit (or compact) in a 32k window.
        .args(["--max-tokens", &(strata::context_window() / 8).clamp(1024, 4096).to_string()])
        .args(["--system-prompt", &system_prompt(&db)])
        .arg("--project-dir")
        .arg(&workspace);
    if has_session {
        cmd.args(["--resume", conv]);
    } else {
        cmd.args(["--session-id", conv]);
    }
    cmd.current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(
            std::fs::File::create(paths::data_dir().join("logs").join(format!("agent-{conv}.log"))).map_err(|e| e.to_string())?,
        ));
    supervisor::hidden(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not start the agent: {e}"))?;
    let pid = child.id();
    supervisor::record(
        &paths::data_dir(),
        supervisor::PidRec { pid, exe: exe.to_string_lossy().to_string(), role: format!("agent:{conv}") },
    );
    let stdout = child.stdout.take().ok_or("no agent stdout")?;
    let stdin = child.stdin.take().ok_or("no agent stdin")?;
    let agent = Arc::new(Agent {
        conv: conv.to_string(),
        workspace: workspace.clone(),
        child: Mutex::new(Some(child)),
        inner: Mutex::new(Inner { stdin: Some(stdin), ..Default::default() }),
        auto_edit: Mutex::new(store::kv_get(&db.lock().unwrap(), "auto_edit").map(|v| v != "0").unwrap_or(true)),
        stopping: AtomicBool::new(false),
    });
    agents.lock().unwrap().insert(conv.to_string(), agent.clone());

    let (a2, app2, db2, agents2) = (agent.clone(), app.clone(), db.clone(), agents.clone());
    std::thread::spawn(move || reader(a2, app2, db2, agents2, stdout, pid));
    agent.send(json!({"type": "message", "msg_id": "ctx-initial", "content": "/context"}));
    Ok(agent)
}

fn skill_list() -> String {
    let mut rows = vec![];
    if let Ok(rd) = std::fs::read_dir(paths::resource_dir("skills")) {
        for e in rd.flatten() {
            let Ok(t) = std::fs::read_to_string(e.path().join("SKILL.md")) else { continue };
            let field = |k: &str| t.lines().find_map(|l| l.strip_prefix(&format!("{k}:")).map(|v| v.trim().to_string()));
            if let (Some(n), Some(d)) = (field("name"), field("description")) {
                if n != "officecli-basics" {
                    rows.push(format!("- {n}: {d}"));
                }
            }
        }
    }
    rows.sort();
    if rows.is_empty() { String::new() } else {
        format!("

# Skills
For these kinds of task, call the load_skill tool with the skill name first and follow it:
{}", rows.join("
"))
    }
}

fn system_prompt(db: &Db) -> String {
    // Cross-chat memory is switched off: every chat starts fresh and knows nothing about the user.
    let _ = db;
    let notes: Vec<(i64, String)> = vec![];
    let base = format!("{SYSTEM_PROMPT}{}", skill_list());
    if notes.is_empty() {
        return base;
    }
    let list: Vec<String> = notes.iter().map(|(_, t)| format!("- {t}")).collect();
    format!("{base}

# What you remember about the user
{}
(Use memory_search for older notes. Save new durable facts with memory_save.)", list.join("
"))
}

fn workbench_mcp(app_vendor: &std::path::Path, conv: &str) -> Option<Value> {
    let root = PathBuf::from(
        std::fs::read_to_string(paths::data_dir().join("settings.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.get("strataRoot").and_then(|x| x.as_str().map(String::from)))
            .unwrap_or_else(|| paths::DEFAULT_STRATA_ROOT.to_string()),
    );
    let python = root.join(".venv").join("Scripts").join("python.exe");
    let script = paths::resource_dir("workbench-mcp").join("server.py");
    if !python.exists() || !script.exists() {
        return None;
    }
    Some(json!({
        "type": "add_mcp_server", "name": "workbench", "transport": "stdio",
        "command": python.to_string_lossy(),
        "args": ["-u", script.to_string_lossy()],
        "env": {
            "OFFICECLI_EXE": app_vendor.join("officecli.exe").to_string_lossy(),
            "WORKBENCH_DATA": paths::data_dir().join("cache").to_string_lossy(),
            "WORKBENCH_DB": paths::data_dir().join("workbench.db").to_string_lossy(),
            "WORKBENCH_SKILLS": paths::resource_dir("skills").to_string_lossy(),
            "BROWSER_NODE": app_vendor.join("node").join("node.exe").to_string_lossy(),
            "BROWSER_CLI": app_vendor.join("playwright").join("node_modules").join("@playwright").join("cli").join("playwright-cli.js").to_string_lossy(),
            "BROWSER_BROWSERS": app_vendor.join("browsers").to_string_lossy(),
            "BROWSER_PROFILES": paths::data_dir().join("browser").to_string_lossy(),
            "BROWSER_SESSION": conv.chars().take(12).collect::<String>()
        }
    }))
}

/// Name a new chat from its first exchange, using the already-running model with a tiny prompt.
fn maybe_title(app: &AppHandle, db: &Db, conv: &str) {
    let key = format!("titled:{conv}");
    let (first_user, first_reply) = {
        let c = db.lock().unwrap();
        if store::kv_get(&c, &key).is_some() { return; }
        let msgs = store::messages(&c, conv);
        let pick = |role: &str| msgs.iter().find(|m| m["role"] == role).and_then(|m| m["body"]["text"].as_str()).map(String::from);
        let (Some(u), Some(a)) = (pick("user"), pick("assistant")) else { return };
        store::kv_set(&c, &key, "1");
        (u, a)
    };
    let st = app.state::<crate::App>().strata.clone();
    let (db, app, conv) = (db.clone(), app.clone(), conv.to_string());
    std::thread::spawn(move || {
        let (port, bearer, model) = {
            let g = st.lock().unwrap();
            if g.status.state != "ready" { return; }
            (g.status.port, g.key.clone(), g.status.model.clone())
        };
        let clip = |t: &str| -> String { t.chars().take(500).collect() };
        let body = json!({
            "model": model,
            "messages": [
                {"role": "system", "content": "Write a title of at most 5 words for this chat. Reply with only the title: no quotes, no trailing punctuation."},
                {"role": "user", "content": format!("User: {}

Assistant: {}", clip(&first_user), clip(&first_reply))}
            ],
            "stream": false, "temperature": 0.2, "max_tokens": 24,
            "chat_template_kwargs": {"enable_thinking": false},
        }).to_string();
        let Some((200, raw)) = crate::http::post_json(port, "/v1/chat/completions", Some(&bearer), &body, std::time::Duration::from_secs(60)) else { return };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else { return };
        let t = v["choices"][0]["message"]["content"].as_str().unwrap_or("");
        let t: String = t.lines().next().unwrap_or("").trim().trim_matches(|c| matches!(c, '"' | '\'' | '*' | '.')).trim().chars().take(60).collect();
        if t.len() < 3 { return; }
        store::rename(&db.lock().unwrap(), &conv, &t);
        let _ = app.emit("agent-event", json!({"conv": conv, "ev": {"type": "title"}}));
    });
}

fn flush_text(db: &Db, conv: &str, text: &mut String, thinking: &mut String) {
    if text.trim().is_empty() && thinking.trim().is_empty() {
        text.clear();
        thinking.clear();
        return;
    }
    let c = db.lock().unwrap();
    store::add_msg(&c, conv, "assistant", &json!({"text": text.as_str(), "thinking": thinking.as_str()}));
    text.clear();
    thinking.clear();
}

fn reader(agent: Arc<Agent>, app: AppHandle, db: Db, agents: Agents, stdout: std::process::ChildStdout, pid: u32) {
    let conv = agent.conv.clone();
    let vendor = paths::vendor_dir();
    let mut text = String::new();
    let mut thinking = String::new();
    let mut tool_args: HashMap<String, Value> = HashMap::new();
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(ev) = serde_json::from_str::<Value>(&line) else { continue };
        // Do not approve buffered tools or forward stale UI events after Stop.
        if agent.stopping.load(Ordering::SeqCst) { continue; }
        let ty = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "ready" => {
                {
                    let c = db.lock().unwrap();
                    store::set_has_session(&c, &conv);
                }
                let mcp = workbench_mcp(&vendor, &conv);
                let mut g = agent.inner.lock().unwrap();
                if let Some(m) = mcp {
                    write_line(&mut g, &m);
                } else {
                    g.ready = true;
                    dispatch_next(&mut g);
                }
            }
            "mcp_ready" => {
                let mut g = agent.inner.lock().unwrap();
                g.ready = true;
                dispatch_next(&mut g);
            }
            "text_delta" => text.push_str(ev.get("text").and_then(|t| t.as_str()).unwrap_or("")),
            "thinking" => thinking.push_str(ev.get("text").and_then(|t| t.as_str()).unwrap_or("")),
            "tool_request" => {
                flush_text(&db, &conv, &mut text, &mut thinking);
                let tool = &ev["tool"];
                let name = tool.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let cat = tool.get("category").and_then(|v| v.as_str()).unwrap_or("mcp").to_string();
                let args = tool.get("args").cloned().unwrap_or(Value::Null);
                let call_id = ev.get("call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                tool_args.insert(call_id.clone(), json!({"name": name, "args": args}));
                let auto_edit = *agent.auto_edit.lock().unwrap();
                let remembered = agent.inner.lock().unwrap().remembered.clone();
                match policy::decide(&name, &cat, &args, &agent.workspace, auto_edit, &remembered) {
                    policy::Decision::Allow => {
                        if let Err(reason) = preserve_document(&agent.workspace, &cat, &name, &args, false) {
                            write_line(&mut agent.inner.lock().unwrap(), &json!({"type":"tool_deny", "call_id":call_id, "reason":reason}));
                            continue;
                        }
                        let mut g = agent.inner.lock().unwrap();
                        if !agent.stopping.load(Ordering::SeqCst) {
                            write_line(&mut g, &json!({"type": "tool_approve", "call_id": call_id, "scope": "once"}));
                        }
                    }
                    policy::Decision::Deny(why) => {
                        let mut g = agent.inner.lock().unwrap();
                        write_line(&mut g, &json!({"type": "tool_deny", "call_id": call_id, "reason": why}));
                    }
                    policy::Decision::Ask { class, reason, can_remember } => {
                        if agent.stopping.load(Ordering::SeqCst) { continue; }
                        agent.inner.lock().unwrap().pending.insert(call_id.clone(), json!({"tool": name, "category": cat, "args": args}));
                        let _ = app.emit(
                            "approval-request",
                            json!({"conv": conv, "call_id": call_id, "tool": name, "class": class, "reason": reason,
                                   "description": tool.get("description"), "args": args, "can_remember": can_remember}),
                        );
                    }
                }
            }
            "tool_result" => {
                let call_id = ev.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                let ta = tool_args.remove(call_id).unwrap_or(Value::Null);
                let out = ev.get("output").and_then(|v| v.as_str()).unwrap_or("");
                let clipped: String = out.chars().take(6000).collect();
                let c = db.lock().unwrap();
                store::add_msg(
                    &c,
                    &conv,
                    "tool",
                    &json!({"call_id": call_id, "name": ev.get("tool_name"), "status": ev.get("status"),
                            "output": clipped, "output_type": ev.get("output_type"), "request": ta}),
                );
            }
            "tool_cancelled" => {
                let call_id = ev.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                let ta = tool_args.remove(call_id).unwrap_or(Value::Null);
                let c = db.lock().unwrap();
                store::add_msg(&c, &conv, "tool", &json!({"call_id": call_id, "status": "cancelled", "output": ev.get("reason"), "request": ta}));
            }
            "info" => {
                let m = ev.get("message").and_then(|v| v.as_str()).unwrap_or("");
                if m.starts_with("Autocompact: summarized") || m.starts_with("Context compacted") {
                    store::add_msg(&db.lock().unwrap(), &conv, "notice", &json!({"text": "Earlier messages were summarized to free up space."}));
                    // After a manual /compact the agent is idle: ask for the new size ("Context Usage" info).
                    if m.starts_with("Context compacted") {
                        agent.send(json!({"type": "message", "msg_id": "ctx-after-compact", "content": "/context"}));
                    }
                } else if m.starts_with("Context Usage") {
                    if let Some(pct) = context_percent(m) {
                        let used = (pct / 100.0 * strata::context_window() as f64).round() as u64;
                        store::kv_set(&db.lock().unwrap(), &format!("ctx:{conv}"), &used.to_string());
                        let _ = app.emit("agent-event", json!({"conv": conv, "ev": {"type": "context_usage", "used": used, "window": strata::context_window()}}));
                    }
                }
            }
            "stream_end" | "error" => {
                // stream_end usage adds up every request of a turn (and any compaction), so it overstates the
                // window. After a turn ask aionrs for its current projection; /context makes no model call.
                if ty == "stream_end" && !ev["msg_id"].as_str().unwrap_or("").starts_with("ctx-") {
                    agent.send(json!({"type": "message", "msg_id": "ctx-refresh", "content": "/context"}));
                }
                let answered = ty == "stream_end" && !text.trim().is_empty();
                flush_text(&db, &conv, &mut text, &mut thinking);
                if answered {
                    maybe_title(&app, &db, &conv);
                }
                if ty == "error" {
                    let c = db.lock().unwrap();
                    store::add_msg(&c, &conv, "error", &ev["error"]);
                }
                if ty == "stream_end" {
                    let mut g = agent.inner.lock().unwrap();
                    g.processing = false;
                    dispatch_next(&mut g);
                }
            }
            _ => {}
        }
        if !agent.stopping.load(Ordering::SeqCst) && !ev["msg_id"].as_str().unwrap_or("").starts_with("ctx-") {
            let _ = app.emit("agent-event", json!({"conv": conv, "ev": ev}));
        }
    }
    // Process ended (closed by us, crashed, or killed).
    flush_text(&db, &conv, &mut text, &mut thinking);
    supervisor::forget(&paths::data_dir(), pid);
    let mut active = agents.lock().unwrap();
    // A stopped process may finish draining after a replacement was started.
    if active.get(&conv).is_none_or(|current| Arc::ptr_eq(current, &agent)) {
        active.remove(&conv);
        let _ = app.emit("agent-event", json!({"conv": conv, "ev": {"type": "agent_exit"}}));
    }
}

#[cfg(test)]
mod context_tests {
    use super::*;
    #[test]
    fn context_uses_total_percentage_only() {
        assert_eq!(context_percent("Context Usage\n  2.0k/32.8k tokens (6.0%)\n  Free space: 30.8k tokens (94.0%)"), Some(6.0));
        assert_eq!(context_percent("Context Usage\n  Free space: 30.8k tokens (94.0%)"), None);
        assert_eq!(context_percent("Context Usage\n  0/1 tokens (NaN%)"), None);
    }
    #[test]
    fn compact_preserves_other_settings_and_is_idempotent() {
        let old = "model = \"custom\"\n[compact]\nenabled = false\ncontext_window = 200000\ncustom_setting = 42\n[provider]\nname = \"openai\"\n";
        let configured = compact_config(old, 4096).unwrap();
        assert!(configured.contains("custom_setting = 42"));
        assert!(configured.contains("[provider]\nname = \"openai\""));
        assert!(configured.contains("autocompact_threshold_pct = 80"));
        assert_eq!(configured.matches("context_window =").count(), 1);
        assert_eq!(compact_config(&configured, 4096).unwrap(), configured);
    }
    #[test]
    fn compact_supports_inline_and_quoted_tables_without_corrupting_config() {
        for old in ["compact = { enabled = false, context_window = 200000, max_failures = 5 }\n", "[\"compact\"]\nmax_failures = 5\n"] {
            let configured = compact_config(old, 32768).unwrap();
            let parsed = configured.parse::<toml_edit::DocumentMut>().unwrap();
            assert_eq!(parsed["compact"]["context_window"].as_integer(), Some(32768));
            assert_eq!(parsed["compact"]["max_failures"].as_integer(), Some(5));
            assert_eq!(compact_config(&configured, 32768).unwrap(), configured);
        }
        assert!(compact_config("[compact", 32768).is_err());
    }
}
