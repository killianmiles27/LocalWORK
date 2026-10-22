//! Launches and watches the local Strata model server.
//! Contract (MODEL-HANDOFF.md): server.py + selected-model.json, explicit --host/--port, no --open,
//! random per-launch STRATA_API_KEY, public /health, ownership verified with the protected /v1/models.
use crate::{http, paths, supervisor};
use rand::Rng;
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
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

/// Context size the running server reports on /health (`max_context`). Strata and PolyStrata both
/// report it, and PolyStrata may size it per model, so compaction trusts it over the config file.
static LIVE_CTX: AtomicU64 = AtomicU64::new(0);

/// Remember `max_context` from a Strata/PolyStrata /health body. Other servers leave it unset.
fn note_health(body: &str) {
    if let Some(n) = parse_max_context(body) {
        LIVE_CTX.store(n, Ordering::Relaxed);
    }
}

fn parse_max_context(body: &str) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(body).ok()?.get("max_context")?.as_u64().filter(|n| *n >= 4096)
}

fn set(app: &AppHandle, s: &Shared, state: &str, detail: &str) {
    let st = {
        let mut g = s.lock().unwrap();
        g.status.state = state.into();
        g.status.detail = detail.into();
        g.status.clone()
    };
    let _ = app.emit("model-status", st);
}

pub fn setting(key: &str, default: &str) -> String {
    let p = paths::data_dir().join("settings.json");
    std::fs::read_to_string(p)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get(key).and_then(|x| x.as_str().map(|s| s.to_string())))
        .unwrap_or_else(|| default.to_string())
}

/// True when the user connected an OpenAI-compatible server they run themselves (Strata, LM Studio, Ollama...)
/// instead of letting the app launch Strata. The app then never starts or stops that server.
pub fn external() -> bool {
    setting("modelSource", "strata") == "server"
}

/// The first model id an OpenAI-compatible server lists, if it answers /v1/models.
pub fn probe(port: u16, key: Option<&str>) -> Result<String, String> {
    match http::get(port, "/v1/models", key, Duration::from_secs(3)) {
        Some((200, body)) => Ok(serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["data"][0]["id"].as_str().map(String::from))
            .unwrap_or_else(|| "local-model".into())),
        Some((401 | 403, _)) => Err(format!("The server on port {port} needs an API key.")),
        Some((code, _)) => Err(format!("The server on port {port} answered /v1/models with HTTP {code}.")),
        None => Err(format!("Nothing answered on port {port}. Start your model server first.")),
    }
}

fn connect_external(app: &AppHandle, s: &Shared) -> Result<(), String> {
    let port: u16 = setting("serverPort", "8080").parse().map_err(|_| "The saved server port is not a number.".to_string())?;
    let key = setting("serverKey", "");
    let bearer = if key.is_empty() { "local".to_string() } else { key };
    let gen = {
        let mut g = s.lock().unwrap();
        g.gen += 1;
        g.key = bearer.clone();
        g.status.port = port;
        g.gen
    };
    LIVE_CTX.store(0, Ordering::Relaxed);
    set(app, s, "starting", "Connecting to your model server…");
    let (app2, s2) = (app.clone(), s.clone());
    std::thread::spawn(move || monitor(app2, s2, gen, port, bearer, 0));
    Ok(())
}

/// The folder whose serve\server.py runs a config: its `engine_root`, else its `cwd` when that holds a server
/// (a PolyStrata config keeps its own), else the Strata folder. Python comes from that folder's .venv, else Strata's.
pub fn server_root(cfg: &str, strata_root: &PathBuf) -> PathBuf {
    let v: Option<serde_json::Value> = std::fs::read_to_string(cfg).ok().and_then(|t| serde_json::from_str(&t).ok());
    ["engine_root", "cwd"]
        .iter()
        .filter_map(|k| v.as_ref()?.get(*k)?.as_str().map(PathBuf::from))
        .find(|d| d.join("serve").join("server.py").is_file())
        .unwrap_or_else(|| strata_root.clone())
}

pub fn start(app: &AppHandle, s: &Shared) -> Result<(), String> {
    {
        let g = s.lock().unwrap();
        if g.status.state == "starting" || g.status.state == "ready" {
            return Ok(());
        }
    }
    if external() {
        return connect_external(app, s);
    }
    let root = PathBuf::from(setting("strataRoot", &paths::default_strata_root()));
    let cfg = setting("modelConfig", &paths::default_model_config());
    let engine_root = server_root(&cfg, &root);
    let venv = |d: &PathBuf| d.join(".venv").join("Scripts").join("python.exe");
    let python = if venv(&engine_root).is_file() { venv(&engine_root) } else { venv(&root) };
    let server = engine_root.join("serve").join("server.py");
    if !python.exists() || !server.exists() || !PathBuf::from(&cfg).exists() {
        let m = if !python.is_file() || !server.is_file() {
            format!("Strata is not configured. In Settings, choose its folder (the one containing serve\\server.py and .venv\\Scripts\\python.exe). Install Strata and run SETUP.bat first if needed. Checked: {}", root.display())
        } else {
            format!("No model configuration was found at {}. In Settings, choose a Strata model JSON file.", cfg)
        };
        set(app, s, "error", &m);
        return Err(m);
    }
    let config_text = std::fs::read_to_string(&cfg).map_err(|e| format!("Could not read Strata model configuration {cfg}: {e}"))?;
    let config: serde_json::Value = serde_json::from_str(&config_text).map_err(|e| format!("Invalid Strata model configuration {cfg}: {e}"))?;
    if !config.get("args").and_then(serde_json::Value::as_array).is_some() {
        let m = format!("Invalid Strata model configuration {cfg}: expected an 'args' array. Choose a config created for Strata.");
        set(app, s, "error", &m);
        return Err(m);
    }
    let model_name = config.get("model_name").and_then(|x| x.as_str()).unwrap_or("strata").to_string();

    LIVE_CTX.store(0, Ordering::Relaxed);
    let port = http::free_port();
    let key: String = rand::thread_rng().sample_iter(&rand::distributions::Alphanumeric).take(40).map(char::from).collect();
    let log = std::fs::File::create(paths::data_dir().join("logs").join("strata-server.log")).map_err(|e| e.to_string())?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&python);
    cmd.arg("-u")
        .arg(&server)
        // aionrs compaction has a separate 20k output cap, independent of --max-tokens.
        // Fit that cap to remaining space; Strata still rejects an oversized input.
        .args(["--engine", "strata", "--config", &cfg, "--host", "127.0.0.1", "--port", &port.to_string(), "--fit-max-tokens"])
        .current_dir(&engine_root)
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
        if pid == 0 {
            // A server the user runs: it has no common /health (Ollama), so /v1/models is the check.
            let found = probe(port, Some(&key));
            if let Some((200, body)) = http::get(port, "/health", None, Duration::from_secs(2)) {
                note_health(&body);
            }
            if state == "starting" {
                match found {
                    Ok(model) => {
                        s.lock().unwrap().status.model = model;
                        set(&app, &s, "ready", "Connected to your model server");
                    }
                    Err(e) if t0.elapsed() > Duration::from_secs(60) => {
                        set(&app, &s, "error", &e);
                        return;
                    }
                    Err(_) => set(&app, &s, "starting", &format!("Waiting for your model server on port {port}… {}s", t0.elapsed().as_secs())),
                }
            } else if state == "ready" {
                fails = if found.is_ok() { 0 } else { fails + 1 };
                if fails >= 4 {
                    set(&app, &s, "error", "Your model server stopped responding");
                    return;
                }
            } else {
                return;
            }
            continue;
        }
        let health = http::get(port, "/health", None, Duration::from_secs(2));
        let healthy = matches!(health, Some((200, _)));
        if let Some((200, body)) = &health {
            note_health(body);
        }
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
    LIVE_CTX.store(0, Ordering::Relaxed);
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

/// Model + machine details for the Settings panel. The API key stays on this side; only data goes out.
/// Context window: what the running Strata/PolyStrata server reports, else the config's `--max-context`
/// (or `--ctx`), else 32768.
pub fn context_window() -> u64 {
    let live = LIVE_CTX.load(Ordering::Relaxed);
    if live >= 4096 {
        return live;
    }
    if external() {
        return setting("serverContext", "32768").parse::<u64>().ok().filter(|n| *n >= 4096).unwrap_or(32768);
    }
    let cfg = setting("modelConfig", &paths::default_model_config());
    std::fs::read_to_string(&cfg).ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("args").and_then(|a| a.as_array()).cloned())
        .and_then(|a| {
            let i = a.iter().position(|x| matches!(x.as_str(), Some("--max-context" | "--ctx")))?;
            a.get(i + 1)?.as_str()?.parse::<u64>().ok()
        })
        .filter(|n| *n >= 4096)
        .unwrap_or(32768)
}

pub fn info(s: &Shared) -> serde_json::Value {
    use serde_json::{json, Value};
    let (port, key, model) = {
        let g = s.lock().unwrap();
        (g.status.port, g.key.clone(), g.status.model.clone())
    };
    let cfg = setting("modelConfig", &paths::default_model_config());
    let cfgv: Value = std::fs::read_to_string(&cfg).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let args: Vec<String> = cfgv
        .get("args")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let file = flag("--native").or_else(|| flag("--model")).unwrap_or_default();
    let stem = file.rsplit(['\\', '/']).next().unwrap_or("").to_string();
    let quant = regex::Regex::new(r"(?i)\b(i?q\d(?:_[a-z0-9]+)*|f16|bf16|fp8|int\d)\b")
        .ok()
        .and_then(|re| re.find(&format!("{} {}", stem.replace('-', " "), model.replace('-', " "))).map(|m| m.as_str().to_uppercase()))
        .unwrap_or_default();
    let (cpu_name, cpu_load, proc_gib) = cpu_stats(s);
    let get = |p: &str| -> Value {
        if port == 0 { return Value::Null; }
        http::get(port, p, Some(&key), Duration::from_millis(900))
            .filter(|(c, _)| *c == 200)
            .and_then(|(_, b)| serde_json::from_str::<Value>(&b).ok())
            .unwrap_or(Value::Null)
    };
    json!({
        "model": model, "quant": quant, "file": stem,
        "context": flag("--max-context"), "kv": flag("--kv"),
        "cpu": {"name": cpu_name, "load": cpu_load, "server_ram_gib": proc_gib},
        "status": get("/v1/status"), "live": get("/status"),
    })
}

/// Lightweight composer telemetry. Reads only the model HTTP endpoints and avoids sysinfo's
/// process-tree refresh used by `info`, which is intentionally reserved for Settings.
/// Generation speed, plus the size of the request being served right now (prompt + tokens so far), which is
/// the chat's live context size while a turn runs.
pub fn telemetry(s: &Shared) -> (Option<f64>, Option<u64>) {
    let (port, key, ready) = {
        let g = s.lock().unwrap();
        (g.status.port, g.key.clone(), g.status.state == "ready")
    };
    if !ready || port == 0 {
        return (None, None);
    }
    let current = http::get(port, "/status", Some(&key), Duration::from_millis(750))
        .filter(|(status, _)| *status == 200)
        .and_then(|(_, body)| serde_json::from_str::<serde_json::Value>(&body).ok());
    let live = current.as_ref().and_then(|v| {
        let prompt = v.get("prompt_tokens")?.as_u64()?;
        Some(prompt + v.get("generated").and_then(serde_json::Value::as_u64).unwrap_or(0))
    });
    if let Some(value) = current.as_ref().and_then(current_tokens_per_second) {
        return (Some(value), live);
    }
    let detailed = http::get(port, "/v1/status", Some(&key), Duration::from_millis(750))
        .filter(|(status, _)| *status == 200)
        .and_then(|(_, body)| serde_json::from_str::<serde_json::Value>(&body).ok());
    let tps = current
        .as_ref()
        .and_then(last_tokens_per_second)
        .or_else(|| detailed.as_ref().and_then(last_tokens_per_second));
    (tps, live)
}

fn current_tokens_per_second(value: &serde_json::Value) -> Option<f64> {
    ["tokens_per_s", "tokens_per_s_current", "tokens_per_s_mean"]
        .iter()
        .find_map(|key| finite_positive(value.get(key).and_then(serde_json::Value::as_f64)))
}

fn last_tokens_per_second(value: &serde_json::Value) -> Option<f64> {
    finite_positive(value.get("last_timings")?.get("predicted_per_second")?.as_f64())
}

fn finite_positive(value: Option<f64>) -> Option<f64> {
    value.filter(|n| n.is_finite() && *n >= 0.0)
}

fn cpu_stats(s: &Shared) -> (String, f32, Option<f64>) {
    use std::sync::OnceLock;
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    static SYS: OnceLock<Mutex<System>> = OnceLock::new();
    let pid = s.lock().unwrap().child.as_ref().map(|c| c.id());
    let mut sys = SYS.get_or_init(|| Mutex::new(System::new())).lock().unwrap();
    sys.refresh_cpu_usage();
    if pid.is_some() {
        // Memory only: a full refresh (command lines, disk, CPU per process) is what made Settings slow.
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_memory());
    }
    let name = sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
    // The model runs in child processes of the launcher: add up the whole tree.
    let gib = pid.map(|root| {
        let mut tree = vec![Pid::from_u32(root)];
        let mut i = 0;
        while i < tree.len() {
            let cur = tree[i];
            for (p, pr) in sys.processes() {
                if pr.parent() == Some(cur) && !tree.contains(p) {
                    tree.push(*p);
                }
            }
            i += 1;
        }
        tree.iter().filter_map(|p| sys.process(*p)).map(|p| p.memory()).sum::<u64>() as f64 / 1073741824.0
    });
    (name, sys.global_cpu_usage(), gib)
}

#[cfg(test)]
mod telemetry_tests {
    use super::{current_tokens_per_second, finite_positive, last_tokens_per_second};
    use serde_json::json;

    #[test]
    fn reads_max_context_from_health() {
        assert_eq!(super::parse_max_context(r#"{"status":"ok","max_context":131072,"service":"strata"}"#), Some(131072));
        assert_eq!(super::parse_max_context(r#"{"status":"ok"}"#), None);
        assert_eq!(super::parse_max_context(r#"{"max_context":512}"#), None);
        assert_eq!(super::parse_max_context("not json"), None);
    }

    #[test]
    fn telemetry_reads_live_and_last_rates_and_rejects_non_finite_values() {
        assert_eq!(current_tokens_per_second(&json!({"tokens_per_s": 31.25})), Some(31.25));
        assert_eq!(current_tokens_per_second(&json!({"tokens_per_s": null, "tokens_per_s_mean": 18})), Some(18.0));
        assert_eq!(last_tokens_per_second(&json!({"last_timings":{"predicted_per_second":12}})), Some(12.0));
        assert_eq!(current_tokens_per_second(&json!({"tokens_per_s":-1})), None);
        assert_eq!(finite_positive(Some(f64::INFINITY)), None);
    }
}
