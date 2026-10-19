mod agent;
mod documents;
mod export;
mod desktop;
mod http;
mod paths;
mod plugins;
mod pluginstore;
mod policy;
mod rewind;
mod rollback;
mod runconfig;
mod setup;
mod ssh;
mod stats;
mod sshpolicy;
mod store;
mod strata;
mod supervisor;
mod updates;
mod voice;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use std::sync::atomic::{AtomicBool, Ordering};

/// Set once the user chose "Quit anyway" while a task was running.
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

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

#[tauri::command(async)]
fn plugins_list() -> Vec<Value> {
    plugins::list_json()
}

#[tauri::command(async)]
fn plugin_set_enabled(id: String, on: bool) -> Result<(), String> {
    plugins::set_enabled(&id, on)
}

#[tauri::command(async)]
fn status_items() -> Vec<Value> {
    plugins::status_items()
}

#[tauri::command(async)]
fn system_stats() -> Value {
    stats::get()
}

#[tauri::command(async)]
fn power_stats(settings: Option<Value>) -> Value {
    stats::power(&settings.unwrap_or(Value::Null))
}

#[tauri::command(async)]
fn plugin_import(path: String) -> Result<Value, String> {
    plugins::import(&path)
}

#[tauri::command(async)]
fn plugin_export(id: String, dest: String) -> Result<(), String> {
    plugins::export(&id, &dest)
}

#[tauri::command(async)]
fn plugin_remove(id: String) -> Result<(), String> {
    plugins::remove(&id)
}

#[tauri::command(async)]
fn plugin_settings_set(id: String, values: Value) -> Result<Value, String> {
    plugins::set_settings(&id, &values)
}

#[tauri::command(async)]
fn store_sources() -> Vec<String> {
    pluginstore::sources()
}

#[tauri::command(async)]
fn store_sources_set(list: Vec<String>) -> Result<Vec<String>, String> {
    pluginstore::set_sources(list)
}

#[tauri::command(async)]
fn store_list(source: String) -> Result<Value, String> {
    pluginstore::list(&source)
}

#[tauri::command(async)]
fn store_install(source: String, dir: String) -> Result<Value, String> {
    pluginstore::install(&source, &dir)
}

#[tauri::command(async)]
fn plugins_folder() -> Result<(), String> {
    desktop::reveal_folder(&plugins::user_folder().to_string_lossy())
}

#[tauri::command(async)]
fn modes_list(s: State<App>) -> Value {
    serde_json::json!({"modes": plugins::modes(), "effort": plugins::effort_get(&s.strata)})
}

#[tauri::command(async)]
fn effort_set(s: State<App>, effort: Option<String>) -> Result<Value, String> {
    plugins::effort_set(&s.strata, effort)
}

/// Switch to another model mode: point at its run config and reload the model. Chats keep their
/// sessions; each agent restarts on its next message with the new context window.
#[tauri::command(async)]
fn mode_switch(app: AppHandle, s: State<App>, id: String, reload: Option<bool>) -> Result<Value, String> {
    let m = plugins::find_mode(&id).ok_or_else(|| format!("no mode {id}"))?;
    if m["active"] == true && reload != Some(true) && s.strata.lock().unwrap().status.state == "ready" {
        return Ok(m);
    }
    let cfg = m["config"].as_str().unwrap_or("").to_string();
    setup::set_model_config(cfg)?;
    let ags: Vec<_> = s.agents.lock().unwrap().drain().map(|(_, a)| a).collect();
    for a in ags {
        a.shutdown();
    }
    strata::stop(Some(&app), &s.strata);
    strata::start(&app, &s.strata)?;
    Ok(plugins::find_mode(&id).unwrap_or(m))
}

#[tauri::command(async)]
fn run_config_read(path: String) -> Result<Value, String> {
    runconfig::read(&path)
}

#[tauri::command(async)]
fn run_config_save(path: String, config: Value, new_name: Option<String>) -> Result<String, String> {
    runconfig::save(&path, config, new_name)
}

#[tauri::command(async)]
fn model_status(s: State<App>) -> strata::Status {
    s.strata.lock().unwrap().status.clone()
}

#[tauri::command(async)]
fn model_info(s: State<App>) -> Value {
    strata::info(&s.strata)
}

#[tauri::command]
async fn model_telemetry(s: State<'_, App>) -> Result<Value, String> {
    let strata = s.strata.clone();
    let (tps, ctx) = tauri::async_runtime::spawn_blocking(move || strata::telemetry(&strata))
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({"tps": tps, "ctx": ctx}))
}

#[tauri::command(async)]
fn set_auto_edit(s: State<App>, id: Option<String>, on: bool) {
    store::kv_set(&s.db.lock().unwrap(), "auto_edit", if on { "1" } else { "0" });
    let _ = id;
    let agents = s.agents.lock().unwrap();
    for a in agents.values() {
        a.set_auto_edit(on);
    }
}

#[tauri::command(async)]
fn model_start(app: AppHandle, s: State<App>) -> Result<(), String> {
    strata::start(&app, &s.strata)
}

#[tauri::command(async)]
fn model_stop(app: AppHandle, s: State<App>) {
    let ags: Vec<_> = s.agents.lock().unwrap().values().cloned().collect();
    for a in ags {
        a.shutdown();
    }
    strata::stop(Some(&app), &s.strata);
}

#[tauri::command(async)]
fn list_conversations(s: State<App>) -> Vec<Value> {
    store::list_convs(&s.db.lock().unwrap())
}

#[tauri::command(async)]
fn open_workspace(s: State<App>, id: String) -> Result<(), String> {
    let workspace = store::conv_info(&s.db.lock().unwrap(), &id)
        .map(|(_, workspace, _)| workspace)
        .ok_or_else(|| "Unknown chat".to_string())?;
    desktop::reveal_folder(&workspace)
}

#[tauri::command(async)]
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

/// Saves a chat as Markdown. The save dialog runs here, so the UI never gets a general file-write command.
#[tauri::command(async)]
fn export_markdown(app: AppHandle, s: State<App>, id: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (title, msgs) = {
        let c = s.db.lock().unwrap();
        (store::conv_info(&c, &id).map(|x| x.0).ok_or("Unknown chat")?, store::messages(&c, &id, 0))
    };
    let name: String = title.chars().filter(|c| !"<>:\"/\\|?*".contains(*c) && !c.is_control()).take(80).collect();
    let name = if name.trim().is_empty() { "chat".to_string() } else { name.trim().to_string() };
    let Some(picked) = app.dialog().file().add_filter("Markdown", &["md"]).set_file_name(format!("{name}.md")).blocking_save_file() else {
        return Ok(None);
    };
    let mut path = picked.into_path().map_err(|e| e.to_string())?;
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) {
        path.set_extension("md");
    }
    std::fs::write(&path, export::chat_markdown(&title, &msgs)).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command(async)]
fn delete_conversation(s: State<App>, id: String) {
    if let Some(a) = s.agents.lock().unwrap().remove(&id) {
        a.shutdown();
    }
    store::delete_conv(&s.db.lock().unwrap(), &id);
}

#[tauri::command(async)]
fn conversation_rename(s: State<App>, id: String, title: String) -> Result<(), String> {
    let t: String = title.trim().chars().take(120).collect();
    if t.is_empty() {
        return Err("A chat needs a name".into());
    }
    let c = s.db.lock().unwrap();
    store::rename(&c, &id, &t);
    // A name the user chose is never replaced by the automatic one.
    store::kv_set(&c, &format!("titled:{id}"), "1");
    Ok(())
}

#[tauri::command(async)]
fn conversation_pin(s: State<App>, id: String, on: bool) {
    store::set_pinned(&s.db.lock().unwrap(), &id, on);
}

#[tauri::command(async)]
fn search_conversations(s: State<App>, q: String) -> Vec<String> {
    store::search(&s.db.lock().unwrap(), &q)
}

/// Edit and regenerate: cuts the chat back to before user message `msg_id` and returns its text for resending.
#[tauri::command(async)]
fn conversation_rewind(s: State<App>, id: String, msg_id: i64) -> Result<String, String> {
    let running = s.agents.lock().unwrap().get(&id).cloned();
    if let Some(a) = running {
        if a.busy() {
            return Err("Wait for the current reply to finish, or stop it first.".into());
        }
        // The agent rereads its session file on the next message.
        s.agents.lock().unwrap().remove(&id);
        a.retire();
    }
    rewind::rewind(&s.db.lock().unwrap(), &id, msg_id)
}

#[tauri::command]
fn quit_anyway(app: AppHandle) {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command(async)]
fn load_messages(s: State<App>, id: String, after: Option<i64>) -> Vec<Value> {
    store::messages(&s.db.lock().unwrap(), &id, after.unwrap_or(0))
}

#[tauri::command(async)]
fn agent_send(app: AppHandle, s: State<App>, id: String, text: String) -> Result<(), String> {
    let a = agent::get_or_start(&app, &s.agents, &s.db, &s.strata, &id)?;
    let enabled = store::kv_get(&s.db.lock().unwrap(), "auto_edit").map(|v| v != "0").unwrap_or(true);
    a.set_auto_edit(enabled);
    {
        let c = s.db.lock().unwrap();
        setup::note_chat_sent(&c, &id);
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
#[tauri::command(async)]
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
#[tauri::command(async)]
fn attach_bytes(s: State<App>, id: String, name: String, data: Vec<u8>) -> Result<String, String> {
    let d = attach_dir(&s, &id)?;
    let dst = unique_in(&d, &name);
    std::fs::write(&dst, data).map_err(|e| e.to_string())?;
    Ok(format!("attachments/{}", dst.file_name().unwrap().to_string_lossy()))
}

#[tauri::command(async)]
fn agent_compact(app: AppHandle, s: State<App>, id: String) -> Result<(), String> {
    let a = agent::get_or_start(&app, &s.agents, &s.db, &s.strata, &id)?;
    a.send(json!({"type": "message", "msg_id": new_id(), "content": "/compact"}));
    Ok(())
}

fn live_dir(s: &State<App>, id: &str) -> Result<std::path::PathBuf, String> {
    let db = s.db.lock().map_err(|_| "Database lock unavailable")?;
    let (_, ws, _) = store::conv_info(&db, id).ok_or("Unknown chat")?;
    Ok(std::path::PathBuf::from(ws).join(".browser").join("live"))
}

/// Recent browser frames the workbench browser tool saved for this chat's live view (oldest first).
#[tauri::command(async)]
fn browser_frames(s: State<App>, id: String) -> Result<Value, String> {
    let dir = live_dir(&s, &id)?;
    let Ok(text) = std::fs::read_to_string(dir.join("index.json")) else { return Ok(json!([])) };
    let v: Value = serde_json::from_str(&text).unwrap_or(json!({}));
    let frames = v["frames"].as_array().cloned().unwrap_or_default();
    Ok(Value::Array(frames.into_iter().filter(|f| f["file"].as_str().is_some_and(|n| frame_name(n) && dir.join(n).is_file())).collect()))
}

fn frame_name(n: &str) -> bool {
    n.strip_prefix("frame-").and_then(|r| r.strip_suffix(".jpeg")).is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

#[tauri::command(async)]
fn browser_frame(s: State<App>, id: String, file: String) -> Result<tauri::ipc::Response, String> {
    if !frame_name(&file) { return Err("Not a browser frame".into()); }
    std::fs::read(live_dir(&s, &id)?.join(file)).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn context_usage(s: State<App>, id: String) -> Value {
    let used = store::kv_get(&s.db.lock().unwrap(), &format!("ctx:{id}")).and_then(|v| v.parse::<u64>().ok());
    json!({"used": used, "window": strata::context_window()})
}

#[tauri::command(async)]
fn agent_stop(s: State<App>, id: String) {
    let agent = s.agents.lock().unwrap().remove(&id);
    if let Some(a) = agent {
        a.stop_turn();
        // Upstream can stall while shutting down an MCP session after Stop.
        // Give it a bounded graceful exit, then stop only this agent's tree.
        a.shutdown();
    }
}

#[tauri::command(async)]
fn agent_answer(s: State<App>, id: String, call_id: String, allow: bool, remember: bool) {
    if let Some(a) = s.agents.lock().unwrap().get(&id) {
        a.answer(&call_id, allow, remember);
    }
}

#[tauri::command(async)]
fn get_setting(s: State<App>, key: String) -> Option<String> {
    store::kv_get(&s.db.lock().unwrap(), &key)
}

#[tauri::command(async)]
fn set_setting(s: State<App>, key: String, value: String) {
    store::kv_set(&s.db.lock().unwrap(), &key, &value);
}

#[tauri::command(async)]
fn memories_list(s: State<App>) -> Vec<Value> {
    let c = s.db.lock().unwrap();
    store::recent_memories(&c, 500).into_iter().map(|(id, text)| json!({"id": id, "text": text})).collect()
}

#[tauri::command(async)]
fn memory_delete(s: State<App>, id: i64) {
    store::delete_memory(&s.db.lock().unwrap(), id);
}

#[tauri::command(async)]
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
        .on_window_event(|window, event| {
            // Closing while a task runs asks first (the UI shows "Keep working" / "Quit anyway").
            if let WindowEvent::CloseRequested { api, .. } = event {
                if QUIT_CONFIRMED.load(Ordering::SeqCst) {
                    return;
                }
                let busy = window.state::<App>().agents.lock().unwrap().values().filter(|a| a.busy()).count();
                if busy > 0 {
                    api.prevent_close();
                    let _ = window.emit("close-blocked", busy);
                }
            }
        })
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
            updates::on_launch(&handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_config_read,
            browser_frames,
            browser_frame,
            run_config_save,
            documents::documents_list, documents::document_preview, documents::document_open,
            documents::document_revisions, documents::document_export,
            documents::document_save_visual, documents::document_save, documents::document_office_edit,
            setup::hardware_check, setup::set_strata_root, setup::probe_model_server, setup::set_model_server, setup::use_own_strata, setup::set_model_config, setup::set_web_access, updates::app_update_check, updates::app_update_install, updates::auto_update_get, updates::auto_update_set, setup::offline_get, setup::set_offline, setup::chat_offline_get, setup::chat_offline_set, setup::strata_update_check, setup::strata_update_apply,
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
            export_markdown,
            model_info,
            model_telemetry,
            desktop::open_external,
            set_auto_edit,
            agent_send,
            conversation_rename,
            conversation_pin,
            search_conversations,
            conversation_rewind,
            quit_anyway,
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
            voice::voice_tidy,
            plugins_list, plugin_set_enabled, status_items, system_stats, power_stats,
            plugin_import, plugin_export, plugin_remove, plugin_settings_set, plugins_folder, store_sources, store_sources_set, store_list, store_install, modes_list, effort_set, mode_switch
        ])
        .build(tauri::generate_context!())
        .expect("error while building app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                shutdown(&app.state::<App>());
            }
        });
}
