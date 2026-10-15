//! Launches and watches the local Strata model server.
//! Contract (MODEL-HANDOFF.md): server.py + selected-model.json, explicit --host/--port, no --open,
//! random per-launch STRATA_API_KEY, public /health, ownership verified with the protected /v1/models.
use crate::{http, paths, supervisor};
use rand::Rng;
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct Status {
    pub state: String, // stopped | starting | ready | error
    pub detail: String,
    pub port: u16,
    pub model: String,
}

pub struct Strata {
    pub child: Option<Child>,
    pub status: Status,
    pub key: String,
    gen: u64,
}

impl Strata {
    pub fn new() -> Self {
        Strata {
            child: None,
            status: Status { state: "stopped".into(), detail: "Model is not running".into(), port: 0, model: String::new() },
            key: String::new(),
            gen: 0,
        }
    }
}

pub type Shared = Arc<Mutex<Strata>>;

fn set(app: &AppHandle, s: &Shared, state: &str, detail: &str) {
    let st = {
        let mut g = s.lock().unwrap();
        g.status.state = state.into();
        g.status.detail = detail.into();
        g.status.clone()
    };
    let _ = app.emit("model-status", st);
}

fn setting(key: &str, default: &str) -> String {
    let p = paths::data_dir().join("settings.json");
    std::fs::read_to_string(p)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get(key).and_then(|x| x.as_str().map(|s| s.to_string())))
        .unwrap_or_else(|| default.to_string())
}

pub fn start(app: &AppHandle, s: &Shared) -> Result<(), String> {
    {
        let g = s.lock().unwrap();
        if g.status.state == "starting" || g.status.state == "ready" {
            return Ok(());
        }
    }
    let root = PathBuf::from(setting("strataRoot", paths::DEFAULT_STRATA_ROOT));
    let cfg = setting("modelConfig", paths::DEFAULT_MODEL_CONFIG);
    let python = root.join(".venv").join("Scripts").join("python.exe");
    let server = root.join("serve").join("server.py");
    if !python.exists() || !server.exists() || !PathBuf::from(&cfg).exists() {
        let m = format!("Strata files not found under {}", root.display());
        set(app, s, "error", &m);
        return Err(m);
    }
    let model_name = std::fs::read_to_string(&cfg)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("model_name").and_then(|x| x.as_str().map(String::from)))
        .unwrap_or_else(|| "strata".into());

    let port = http::free_port();
    let key: String = rand::thread_rng().sample_iter(&rand::distributions::Alphanumeric).take(40).map(char::from).collect();
    let log = std::fs::File::create(paths::data_dir().join("logs").join("strata-server.log")).map_err(|e| e.to_string())?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&python);
    cmd.arg("-u")
        .arg(&server)
        .args(["--engine", "strata", "--config", &cfg, "--host", "127.0.0.1", "--port", &port.to_string()])
        .current_dir(&root)
        .env("STRATA_API_KEY", &key)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log2));
    supervisor::hidden(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("could not start Strata: {e}"))?;
    let pid = child.id();
    supervisor::record(
        &paths::data_dir(),
        supervisor::PidRec { pid, exe: python.to_string_lossy().to_string(), role: "strata".into() },
    );

    let gen = {
        let mut g = s.lock().unwrap();
        g.gen += 1;
        g.child = Some(child);
        g.key = key.clone();
        g.status.port = port;
        g.status.model = model_name;
        g.gen
    };
    set(app, s, "starting", "Loading the model…");

    let (app2, s2) = (app.clone(), s.clone());
    std::thread::spawn(move || monitor(app2, s2, gen, port, key, pid));
    Ok(())
}

fn monitor(app: AppHandle, s: Shared, gen: u64, port: u16, key: String, pid: u32) {
    let t0 = Instant::now();
    let mut fails = 0;
    loop {
        std::thread::sleep(Duration::from_millis(1000));
        let state = {
            let mut g = s.lock().unwrap();
            if g.gen != gen {
                return;
            }
            let mut exited = None;
            if let Some(c) = g.child.as_mut() {
                if let Ok(Some(code)) = c.try_wait() {
                    exited = Some(code);
                }
            }
            if let Some(code) = exited {
                g.child = None;
                drop(g);
                supervisor::forget(&paths::data_dir(), pid);
                set(&app, &s, "error", &format!("Model server exited ({code}). See logs\\strata-server.log"));
                return;
            }
            g.status.state.clone()
        };
        let healthy = matches!(http::get(port, "/health", None, Duration::from_secs(2)), Some((200, _)));
        if state == "starting" {
            if healthy {
                // Ownership check: /health is public, /v1/models needs our random key.
                if let Some((200, _)) = http::get(port, "/v1/models", Some(&key), Duration::from_secs(3)) {
                    set(&app, &s, "ready", "Model ready");
                }
            } else if t0.elapsed() > Duration::from_secs(300) {
                set(&app, &s, "error", "Model did not become ready within 5 minutes");
                return;
            } else {
                set(&app, &s, "starting", &format!("Loading the model… {}s", t0.elapsed().as_secs()));
            }
        } else if state == "ready" {
            if healthy {
                fails = 0;
            } else {
                fails += 1;
                if fails >= 4 {
                    set(&app, &s, "error", "Model server stopped responding");
                    return;
                }
            }
        } else {
            return;
        }
    }
}

pub fn stop(app: Option<&AppHandle>, s: &Shared) {
    let child = {
        let mut g = s.lock().unwrap();
        g.gen += 1;
        g.child.take()
    };
    if let Some(mut c) = child {
        let pid = c.id();
        supervisor::kill_tree(pid);
        let _ = c.wait();
        supervisor::forget(&paths::data_dir(), pid);
    }
    let st = {
        let mut g = s.lock().unwrap();
        g.status.state = "stopped".into();
        g.status.detail = "Model is not running".into();
        g.status.clone()
    };
    if let Some(a) = app {
        let _ = a.emit("model-status", st);
    }
}
