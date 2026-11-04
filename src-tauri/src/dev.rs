//! Dev-only backend: an OpenAI-compatible bridge to the ChatGPT Codex subscription.
//!
//! LocalWORK normally runs Strata on loopback. Developers do not always want to load a 70 GB
//! model to click through the UI, so this starts `scripts/dev/codex_bridge.py` on loopback and
//! connects the app to it through the existing "server you run" path. Nothing here is used by
//! release builds unless it is explicitly enabled, and prompts leave this PC while it is on.
use crate::sync::LockExt;
use crate::{http, paths, python, setup, strata, supervisor, App};
use rand::Rng;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

struct Bridge {
    child: Child,
    pid: u32,
    port: u16,
}

static BRIDGE: Mutex<Option<Bridge>> = Mutex::new(None);
/// Probing a Python interpreter starts a process, so the Settings poll reuses the answer.
static INTERPRETER: Mutex<Option<(Instant, Result<PathBuf, String>)>> = Mutex::new(None);
const INTERPRETER_TTL: Duration = Duration::from_secs(60);

/// The dev bridge is offered to debug builds, to anyone who opts in with LOCALWORK_DEV_CODEX,
/// and to a machine that already configured one (so the option survives a release build).
pub fn available() -> bool {
    cfg!(debug_assertions) || std::env::var_os("LOCALWORK_DEV_CODEX").is_some() || saved().is_some()
}

fn saved() -> Option<Value> {
    setup::settings().get("devBridge").filter(|v| v.is_object()).cloned()
}

/// The bridge script, from LOCALWORK_CODEX_BRIDGE or by walking up from the app/dev build tree.
fn script() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("LOCALWORK_CODEX_BRIDGE").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    let roots = [std::env::current_dir().ok(), Some(paths::app_dir())];
    for start in roots.into_iter().flatten() {
        let mut cur = Some(start);
        for _ in 0..7 {
            let Some(dir) = cur else { break };
            let candidate = dir.join("scripts").join("dev").join("codex_bridge.py");
            if candidate.is_file() {
                return Some(candidate);
            }
            cur = dir.parent().map(Path::to_path_buf);
        }
    }
    None
}

fn interpreter() -> Result<PathBuf, String> {
    let setting = strata::setting("workbenchPython", "");
    let root = PathBuf::from(strata::setting("strataRoot", ""));
    python::find(
        Some(setting.as_str()).filter(|s| !s.trim().is_empty()),
        Some(root.as_path()).filter(|p| !p.as_os_str().is_empty()),
    )
    .map(|found| found.path)
    .ok_or_else(|| "The dev Codex bridge needs Python 3.11 or newer. Set it in Settings > Model > Tools, or install Python.".to_string())
}

fn interpreter_cached() -> Result<PathBuf, String> {
    let mut cache = INTERPRETER.guard();
    if let Some((at, found)) = cache.as_ref() {
        if at.elapsed() < INTERPRETER_TTL {
            return found.clone();
        }
    }
    let found = interpreter();
    *cache = Some((Instant::now(), found.clone()));
    found
}

fn log_path() -> PathBuf {
    paths::data_dir().join("logs").join("codex-bridge.log")
}

fn health(port: u16) -> Option<String> {
    match http::get(port, "/health", None, Duration::from_millis(500)) {
        Some((200, body)) => serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v.get("model").and_then(Value::as_str).map(String::from)),
        _ => None,
    }
}

fn running_bridge_port() -> Option<u16> {
    let mut guard = BRIDGE.guard();
    let Some(bridge) = guard.as_mut() else { return None };
    match bridge.child.try_wait() {
        Ok(None) => Some(bridge.port),
        _ => {
            let pid = bridge.pid;
            supervisor::forget(&paths::data_dir(), pid);
            guard.take();
            None
        }
    }
}

fn stop_bridge() -> bool {
    let bridge = BRIDGE.guard().take();
    let Some(mut bridge) = bridge else { return false };
    supervisor::kill_tree(bridge.pid);
    let _ = bridge.child.wait();
    supervisor::forget(&paths::data_dir(), bridge.pid);
    true
}

fn start_bridge(script: &Path, python: &Path, port: u16, key: &str, model: &str, effort: &str) -> Result<(), String> {
    if running_bridge_port().is_some() {
        return Ok(());
    }
    if let Some(existing) = health(port) {
        // A bridge from an earlier app run is still listening; reuse it instead of fighting the port.
        eprintln!("dev bridge already listening on {port} ({existing})");
        return Ok(());
    }
    let log = std::fs::File::create(log_path()).map_err(|e| format!("Could not create the bridge log: {e}"))?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(python);
    cmd.arg("-u")
        .arg(script)
        .args(["--port", &port.to_string(), "--model", model, "--effort", effort, "--context", "131072"])
        .env("CODEX_BRIDGE_KEY", key)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log2));
    supervisor::hidden(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the dev Codex bridge: {e}"))?;
    let pid = child.id();
    supervisor::record(
        &paths::data_dir(),
        supervisor::PidRec { pid, exe: python.to_string_lossy().to_string(), role: "codex-bridge".into() },
    );
    for _ in 0..60 {
        if health(port).is_some() {
            *BRIDGE.guard() = Some(Bridge { child, pid, port });
            return Ok(());
        }
        if let Ok(Some(code)) = child.try_wait() {
            supervisor::forget(&paths::data_dir(), pid);
            return Err(format!("The dev Codex bridge exited ({code}).{}", bridge_log_tail()));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    supervisor::kill_tree(pid);
    let _ = child.wait();
    supervisor::forget(&paths::data_dir(), pid);
    Err(format!("The dev Codex bridge did not answer /health within 15 seconds.{}", bridge_log_tail()))
}

fn bridge_log_tail() -> String {
    let text = std::fs::read_to_string(log_path()).unwrap_or_default();
    let tail: Vec<&str> = text.lines().rev().take(4).collect();
    if tail.is_empty() {
        String::new()
    } else {
        format!("\n{}", tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
    }
}

fn shutdown_agents(app: &App) {
    let agents: Vec<_> = app.agents.guard().drain().map(|(_, a)| a).collect();
    for agent in agents {
        agent.shutdown();
    }
}

fn state_json() -> Value {
    let live = running_bridge_port();
    let saved = saved().unwrap_or(Value::Null);
    json!({
        "available": available(),
        "running": live.is_some(),
        "port": live.or_else(|| saved.get("port").and_then(Value::as_u64).map(|p| p as u16)),
        "model": saved.get("model").and_then(Value::as_str).unwrap_or("gpt-6-luna"),
        "effort": saved.get("effort").and_then(Value::as_str).unwrap_or("low"),
        "source": strata::setting("modelSource", "strata"),
        "offline": setup::offline(),
        "script": script().map(|p| p.to_string_lossy().into_owned()),
        "python": interpreter_cached().ok().map(|p| p.to_string_lossy().into_owned()),
    })
}

#[tauri::command(async)]
pub fn dev_backend_state() -> Value {
    state_json()
}

/// Connect the app to a Codex subscription through the dev bridge. Restarts the model so the
/// agent picks up the new endpoint, exactly like choosing "a server you run" in the wizard.
#[tauri::command(async)]
pub fn dev_backend_enable(app: AppHandle, s: State<App>, model: Option<String>, effort: Option<String>) -> Result<Value, String> {
    if !available() {
        return Err("The developer backend is not enabled in this build.".into());
    }
    if setup::offline() {
        return Err("Offline mode is on. Turn it off first: the Codex backend sends prompts to OpenAI.".into());
    }
    let model = model.unwrap_or_else(|| "gpt-6-luna".into()).trim().to_string();
    if model.is_empty() || model.len() > 80 || !model.chars().all(|c| c.is_ascii_alphanumeric() || "-._/".contains(c)) {
        return Err("Use a plain model id, for example gpt-6-luna.".into());
    }
    let effort = effort.unwrap_or_else(|| "low".into());
    if !["none", "minimal", "low", "medium", "high", "xhigh"].contains(&effort.as_str()) {
        return Err("Effort must be none, minimal, low, medium, high or xhigh.".into());
    }
    let script = script().ok_or("Could not find scripts/dev/codex_bridge.py. Set LOCALWORK_CODEX_BRIDGE to its path.")?;
    let python = interpreter_cached()?;
    // A fresh port per connect keeps the saved recipe unambiguous, and a leftover bridge from an
    // earlier run cannot answer with a different model than the one chosen here.
    stop_bridge();
    let port = http::free_port();
    let key: String = rand::thread_rng().sample_iter(&rand::distributions::Alphanumeric).take(32).map(char::from).collect();
    start_bridge(&script, &python, port, &key, &model, &effort)?;
    // Keep the connection settings and the bridge start-up recipe together.
    setup::write_setting_value("serverPort", json!(port.to_string()))?;
    setup::write_setting_value("serverKey", json!(key.clone()))?;
    setup::write_setting_value("serverContext", json!("131072"))?;
    setup::write_setting_value("modelSource", json!("server"))?;
    setup::write_setting_value("devBridge", json!({
        "port": port, "key": key, "model": model, "effort": effort,
        "script": script.to_string_lossy(),
    }))?;
    shutdown_agents(&s);
    strata::stop(Some(&app), &s.strata);
    strata::start(&app, &s.strata)?;
    Ok(state_json())
}

/// Stop the bridge and go back to the normal Strata path. Agents restart on their next message.
#[tauri::command(async)]
pub fn dev_backend_disable(app: AppHandle, s: State<App>) -> Result<Value, String> {
    stop_bridge();
    setup::write_setting_value("modelSource", json!("strata"))?;
    setup::write_setting_value("devBridge", Value::Null)?;
    shutdown_agents(&s);
    strata::stop(Some(&app), &s.strata);
    let _ = strata::start(&app, &s.strata);
    Ok(state_json())
}

/// Start the saved bridge during app launch, before the model status is polled. Failures are
/// logged only: the normal "waiting for your model server" message still explains the state.
pub fn ensure_at_launch() {
    if !available() {
        return;
    }
    if setup::offline() {
        return;
    }
    let Some(saved) = saved() else { return };
    let (Some(port), Some(key)) = (saved.get("port").and_then(Value::as_u64), saved.get("key").and_then(Value::as_str)) else {
        return;
    };
    let port = port as u16;
    if health(port).is_some() {
        return;
    }
    let model = saved.get("model").and_then(Value::as_str).unwrap_or("gpt-6-luna");
    let effort = saved.get("effort").and_then(Value::as_str).unwrap_or("low");
    let Some(script) = script() else {
        eprintln!("dev bridge: script not found; set LOCALWORK_CODEX_BRIDGE");
        return;
    };
    match interpreter_cached() {
        Ok(python) => {
            if let Err(error) = start_bridge(&script, &python, port, key, model, effort) {
                eprintln!("dev bridge: {error}");
            }
        }
        Err(error) => eprintln!("dev bridge: {error}"),
    }
}

/// Stop the bridge with the rest of the app's children.
pub fn shutdown() {
    stop_bridge();
}
