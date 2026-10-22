//! First-run wizard support (hardware check, Strata folder detection) and the Strata update check.
use crate::{paths, strata, supervisor, App};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, State};

/// Set from the "web access" choice; policy.rs denies the web tools while this is true.
pub static WEB_OFF: AtomicBool = AtomicBool::new(false);
/// Offline mode: the app itself makes no internet requests. Web and SSH tools are denied, and the plugin store
/// and update checks refuse. Chats that ran offline remember it (kv `offline_chat:<id>`) and stay offline until
/// the user lets them go online again. Approved shell commands and third-party plugin programs are not sandboxed.
pub static OFFLINE: AtomicBool = AtomicBool::new(false);

fn run(prog: &str, args: &[&str], dir: Option<&PathBuf>) -> Option<String> {
    let mut c = Command::new(prog);
    c.args(args);
    if let Some(d) = dir {
        c.current_dir(d);
    }
    supervisor::hidden(&mut c);
    let o = c.output().ok()?;
    if !o.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn strata_root() -> PathBuf {
    PathBuf::from(strata::setting("strataRoot", &paths::default_strata_root()))
}

fn strata_ok(root: &PathBuf) -> bool {
    root.join(".venv").join("Scripts").join("python.exe").exists() && root.join("serve").join("server.py").exists()
}

/// PolyStrata is a Strata fork with the same folder layout and server; its root has polystrata.py.
pub fn engine(root: &PathBuf) -> &'static str {
    if root.join("polystrata.py").is_file() { "PolyStrata" } else { "Strata" }
}

fn engine_repo(root: &PathBuf) -> &'static str {
    if root.join("polystrata.py").is_file() { "github.com/VecSzn/PolyStrata" } else { "github.com/Niko1221/Strata" }
}

fn model_config_ok(path: &str) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("args").and_then(Value::as_array).map(|_| ()))
        .is_some()
}

#[tauri::command(async)]
pub fn hardware_check() -> Value {
    use sysinfo::{Disks, System};
    let mut sys = System::new();
    sys.refresh_memory();
    let ram = sys.total_memory() as f64 / 1024f64.powi(3);
    let root = strata_root();
    let disks = Disks::new_with_refreshed_list();
    let free = disks
        .iter()
        .filter(|d| root.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .or_else(|| disks.iter().next())
        .map(|d| d.available_space() as f64 / 1024f64.powi(3));
    let gpu = run("nvidia-smi", &["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"], None).and_then(|t| {
        let l = t.lines().next()?.to_string();
        let p: Vec<&str> = l.split(',').map(|x| x.trim()).collect();
        if p.len() < 3 {
            return None;
        }
        Some(json!({"name": p[0], "vram_gib": p[1].parse::<f64>().ok().map(|m| m / 1024.0), "driver": p[2]}))
    });
    json!({
        "ram_gib": ram, "disk_free_gib": free, "gpu": gpu,
        "strata_root": root.to_string_lossy(), "strata_found": strata_ok(&root), "engine": engine(&root),
        "model_config_found": model_config_ok(&strata::setting("modelConfig", &paths::default_model_config())),
        "model_source": strata::setting("modelSource", "strata"),
        "server_port": strata::setting("serverPort", "8080"),
    })
}

/// Look for an OpenAI-compatible server the user already runs: the given port, or the usual ones
/// (llama.cpp/Strata 8080, LM Studio 1234, Ollama 11434, vLLM 8000, SGLang 30000). Only 127.0.0.1 is ever contacted.
#[tauri::command(async)]
pub fn probe_model_server(port: Option<u16>, key: Option<String>) -> Value {
    let key = key.filter(|k| !k.trim().is_empty());
    let ports: Vec<u16> = port.map(|p| vec![p]).unwrap_or_else(|| vec![8080, 1234, 11434, 8000, 30000]);
    let mut last = String::new();
    for p in ports {
        match strata::probe(p, key.as_deref()) {
            Ok(model) => return json!({"ok": true, "port": p, "model": model}),
            Err(e) => last = e,
        }
    }
    json!({"ok": false, "error": if port.is_some() { last } else { "No model server found on ports 8080, 1234, 11434, 8000 or 30000.".into() }})
}

/// Use a server the user runs. Checked before it is saved; the app will not start or stop it.
#[tauri::command(async)]
pub fn set_model_server(port: u16, key: Option<String>, context: Option<u64>) -> Result<Value, String> {
    let key = key.unwrap_or_default().trim().to_string();
    let model = strata::probe(port, if key.is_empty() { None } else { Some(&key) })?;
    write_setting("serverPort", &port.to_string())?;
    write_setting("serverKey", &key)?;
    write_setting("serverContext", &context.filter(|c| *c >= 4096).unwrap_or(32768).to_string())?;
    write_setting("modelSource", "server")?;
    Ok(json!({"ok": true, "model": model}))
}

/// Go back to letting the app launch Strata itself.
#[tauri::command(async)]
pub fn use_own_strata() -> Result<(), String> {
    write_setting("modelSource", "strata")
}

/// Point the app at a Strata folder (validated) and remember it in settings.json.
#[tauri::command(async)]
pub fn set_strata_root(path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    if !strata_ok(&p) {
        return Err("That folder is not a ready Strata or PolyStrata installation. Choose the folder containing serve\\server.py and .venv\\Scripts\\python.exe. Run its START-HERE.bat first if needed.".into());
    }
    write_setting("strataRoot", &path)?;
    write_setting("modelSource", "strata")?;
    // Strata's setup writes strata-<model>.json next to its start script; pick the newest if none is chosen yet.
    let mut picked = None;
    if !model_config_ok(&strata::setting("modelConfig", &paths::default_model_config())) {
        picked = std::fs::read_dir(&p).ok().and_then(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|f| {
                    let n = f.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    n.starts_with("strata-") && n.ends_with(".json") && n.matches('.').count() == 1
                })
                .filter(|f| model_config_ok(&f.to_string_lossy()))
                .max_by_key(|f| f.metadata().and_then(|m| m.modified()).ok())
        });
        if let Some(f) = &picked {
            write_setting("modelConfig", &f.to_string_lossy())?;
        }
    }
    Ok(json!({"ok": true, "engine": engine(&p), "modelConfig": picked.map(|f| f.to_string_lossy().to_string())}))
}

#[tauri::command(async)]
pub fn set_model_config(path: String) -> Result<Value, String> {
    let config = PathBuf::from(&path);
    let text = std::fs::read_to_string(&config)
        .map_err(|e| format!("Could not read model configuration {}: {e}", config.display()))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Model configuration is not valid JSON: {e}"))?;
    if !value.get("args").and_then(Value::as_array).is_some() {
        return Err("This does not look like a Strata model configuration: it needs an 'args' array.".into());
    }
    write_setting("modelConfig", &path)?;
    write_setting("modelSource", "strata")?;
    Ok(json!({"ok": true}))
}

fn write_setting(key: &str, value: &str) -> Result<(), String> {
    write_setting_value(key, json!(value))
}

/// Merge one key into settings.json, keeping everything else in it.
pub fn write_setting_value(key: &str, value: Value) -> Result<(), String> {
    let f = paths::data_dir().join("settings.json");
    let mut v: Value = match std::fs::read_to_string(&f) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("Could not update settings because {} is invalid JSON: {e}", f.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("Could not read settings {}: {e}", f.display())),
    };
    if !v.is_object() { return Err("Settings must be a JSON object; the existing file was preserved.".into()); }
    v[key] = value;
    let serialized = serde_json::to_vec_pretty(&v).map_err(|e| format!("Could not encode settings: {e}"))?;
    std::fs::write(&f, serialized).map_err(|e| format!("Could not save settings {}: {e}", f.display()))?;
    Ok(())
}

#[tauri::command(async)]
pub fn set_web_access(s: State<App>, on: bool) {
    WEB_OFF.store(!on, Ordering::SeqCst);
    crate::store::kv_set(&s.db.lock().unwrap(), "web_access", if on { "on" } else { "off" });
}

pub fn init(db: &crate::agent::Db) {
    let c = db.lock().unwrap();
    if crate::store::kv_get(&c, "web_access").as_deref() == Some("off") {
        WEB_OFF.store(true, Ordering::SeqCst);
    }
    if crate::store::kv_get(&c, "offline").as_deref() == Some("1") {
        OFFLINE.store(true, Ordering::SeqCst);
    }
}

pub fn offline() -> bool {
    OFFLINE.load(Ordering::SeqCst)
}

pub const OFFLINE_MSG: &str = "Offline mode is on in Settings, so LocalWORK does not use the internet.";

/// Whether this chat must stay off the internet: offline mode is on, or the chat ran offline and the user has
/// not let it go online since.
pub fn chat_is_offline(c: &rusqlite::Connection, conv: &str) -> bool {
    offline() || crate::store::kv_get(c, &format!("offline_chat:{conv}")).as_deref() == Some("1")
}

/// Called when a message is sent: a chat used while offline mode is on remembers that.
pub fn note_chat_sent(c: &rusqlite::Connection, conv: &str) {
    if offline() {
        crate::store::kv_set(c, &format!("offline_chat:{conv}"), "1");
    }
}

/// Tools that reach other machines. Denied for offline chats before the normal policy runs.
pub fn is_network_tool(name: &str) -> bool {
    let t = name.to_lowercase();
    ["browser", "web_search", "web_fetch", "ssh_exec", "ssh_"].iter().any(|k| t.contains(k))
}

#[tauri::command(async)]
pub fn offline_get() -> bool {
    offline()
}

#[tauri::command(async)]
pub fn set_offline(s: State<App>, on: bool) {
    OFFLINE.store(on, Ordering::SeqCst);
    crate::store::kv_set(&s.db.lock().unwrap(), "offline", if on { "1" } else { "0" });
}

/// `chat`: this chat ran offline and is still kept offline. `global`: offline mode is on.
#[tauri::command(async)]
pub fn chat_offline_get(s: State<App>, conv: String) -> Value {
    let c = s.db.lock().unwrap();
    let chat = crate::store::kv_get(&c, &format!("offline_chat:{conv}")).as_deref() == Some("1");
    json!({"chat": chat, "global": offline()})
}

/// Keep a chat offline, or let it use the internet again (only while offline mode itself is off).
#[tauri::command(async)]
pub fn chat_offline_set(s: State<App>, conv: String, on: bool) {
    crate::store::kv_set(&s.db.lock().unwrap(), &format!("offline_chat:{conv}"), if on { "1" } else { "0" });
}

fn git(root: &PathBuf, args: &[&str]) -> Option<String> {
    run("git", args, Some(root))
}

/// Step 1: look only (git fetch), report whether the Strata folder is behind its upstream.
#[tauri::command(async)]
pub fn strata_update_check() -> Result<Value, String> {
    if offline() {
        return Err(OFFLINE_MSG.into());
    }
    let root = strata_root();
    if !strata_ok(&root) {
        return Err("Choose a valid Strata installation in Settings before checking for updates.".into());
    }
    if !root.join(".git").exists() {
        let (name, repo) = (engine(&root), engine_repo(&root));
        return Ok(json!({"git": false, "message": format!("This {name} copy was not made with git, so it cannot fetch updates itself. Download the newest one from {repo} and run UPDATE.bat in it.")}));
    }
    if git(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_none() {
        return Ok(json!({"git": true, "message": "This Strata checkout has no upstream branch configured. Set its Git upstream or update it using the instructions from the Strata project."}));
    }
    if git(&root, &["fetch", "--quiet"]).is_none() {
        return Err("Could not fetch Strata updates. Check Git installation and network access, then try again.".into());
    }
    let head = git(&root, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    let behind: u32 = git(&root, &["rev-list", "--count", "HEAD..@{u}"]).and_then(|x| x.parse().ok()).unwrap_or(0);
    let log = if behind > 0 { git(&root, &["log", "--format=%s", "-n", "8", "HEAD..@{u}"]).unwrap_or_default() } else { String::new() };
    Ok(json!({"git": true, "head": head, "behind": behind, "changes": log.lines().collect::<Vec<_>>()}))
}

/// Step 2 (user confirmed): stop the model, run UPDATE.bat hidden, restart, and check that it still answers.
#[tauri::command]
pub async fn strata_update_apply(app: AppHandle) -> Result<Value, String> {
    let root = strata_root();
    if !strata_ok(&root) || !root.join("UPDATE.bat").is_file() {
        return Err(format!("A valid Strata installation with UPDATE.bat is required. Checked: {}", root.display()));
    }
    let st = app.state::<App>();
    let ags: Vec<_> = st.agents.lock().unwrap().values().cloned().collect();
    for a in ags {
        a.shutdown();
    }
    strata::stop(Some(&app), &st.strata);
    let before = git(&root, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    let log = paths::data_dir().join("logs").join("strata-update.log");
    let r = tokio_free_run(root.clone(), log.clone());
    let after = git(&root, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    let started = strata::start(&app, &st.strata);
    let tail = std::fs::read_to_string(&log).map(|t| t.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")).unwrap_or_default();
    Ok(json!({"ok": r && started.is_ok(), "before": before, "after": after, "restart": started.err(), "log_tail": tail}))
}

/// Runs UPDATE.bat with no console and no stdin (its final `pause` returns at once). Blocking; called from an async command thread.
fn tokio_free_run(root: PathBuf, log: PathBuf) -> bool {
    let f = match std::fs::File::create(&log) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let f2 = match f.try_clone() {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut c = Command::new("cmd");
    c.args(["/c", "UPDATE.bat"]).current_dir(&root).stdin(std::process::Stdio::null()).stdout(f).stderr(f2);
    supervisor::hidden(&mut c);
    c.status().map(|s| s.success()).unwrap_or(false)
}
