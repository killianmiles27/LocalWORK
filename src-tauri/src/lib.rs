mod agent;
mod http;
mod paths;
mod policy;
mod store;
mod strata;
mod supervisor;
mod voice;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Manager, RunEvent, State};

pub struct App {
    pub db: agent::Db,
    pub strata: strata::Shared,
    pub agents: agent::Agents,
}

fn new_id() -> String {
    use rand::Rng;
    let n: u64 = rand::thread_rng().gen();
    format!("c{:x}{:x}", store::now(), n & 0xffff_ffff)
}

#[tauri::command]
fn model_status(s: State<App>) -> strata::Status {
    s.strata.lock().unwrap().status.clone()
}

#[tauri::command]
fn model_info(s: State<App>) -> Value {
    strata::info(&s.strata)
}

#[tauri::command]
fn set_auto_edit(s: State<App>, id: String, on: bool) {
    if let Some(a) = s.agents.lock().unwrap().get(&id) {
        a.set_auto_edit(on);
    }
}

#[tauri::command]
fn model_start(app: AppHandle, s: State<App>) -> Result<(), String> {
    strata::start(&app, &s.strata)
}

#[tauri::command]
fn model_stop(app: AppHandle, s: State<App>) {
    let ags: Vec<_> = s.agents.lock().unwrap().values().cloned().collect();
    for a in ags {
        a.shutdown();
    }
    strata::stop(Some(&app), &s.strata);
}

#[tauri::command]
fn list_conversations(s: State<App>) -> Vec<Value> {
    store::list_convs(&s.db.lock().unwrap())
}

#[tauri::command]
fn create_conversation(s: State<App>, workspace: String) -> Result<String, String> {
    if !std::path::Path::new(&workspace).is_dir() {
        return Err("Workspace folder does not exist".into());
    }
    let id = new_id();
    store::create_conv(&s.db.lock().unwrap(), &id, &workspace).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
fn delete_conversation(s: State<App>, id: String) {
    if let Some(a) = s.agents.lock().unwrap().remove(&id) {
        a.shutdown();
    }
    store::delete_conv(&s.db.lock().unwrap(), &id);
}

#[tauri::command]
fn load_messages(s: State<App>, id: String) -> Vec<Value> {
    store::messages(&s.db.lock().unwrap(), &id)
}

#[tauri::command]
fn agent_send(app: AppHandle, s: State<App>, id: String, text: String, auto_edit: bool) -> Result<(), String> {
    let a = agent::get_or_start(&app, &s.agents, &s.db, &s.strata, &id)?;
    a.set_auto_edit(auto_edit);
    {
        let c = s.db.lock().unwrap();
        store::add_msg(&c, &id, "user", &json!({"text": text}));
        if let Some((title, _, _)) = store::conv_info(&c, &id) {
            if title == "New conversation" {
                let t: String = text.chars().take(48).collect();
                store::rename(&c, &id, t.trim());
            }
        }
    }
    a.send(json!({"type": "message", "msg_id": new_id(), "content": text}));
    Ok(())
}

#[tauri::command]
fn agent_stop(s: State<App>, id: String) {
    if let Some(a) = s.agents.lock().unwrap().get(&id) {
        a.stop_turn();
    }
}

#[tauri::command]
fn agent_answer(s: State<App>, id: String, call_id: String, allow: bool, remember: bool) {
    if let Some(a) = s.agents.lock().unwrap().get(&id) {
        a.answer(&call_id, allow, remember);
    }
}

#[tauri::command]
fn get_setting(s: State<App>, key: String) -> Option<String> {
    store::kv_get(&s.db.lock().unwrap(), &key)
}

#[tauri::command]
fn set_setting(s: State<App>, key: String, value: String) {
    store::kv_set(&s.db.lock().unwrap(), &key, &value);
}

#[tauri::command]
fn memories_list(s: State<App>) -> Vec<Value> {
    let c = s.db.lock().unwrap();
    store::recent_memories(&c, 500).into_iter().map(|(id, text)| json!({"id": id, "text": text})).collect()
}

#[tauri::command]
fn memory_delete(s: State<App>, id: i64) {
    store::delete_memory(&s.db.lock().unwrap(), id);
}

#[tauri::command]
fn data_dir() -> String {
    paths::data_dir().to_string_lossy().to_string()
}

/// Ask the Playwright CLI to close every browser it started (its daemons are detached from the agent's process tree).
fn close_browsers() {
    let v = paths::vendor_dir();
    let cli = v.join("playwright").join("node_modules").join("@playwright").join("cli").join("playwright-cli.js");
    let node = v.join("node").join("node.exe");
    if !cli.exists() || !node.exists() {
        return;
    }
    for sub in ["close-all", "kill-all"] {
        let mut c = std::process::Command::new(&node);
        c.arg(&cli).arg(sub).env("PLAYWRIGHT_BROWSERS_PATH", v.join("browsers"));
        supervisor::hidden(&mut c);
        let _ = c.output();
    }
}

fn shutdown(state: &App) {
    let t0 = Instant::now();
    let ags: Vec<_> = state.agents.lock().unwrap().drain().map(|(_, a)| a).collect();
    for a in &ags {
        a.shutdown();
    }
    close_browsers();
    strata::stop(None, &state.strata);
    let _ = std::fs::write(paths::data_dir().join("pids.json"), "[]");
    eprintln!("shutdown complete in {:?}", t0.elapsed());
}

pub fn run() {
    let dir = paths::data_dir();
    // A second launch just focuses the first window (the plugin exits the second process).
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init());

    // Single-instance has decided we are the primary: now it is safe to reap leftovers and join the job.
    let killed = supervisor::cleanup_stale(&dir);
    if killed > 0 {
        eprintln!("cleaned up {killed} stale process tree(s)");
    }
    if let Err(e) = supervisor::init_job() {
        eprintln!("job object unavailable: {e}");
    }
    let db = store::open(&dir).expect("open database");
    let state = App {
        db: Arc::new(Mutex::new(db)),
        strata: Arc::new(Mutex::new(strata::Strata::new())),
        agents: Arc::new(Mutex::new(HashMap::new())),
    };

    builder
        .manage(state)
        .setup(|app| {
            // Start the model as soon as the app opens; the status pill follows it.
            let handle = app.handle().clone();
            let st = app.state::<App>().strata.clone();
            let _ = strata::start(&handle, &st);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            model_status,
            model_start,
            model_stop,
            list_conversations,
            create_conversation,
            delete_conversation,
            load_messages,
            model_info,
            set_auto_edit,
            agent_send,
            agent_stop,
            agent_answer,
            get_setting,
            set_setting,
            data_dir,
            memories_list,
            memory_delete,
            voice::voice_status,
            voice::voice_transcribe,
            voice::voice_tidy
        ])
        .build(tauri::generate_context!())
        .expect("error while building app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                shutdown(&app.state::<App>());
            }
        });
}
