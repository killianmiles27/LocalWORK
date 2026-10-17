//! First-run wizard support (hardware check, Strata folder detection) and the Strata update check.
use crate::{paths, strata, supervisor, App};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, State};

/// Set from the "web access" choice; policy.rs denies the web tools while this is true.
pub static WEB_OFF: AtomicBool = AtomicBool::new(false);

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

fn model_config_ok(path: &str) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("args").and_then(Value::as_array).map(|_| ()))
        .is_some()
}

#[tauri::command]
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
        "strata_root": root.to_string_lossy(), "strata_found": strata_ok(&root),
        "model_config_found": model_config_ok(&strata::setting("modelConfig", &paths::default_model_config())),
    })
}

/// Point the app at a Strata folder (validated) and remember it in settings.json.
#[tauri::command]
pub fn set_strata_root(path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    if !strata_ok(&p) {
        return Err("That folder is not a ready Strata installation. Choose the folder containing serve\\server.py and .venv\\Scripts\\python.exe. Install Strata and run SETUP.bat first if needed.".into());
    }
    write_setting("strataRoot", &path)?;
    Ok(json!({"ok": true}))
}

#[tauri::command]
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
    Ok(json!({"ok": true}))
}

fn write_setting(key: &str, value: &str) -> Result<(), String> {
    let f = paths::data_dir().join("settings.json");
    let mut v: Value = match std::fs::read_to_string(&f) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("Could not update settings because {} is invalid JSON: {e}", f.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("Could not read settings {}: {e}", f.display())),
    };
    if !v.is_object() { return Err("Settings must be a JSON object; the existing file was preserved.".into()); }
    v[key] = json!(value);
    let serialized = serde_json::to_vec_pretty(&v).map_err(|e| format!("Could not encode settings: {e}"))?;
    std::fs::write(&f, serialized).map_err(|e| format!("Could not save settings {}: {e}", f.display()))?;
    Ok(())
}

#[tauri::command]
pub fn set_web_access(s: State<App>, on: bool) {
    WEB_OFF.store(!on, Ordering::SeqCst);
    crate::store::kv_set(&s.db.lock().unwrap(), "web_access", if on { "on" } else { "off" });
}

pub fn init(db: &crate::agent::Db) {
    if crate::store::kv_get(&db.lock().unwrap(), "web_access").as_deref() == Some("off") {
        WEB_OFF.store(true, Ordering::SeqCst);
    }
}

fn git(root: &PathBuf, args: &[&str]) -> Option<String> {
    run("git", args, Some(root))
}

/// Step 1: look only (git fetch), report whether the Strata folder is behind its upstream.
#[tauri::command]
pub fn strata_update_check() -> Result<Value, String> {
    let root = strata_root();
    if !strata_ok(&root) {
        return Err("Choose a valid Strata installation in Settings before checking for updates.".into());
    }
    if !root.join(".git").exists() {
        return Ok(json!({"git": false, "message": "This Strata copy was not made with git, so it cannot fetch updates itself. Download the newest one from github.com/Niko1221/Strata and run UPDATE.bat in it."}));
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
