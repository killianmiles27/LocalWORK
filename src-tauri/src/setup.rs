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
    PathBuf::from(strata::setting("strataRoot", paths::DEFAULT_STRATA_ROOT))
}

fn strata_ok(root: &PathBuf) -> bool {
    root.join(".venv").join("Scripts").join("python.exe").exists() && root.join("serve").join("server.py").exists()
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
        "model_config_found": PathBuf::from(strata::setting("modelConfig", paths::DEFAULT_MODEL_CONFIG)).exists(),
    })
}

/// Point the app at a Strata folder (validated) and remember it in settings.json.
#[tauri::command]
pub fn set_strata_root(path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    if !strata_ok(&p) {
        return Err("That folder does not look like a set-up Strata (no .venv or serve\\server.py).".into());
    }
    write_setting("strataRoot", &path);
    Ok(json!({"ok": true}))
}

fn write_setting(key: &str, value: &str) {
    let f = paths::data_dir().join("settings.json");
    let mut v: Value = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
    v[key] = json!(value);
    let _ = std::fs::write(f, serde_json::to_string_pretty(&v).unwrap_or_default());
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
    if !root.join(".git").exists() {
        return Ok(json!({"git": false, "message": "This Strata copy was not made with git, so it cannot fetch updates itself. Download the newest one from github.com/Niko1221/Strata and run UPDATE.bat in it."}));
    }
    let _ = git(&root, &["fetch", "--quiet"]);
    let head = git(&root, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    let behind: u32 = git(&root, &["rev-list", "--count", "HEAD..@{u}"]).and_then(|x| x.parse().ok()).unwrap_or(0);
    let log = if behind > 0 { git(&root, &["log", "--format=%s", "-n", "8", "HEAD..@{u}"]).unwrap_or_default() } else { String::new() };
    Ok(json!({"git": true, "head": head, "behind": behind, "changes": log.lines().collect::<Vec<_>>()}))
}

/// Step 2 (user confirmed): stop the model, run UPDATE.bat hidden, restart, and check that it still answers.
#[tauri::command]
pub async fn strata_update_apply(app: AppHandle) -> Result<Value, String> {
    let st = app.state::<App>();
    let ags: Vec<_> = st.agents.lock().unwrap().values().cloned().collect();
    for a in ags {
        a.shutdown();
    }
    strata::stop(Some(&app), &st.strata);
    let root = strata_root();
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
