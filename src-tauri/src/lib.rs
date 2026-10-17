mod agent;
mod documents;
mod desktop;
mod http;
mod paths;
mod policy;
mod rollback;
mod setup;
mod ssh;
mod sshpolicy;
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
async fn model_telemetry(s: State<'_, App>) -> Result<Option<f64>, String> {
    let strata = s.strata.clone();
    tauri::async_runtime::spawn_blocking(move || strata::telemetry(&strata))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_auto_edit(s: State<App>, id: Option<String>, on: bool) {
    store::kv_set(&s.db.lock().unwrap(), "auto_edit", if on { "1" } else { "0" });
    let _ = id;
    let agents = s.agents.lock().unwrap();
    for a in agents.values() {
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
fn open_workspace(s: State<App>, id: String) -> Result<(), String> {
    let workspace = store::conv_info(&s.db.lock().unwrap(), &id)
        .map(|(_, workspace, _)| workspace)
        .ok_or_else(|| "Unknown chat".to_string())?;
    desktop::reveal_folder(&workspace)
}

#[tauri::command]
fn create_conversation(app: AppHandle, s: State<App>, workspace: Option<String>) -> Result<String, String> {
    let id = new_id();
    let workspace = match workspace {
        Some(path) => desktop::existing_workspace(&path)?,
        None => default_workspace(&app, &s, &id)?,
    };
    store::create_conv(&s.db.lock().unwrap(), &id, &workspace).map_err(|e| e.to_string())?;
    Ok(id)
}

fn default_workspace(app: &AppHandle, s: &State<App>, id: &str) -> Result<String, String> {
    let parent = store::kv_get(&s.db.lock().unwrap(), "projects_folder")
        .filter(|path| !path.trim().is_empty())
        .map(std::path::PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| app.path().document_dir().map(|p| p.join("LocalWORK")).map_err(|e| e.to_string()))?;
    let folder = parent.join(id);
    std::fs::create_dir_all(&folder).map_err(|e| format!("Could not create chat folder: {e}"))?;
    Ok(folder.to_string_lossy().into_owned())
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
fn agent_send(app: AppHandle, s: State<App>, id: String, text: String) -> Result<(), String> {
    let a = agent::get_or_start(&app, &s.agents, &s.db, &s.strata, &id)?;
    let enabled = store::kv_get(&s.db.lock().unwrap(), "auto_edit").map(|v| v != "0").unwrap_or(true);
    a.set_auto_edit(enabled);
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

fn attach_dir(s: &State<App>, id: &str) -> Result<std::path::PathBuf, String> {
    let ws = store::conv_info(&s.db.lock().unwrap(), id).map(|x| x.1).ok_or("Unknown chat")?;
    let d = std::path::Path::new(&ws).join("attachments");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn unique_in(d: &std::path::Path, name: &str) -> std::path::PathBuf {
    let clean: String = name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c }).collect();
    let (stem, ext) = match clean.rsplit_once('.') {
        Some((a, b)) if !a.is_empty() => (a.to_string(), format!(".{b}")),
        _ => (clean.clone(), String::new()),
    };
    let mut p = d.join(&clean);
    let mut n = 2;
    while p.exists() {
        p = d.join(format!("{stem}-{n}{ext}"));
        n += 1;
    }
    p
}

/// Copies dropped files into <workspace>ttachments and returns their workspace-relative paths.
#[tauri::command]
fn attach_paths(s: State<App>, id: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    let d = attach_dir(&s, &id)?;
    let mut out = vec![];
    for src in paths {
        let sp = std::path::Path::new(&src);
        if !sp.is_file() {
            continue;
        }
        let name = sp.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        let dst = unique_in(&d, &name);
        std::fs::copy(sp, &dst).map_err(|e| format!("{name}: {e}"))?;
        out.push(format!("attachments/{}", dst.file_name().unwrap().to_string_lossy()));
    }
    Ok(out)
}

/// Saves pasted file or image bytes into <workspace>ttachments.
#[tauri::command]
fn attach_bytes(s: State<App>, id: String, name: String, data: Vec<u8>) -> Result<String, String> {
    let d = attach_dir(&s, &id)?;
    let dst = unique_in(&d, &name);
    std::fs::write(&dst, data).map_err(|e| e.to_string())?;
    Ok(format!("attachments/{}", dst.file_name().unwrap().to_string_lossy()))
}

#[tauri::command]
fn agent_compact(app: AppHandle, s: State<App>, id: String) -> Result<(), String> {
    let a = agent::get_or_start(&app, &s.agents, &s.db, &s.strata, &id)?;
    a.send(json!({"type": "message", "msg_id": new_id(), "content": "/compact"}));
    Ok(())
}

#[tauri::command]
fn context_usage(s: State<App>, id: String) -> Value {
    let used = store::kv_get(&s.db.lock().unwrap(), &format!("ctx:{id}")).and_then(|v| v.parse::<u64>().ok());
    json!({"used": used, "window": strata::context_window()})
}

#[tauri::command]
fn agent_stop(s: State<App>, id: String) {
    let agent = s.agents.lock().unwrap().remove(&id);
    if let Some(a) = agent {
        a.stop_turn();
        // Upstream can stall while shutting down an MCP session after Stop.
        // Give it a bounded graceful exit, then stop only this agent's tree.
        a.shutdown();
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
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("external-navigation")
            .on_navigation(|_, url| {
                if desktop::is_app_navigation(url) {
                    true
                } else if matches!(url.scheme(), "http" | "https") {
                    if let Err(error) = desktop::open_external_url(url.as_str()) {
                        eprintln!("could not open external link: {error}");
                    }
                    false
                } else {
                    true
                }
            })
            .build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(move |app| {
            // Plugin setup runs during build, not when .plugin() is called.
            // Only the primary may reap processes or open shared app state.
            let killed = supervisor::cleanup_stale(&dir);
            if killed > 0 { eprintln!("cleaned up {killed} stale process tree(s)"); }
            if let Err(e) = supervisor::init_job() { eprintln!("job object unavailable: {e}"); }
            rollback::on_start(&dir);
            let state = App {
                db: Arc::new(Mutex::new(store::open(&dir)?)),
                strata: Arc::new(Mutex::new(strata::Strata::new())),
                agents: Arc::new(Mutex::new(HashMap::new())),
            };
            setup::init(&state.db);
            app.manage(state);
            // Start the model as soon as the app opens; the status pill follows it.
            let handle = app.handle().clone();
            let st = app.state::<App>().strata.clone();
            let _ = strata::start(&handle, &st);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            documents::documents_list, documents::document_preview, documents::document_open,
            documents::document_revisions, documents::document_export,
            documents::document_save_visual,
            setup::hardware_check, setup::set_strata_root, setup::set_web_access, setup::strata_update_check, setup::strata_update_apply,
            rollback::rollback_list,
            rollback::rollback_to,
            model_status,
            model_start,
            model_stop,
            list_conversations,
            open_workspace,
            create_conversation,
            delete_conversation,
            load_messages,
            model_info,
            model_telemetry,
            desktop::open_external,
            set_auto_edit,
            agent_send,
            agent_stop,
            agent_compact,
            context_usage,
            ssh::ssh_hosts, ssh::ssh_save_host, ssh::ssh_delete_host, ssh::ssh_public_key, ssh::ssh_scan, ssh::ssh_pin,
            attach_paths,
            attach_bytes,
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
