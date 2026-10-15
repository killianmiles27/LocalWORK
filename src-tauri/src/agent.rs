//! One aionrs process per conversation, spoken to over JSON Lines (--json-stream).
//! The host owns the approval policy: aionrs runs in its default "ask for everything" mode and every
//! tool_request is answered here, either automatically by policy or by the user through the UI.
use crate::{paths, policy, store, strata, supervisor};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub type Db = Arc<Mutex<Connection>>;

const SYSTEM_PROMPT: &str = include_str!("../system-prompt.md");

#[derive(Default)]
struct Inner {
    stdin: Option<ChildStdin>,
    ready: bool,
    queue: Vec<String>,
    remembered: Vec<String>,
    pending: HashMap<String, Value>,
}

pub struct Agent {
    pub conv: String,
    pub workspace: PathBuf,
    child: Mutex<Option<Child>>,
    inner: Mutex<Inner>,
    auto_edit: Mutex<bool>,
}

pub type Agents = Arc<Mutex<HashMap<String, Arc<Agent>>>>;

fn write_line(inner: &mut Inner, v: &Value) {
    if let Some(s) = inner.stdin.as_mut() {
        let _ = writeln!(s, "{}", v);
        let _ = s.flush();
    }
}

impl Agent {
    pub fn set_auto_edit(&self, v: bool) {
        *self.auto_edit.lock().unwrap() = v;
    }

    pub fn send(&self, msg: Value) {
        let mut g = self.inner.lock().unwrap();
        if g.ready {
            write_line(&mut g, &msg);
        } else {
            g.queue.push(msg.to_string());
        }
    }

    pub fn stop_turn(&self) {
        let mut g = self.inner.lock().unwrap();
        write_line(&mut g, &json!({"type": "stop"}));
    }

    pub fn answer(&self, call_id: &str, allow: bool, remember: bool) {
        let mut g = self.inner.lock().unwrap();
        let tool = g.pending.remove(call_id);
        if allow {
            if remember {
                if let Some(t) = tool.as_ref().and_then(|t| t.get("tool")).and_then(|t| t.as_str()) {
                    g.remembered.push(t.to_string());
                }
            }
            write_line(&mut g, &json!({"type": "tool_approve", "call_id": call_id, "scope": "once"}));
        } else {
            write_line(&mut g, &json!({"type": "tool_deny", "call_id": call_id, "reason": "The user declined this action."}));
        }
    }

    /// Close stdin (clean exit), give it a moment, then kill the tree.
    pub fn shutdown(&self) {
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
    let vendor = paths::vendor_dir();
    let exe = vendor.join("aionrs.exe");
    let mut cmd = Command::new(&exe);
    cmd.args(["--json-stream", "--provider", "openai", "--base-url", &format!("http://127.0.0.1:{port}/v1")])
        .args(["--api-key", &key, "--model", &model, "--max-turns", "30", "--no-color"])
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
        auto_edit: Mutex::new(false),
    });
    agents.lock().unwrap().insert(conv.to_string(), agent.clone());

    let (a2, app2, db2, agents2) = (agent.clone(), app.clone(), db.clone(), agents.clone());
    std::thread::spawn(move || reader(a2, app2, db2, agents2, stdout, pid));
    Ok(agent)
}

fn system_prompt(db: &Db) -> String {
    let notes = { let c = db.lock().unwrap(); store::recent_memories(&c, 8) };
    if notes.is_empty() {
        return SYSTEM_PROMPT.to_string();
    }
    let list: Vec<String> = notes.iter().map(|(_, t)| format!("- {t}")).collect();
    format!("{SYSTEM_PROMPT}

# What you remember about the user
{}
(Use memory_search for older notes. Save new durable facts with memory_save.)", list.join("
"))
}

fn workbench_mcp(app_vendor: &std::path::Path) -> Option<Value> {
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
        "env": {"OFFICECLI_EXE": app_vendor.join("officecli.exe").to_string_lossy(), "WORKBENCH_DATA": paths::data_dir().join("cache").to_string_lossy(), "WORKBENCH_DB": paths::data_dir().join("workbench.db").to_string_lossy()}
    }))
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
        let ty = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "ready" => {
                {
                    let c = db.lock().unwrap();
                    store::set_has_session(&c, &conv);
                }
                let mcp = workbench_mcp(&vendor);
                let mut g = agent.inner.lock().unwrap();
                if let Some(m) = mcp {
                    write_line(&mut g, &m);
                } else {
                    g.ready = true;
                    let q: Vec<String> = std::mem::take(&mut g.queue);
                    for l in q {
                        if let Some(s) = g.stdin.as_mut() {
                            let _ = writeln!(s, "{l}");
                            let _ = s.flush();
                        }
                    }
                }
            }
            "mcp_ready" => {
                let mut g = agent.inner.lock().unwrap();
                g.ready = true;
                let q: Vec<String> = std::mem::take(&mut g.queue);
                for l in q {
                    if let Some(s) = g.stdin.as_mut() {
                        let _ = writeln!(s, "{l}");
                        let _ = s.flush();
                    }
                }
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
                        let mut g = agent.inner.lock().unwrap();
                        write_line(&mut g, &json!({"type": "tool_approve", "call_id": call_id, "scope": "once"}));
                    }
                    policy::Decision::Deny(why) => {
                        let mut g = agent.inner.lock().unwrap();
                        write_line(&mut g, &json!({"type": "tool_deny", "call_id": call_id, "reason": why}));
                    }
                    policy::Decision::Ask { class, reason, can_remember } => {
                        agent.inner.lock().unwrap().pending.insert(call_id.clone(), json!({"tool": name}));
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
            "stream_end" | "error" => {
                flush_text(&db, &conv, &mut text, &mut thinking);
                if ty == "error" {
                    let c = db.lock().unwrap();
                    store::add_msg(&c, &conv, "error", &ev["error"]);
                }
            }
            _ => {}
        }
        let _ = app.emit("agent-event", json!({"conv": conv, "ev": ev}));
    }
    // Process ended (closed by us, crashed, or killed).
    flush_text(&db, &conv, &mut text, &mut thinking);
    supervisor::forget(&paths::data_dir(), pid);
    agents.lock().unwrap().remove(&conv);
    let _ = app.emit("agent-event", json!({"conv": conv, "ev": {"type": "agent_exit"}}));
}
