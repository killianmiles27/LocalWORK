//! App updates from GitHub releases (signed latest.json). Opt-in: with `auto_update` on, LocalWORK checks once
//! at launch and installs a newer version by itself. Nothing is fetched while offline mode is on.
use crate::{setup, store, App};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

async fn find(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    if setup::offline() {
        return Err(setup::OFFLINE_MSG.into());
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| format!("Could not check for updates: {e}"))
}

/// Download, verify the signature, run the installer and restart into the new version.
async fn install(app: &AppHandle, update: tauri_plugin_updater::Update) -> Result<(), String> {
    let _ = app.emit("app-update", json!({"state": "installing", "version": update.version}));
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| format!("The update could not be installed: {e}"))?;
    app.restart();
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    Ok(match find(&app).await? {
        Some(u) => json!({"available": true, "current": current, "version": u.version, "notes": u.body}),
        None => json!({"available": false, "current": current}),
    })
}

#[tauri::command]
pub async fn app_update_install(app: AppHandle) -> Result<(), String> {
    match find(&app).await? {
        Some(u) => install(&app, u).await,
        None => Err("LocalWORK is already up to date.".into()),
    }
}

#[tauri::command(async)]
pub fn auto_update_get(s: State<App>) -> bool {
    store::kv_get(&s.db.lock().unwrap(), "auto_update").as_deref() == Some("1")
}

#[tauri::command(async)]
pub fn auto_update_set(s: State<App>, on: bool) {
    store::kv_set(&s.db.lock().unwrap(), "auto_update", if on { "1" } else { "0" });
}

/// Launch-time check, only when the user opted in and offline mode is off. Failures are logged, not shown.
pub fn on_launch(app: &AppHandle) {
    let on = store::kv_get(&app.state::<App>().db.lock().unwrap(), "auto_update").as_deref() == Some("1");
    if !on || setup::offline() || cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match find(&app).await {
            Ok(Some(u)) => {
                if let Err(e) = install(&app, u).await {
                    eprintln!("auto-update: {e}");
                    let _ = app.emit("app-update", json!({"state": "failed", "error": e}));
                }
            }
            Ok(None) => {}
            Err(e) => eprintln!("auto-update: {e}"),
        }
    });
}
