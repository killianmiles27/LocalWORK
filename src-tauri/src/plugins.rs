//! Plugins: folders with a `plugin.json` that add model modes, skills, prompt text, MCP servers and
//! composer status items. Machine-specific setup (model paths, launch profiles) lives in a plugin so the
//! core app stays generic. Plugins are declarative only: no code is injected into the UI.
//!
//! Search order (a later folder overrides an earlier plugin with the same id):
//!   1. `<resources>/plugins`            bundled with the app
//!   2. `%LOCALAPPDATA%/Workbench/plugins` installed by the user
use crate::{http, paths, strata};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::io::Read;
use std::time::Duration;

#[derive(Clone)]
pub struct Plugin {
    pub id: String,
    pub dir: PathBuf,
    pub manifest: Value,
    pub enabled: bool,
    pub source: &'static str,
}

impl Plugin {
    fn contributes(&self, key: &str) -> Option<&Value> {
        self.manifest.get("contributes").and_then(|c| c.get(key))
    }
    fn str(&self, key: &str) -> String {
        self.manifest.get(key).and_then(Value::as_str).unwrap_or("").to_string()
    }
    /// A path from the manifest: `${pluginDir}`, `${dataDir}`, `${strataRoot}` and `${env:NAME}` are expanded,
    /// and a relative result is taken from the plugin folder.
    pub fn resolve(&self, raw: &str) -> PathBuf {
        let s = expand(raw, &self.dir);
        let p = PathBuf::from(if cfg!(windows) { s.replace('/', "\\") } else { s });
        if p.is_absolute() { p } else { self.dir.join(p) }
    }
}

fn expand(raw: &str, dir: &Path) -> String {
    let mut s = raw
        .replace("${pluginDir}", &dir.to_string_lossy())
        .replace("${dataDir}", &paths::data_dir().to_string_lossy())
        .replace("${strataRoot}", &strata::setting("strataRoot", &paths::default_strata_root()));
    while let Some(i) = s.find("${env:") {
        let Some(j) = s[i..].find('}') else { break };
        let name = &s[i + 6..i + j];
        let val = std::env::var(name).unwrap_or_default();
        s.replace_range(i..i + j + 1, &val);
    }
    s
}

fn expand_value(v: &Value, dir: &Path) -> Value {
    match v {
        Value::String(s) => Value::String(expand(s, dir)),
        Value::Array(a) => Value::Array(a.iter().map(|x| expand_value(x, dir)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), expand_value(x, dir))).collect()),
        x => x.clone(),
    }
}

pub fn roots() -> Vec<(PathBuf, &'static str)> {
    vec![(paths::resource_dir("plugins"), "bundled"), (paths::data_dir().join("plugins"), "user")]
}

fn settings() -> Value {
    std::fs::read_to_string(paths::data_dir().join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

fn disabled_ids() -> Vec<String> {
    settings()
        .get("disabledPlugins")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Plugin folders whose manifest cannot be used, as (folder name, source, folder, reason), so Settings can
/// say why a plugin is missing instead of it vanishing.
fn broken() -> Vec<(String, &'static str, PathBuf, String)> {
    let mut out = vec![];
    for (root, source) in roots() {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        for e in rd.flatten() {
            let dir = e.path();
            let Ok(text) = std::fs::read_to_string(dir.join("plugin.json")) else { continue };
            let why = match serde_json::from_str::<Value>(&text) {
                Err(err) => format!("plugin.json is not valid JSON ({err}). In paths, write / or \\\\ instead of a single \\."),
                Ok(m) if !valid_id(m.get("id").and_then(Value::as_str).unwrap_or("")) => "plugin.json needs an \"id\" of letters, digits, - _ or .".into(),
                Ok(_) => continue,
            };
            out.push((e.file_name().to_string_lossy().into(), source, dir, why));
        }
    }
    out
}

pub fn all() -> Vec<Plugin> {
    let off = disabled_ids();
    let mut by_id: BTreeMap<String, Plugin> = BTreeMap::new();
    for (root, source) in roots() {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        for e in rd.flatten() {
            let dir = e.path();
            let Ok(text) = std::fs::read_to_string(dir.join("plugin.json")) else { continue };
            let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
                eprintln!("plugin {}: plugin.json is not valid JSON", dir.display());
                continue;
            };
            let id = manifest.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            if !valid_id(&id) {
                eprintln!("plugin {}: missing or invalid id", dir.display());
                continue;
            }
            let default_on = manifest.get("enabledByDefault").and_then(Value::as_bool).unwrap_or(true);
            let enabled = !off.contains(&id) && (default_on || enabled_ids().contains(&id));
            by_id.insert(id.clone(), Plugin { id, dir, manifest, enabled, source });
        }
    }
    by_id.into_values().collect()
}

fn enabled_ids() -> Vec<String> {
    settings()
        .get("enabledPlugins")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

pub fn enabled() -> Vec<Plugin> {
    all().into_iter().filter(|p| p.enabled).collect()
}

/// Core skills first, then each enabled plugin's skills folder.
pub fn skill_dirs() -> Vec<PathBuf> {
    let mut v = vec![paths::resource_dir("skills")];
    for p in enabled() {
        if let Some(s) = p.contributes("skills").and_then(Value::as_str) {
            let d = p.resolve(s);
            if d.is_dir() { v.push(d); }
        }
    }
    v
}

/// Extra system-prompt text from enabled plugins (each file capped so a plugin cannot flood the context).
pub fn prompt_addenda() -> String {
    let mut out = String::new();
    for p in enabled() {
        let Some(f) = p.contributes("systemPrompt").and_then(Value::as_str) else { continue };
        let Ok(t) = std::fs::read_to_string(p.resolve(f)) else { continue };
        let t: String = t.trim().chars().take(4000).collect();
        if !t.is_empty() { out.push_str("\n\n"); out.push_str(&t); }
    }
    out
}

/// `add_mcp_server` messages for plugin MCP servers (stdio only).
pub fn mcp_servers() -> Vec<Value> {
    let mut v = vec![];
    for p in enabled() {
        let Some(servers) = p.contributes("mcpServers").and_then(Value::as_object) else { continue };
        for (name, spec) in servers {
            if !valid_id(name) || name == "workbench" { continue; }
            let spec = expand_value(spec, &p.dir);
            let Some(command) = spec.get("command").and_then(Value::as_str) else { continue };
            v.push(json!({
                "type": "add_mcp_server", "name": name, "transport": "stdio",
                "command": p.resolve(command).to_string_lossy(),
                "args": spec.get("args").cloned().unwrap_or(json!([])),
                "env": spec.get("env").cloned().unwrap_or(json!({})),
            }));
        }
    }
    v
}

// ---------------------------------------------------------------------------------------------- modes

/// Every model mode from enabled plugins. A mode points at a Strata run config; `active` marks the one
/// the app is set to now.
pub fn modes() -> Vec<Value> {
    // On a server the user runs, no Strata mode is the one loaded.
    let current = if strata::external() { "<external server>".to_string() } else { norm(&strata::setting("modelConfig", &paths::default_model_config())) };
    let mut out = vec![];
    let picker_configs = settings().get("localPickerConfigs").and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(norm).collect::<std::collections::BTreeSet<_>>());
    for p in enabled() {
        let Some(list) = p.contributes("modes").and_then(Value::as_array) else { continue };
        for m in list {
            let Some(mid) = m.get("id").and_then(Value::as_str).filter(|s| valid_id(s)) else { continue };
            let Some(cfg) = m.get("config").and_then(Value::as_str) else { continue };
            let path = p.resolve(cfg);
            let ctx = context_of(&path);
            let mut mode = json!({
                "id": format!("{}/{}", p.id, mid),
                "plugin": p.id,
                "label": m.get("label").and_then(Value::as_str).unwrap_or(mid),
                "description": m.get("description").and_then(Value::as_str).unwrap_or(""),
                "group": m.get("group").and_then(Value::as_str).unwrap_or("Modes"),
                "config": path.to_string_lossy(),
                "context": ctx,
                "found": path.is_file(),
                "active": norm(&path.to_string_lossy()) == current,
            });
            add_picker_metadata(&mut mode, &path, m.get("label").and_then(Value::as_str), picker_configs.as_ref());
            out.push(mode);
        }
    }
    // Run configs saved in Strata's profiles folder (for example from Settings) that no plugin names.
    let dir = PathBuf::from(strata::setting("strataRoot", &paths::default_strata_root())).join("profiles");
    let mut extra: Vec<PathBuf> = std::fs::read_dir(&dir).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    extra.retain(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("json")));
    extra.sort();
    for path in extra {
        let key = norm(&path.to_string_lossy());
        if out.iter().any(|m| norm(m["config"].as_str().unwrap_or("")) == key) { continue; }
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let mut mode = json!({
            "id": format!("profile/{stem}"), "plugin": null, "label": stem, "description": "", "group": "Profiles",
            "config": path.to_string_lossy(), "context": context_of(&path), "found": true, "active": key == current,
        });
        add_picker_metadata(&mut mode, &path, Some(&stem), picker_configs.as_ref());
        out.push(mode);
    }
    // Models set up in the Strata folder itself (strata-<model>.json). PolyStrata keeps one per installed model.
    let root = PathBuf::from(strata::setting("strataRoot", &paths::default_strata_root()));
    for (path, label) in root_models(&root) {
        let key = norm(&path.to_string_lossy());
        if out.iter().any(|m| norm(m["config"].as_str().unwrap_or("")) == key) { continue; }
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let mut mode = json!({
            "id": format!("model/{stem}"), "plugin": null, "label": label, "description": "", "group": "Models",
            "config": path.to_string_lossy(), "context": context_of(&path), "found": true, "active": key == current,
        });
        add_picker_metadata(&mut mode, &path, Some(&label), picker_configs.as_ref());
        out.push(mode);
    }
    // Which engine runs each one (a PolyStrata config is launched with PolyStrata's server).
    for m in out.iter_mut() {
        let cfg = m["config"].as_str().unwrap_or("").to_string();
        m["engine"] = json!(crate::setup::engine(&strata::server_root(&cfg, &root)));
    }
    out
}

fn config_model_value(path: &Path) -> Value {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

fn nonempty_string<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn humanize_model_name(s: &str) -> String {
    s.replace('-', " ").split_whitespace().map(|part| {
        let mut chars = part.chars();
        chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
    }).collect::<Vec<_>>().join(" ")
}

fn context_label(context: Option<u64>) -> String {
    context.map(|n| {
        if n >= 1024 * 1024 { format!("{}M", n / (1024 * 1024)) }
        else if n >= 1024 { format!("{}K", n / 1024) }
        else { n.to_string() }
    }).unwrap_or_else(|| "Default".into())
}

fn picker_visible(path: &Path, visible: Option<&std::collections::BTreeSet<String>>) -> bool {
    visible.is_none_or(|set| set.contains(&norm(&path.to_string_lossy())))
}

fn add_picker_metadata(mode: &mut Value, path: &Path, fallback_name: Option<&str>, visible: Option<&std::collections::BTreeSet<String>>) {
    let cfg = config_model_value(path);
    let model_name = nonempty_string(&cfg, "model_name");
    let display_name = nonempty_string(&cfg, "display_name");
    let model_label = nonempty_string(&cfg, "model_display_name")
        .or(model_name)
        .or(display_name)
        .or(fallback_name)
        .unwrap_or("Model");
    let model_id = model_name.or(display_name).or(fallback_name).unwrap_or("model");
    let context = mode.get("context").and_then(Value::as_u64);
    let profile_label = context_label(context);
    mode["modelId"] = json!(model_id);
    mode["modelLabel"] = json!(humanize_model_name(model_label));
    mode["profileLabel"] = json!(profile_label);
    mode["local"] = json!(true);
    mode["pickerVisible"] = json!(picker_visible(path, visible));
}

/// Validate and persist the model picker visibility list without replacing unrelated settings.
/// `None` resets visibility to all discovered configs; `Some([])` hides all configs.
pub fn picker_configs_set(configs: Option<Vec<String>>) -> Result<(), String> {
    let Some(configs) = configs else {
        return update_settings(|v| { v.as_object_mut().map(|o| o.remove("localPickerConfigs")); });
    };
    let discovered: std::collections::BTreeSet<String> = modes().iter()
        .filter_map(|m| m.get("config").and_then(Value::as_str).map(norm)).collect();
    let mut clean = std::collections::BTreeSet::new();
    for config in configs {
        let key = norm(&config);
        if !discovered.contains(&key) { return Err("A selected model config is no longer available.".into()); }
        clean.insert(key);
    }
    update_settings(|v| { v["localPickerConfigs"] = json!(clean.into_iter().collect::<Vec<_>>()); })
}

/// `strata-*.json` run configs in a Strata or PolyStrata folder, with a display name each.
pub fn root_models(root: &Path) -> Vec<(PathBuf, String)> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(root).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    files.retain(|f| {
        let n = f.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
        n.starts_with("strata-") && n.ends_with(".json")
    });
    files.sort();
    files
        .into_iter()
        .filter_map(|f| {
            let v: Value = serde_json::from_str(&std::fs::read_to_string(&f).ok()?).ok()?;
            v.get("args")?.as_array()?;
            let stem = f.file_stem()?.to_string_lossy().to_string();
            let label = ["display_name", "model_name"]
                .iter()
                .find_map(|k| v.get(*k).and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(String::from))
                .unwrap_or_else(|| stem.trim_start_matches("strata-").to_string());
            Some((f, label))
        })
        .collect()
}

fn norm(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
}

fn context_of(cfg: &Path) -> Option<u64> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(cfg).ok()?).ok()?;
    let a = v.get("args")?.as_array()?;
    let i = a.iter().position(|x| matches!(x.as_str(), Some("--max-context" | "--ctx")))?;
    a.get(i + 1)?.as_str()?.parse().ok()
}

pub fn find_mode(id: &str) -> Option<Value> {
    modes().into_iter().find(|m| m["id"] == id)
}

// ------------------------------------------------------------------------------------------- effort

pub const EFFORTS: [&str; 4] = ["none", "low", "medium", "high"];

/// The reasoning effort the running server applies to requests that name none: the shared Chat setting,
/// else the run config's. Changing it takes effect on the next request; no reload.
pub fn effort_get(s: &strata::Shared) -> Value {
    let cfg_effort = std::fs::read_to_string(strata::setting("modelConfig", &paths::default_model_config()))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("reasoning_effort").and_then(Value::as_str).map(String::from));
    let shared = shared_defaults(s);
    let live = shared.as_ref().and_then(|d| d.get("reasoning_effort")).and_then(Value::as_str).map(String::from);
    json!({"effort": live.clone().or(cfg_effort.clone()), "config": cfg_effort, "override": live, "options": EFFORTS})
}

fn shared_defaults(s: &strata::Shared) -> Option<Value> {
    let (port, key, ready) = {
        let g = s.lock().unwrap();
        (g.status.port, g.key.clone(), g.status.state == "ready")
    };
    if !ready { return None; }
    let (code, body) = http::get(port, "/settings", Some(&key), Duration::from_millis(900))?;
    if code != 200 { return None; }
    serde_json::from_str::<Value>(&body).ok()?.get("defaults").cloned()
}

pub fn effort_set(s: &strata::Shared, effort: Option<String>) -> Result<Value, String> {
    if let Some(e) = &effort {
        if !EFFORTS.contains(&e.as_str()) { return Err(format!("effort must be one of {}", EFFORTS.join(", "))); }
    }
    let (port, key, ready) = {
        let g = s.lock().unwrap();
        (g.status.port, g.key.clone(), g.status.state == "ready")
    };
    if !ready { return Err("The model is not running yet.".into()); }
    // POST /settings replaces the whole set, so keep the other shared keys.
    let mut d = shared_defaults(s).filter(Value::is_object).unwrap_or(json!({}));
    match &effort {
        Some(e) => d["reasoning_effort"] = json!(e),
        None => { d.as_object_mut().map(|o| o.remove("reasoning_effort")); }
    }
    let body = json!({"defaults": if d.as_object().is_some_and(|o| o.is_empty()) { Value::Null } else { d }}).to_string();
    match http::post_json(port, "/settings", Some(&key), &body, Duration::from_secs(3)) {
        Some((200, _)) => Ok(effort_get(s)),
        Some((c, b)) => Err(format!("Strata refused the setting ({c}): {}", b.chars().take(200).collect::<String>())),
        None => Err("Strata did not answer.".into()),
    }
}

// --------------------------------------------------------------------------------------- UI listing

pub fn status_items() -> Vec<Value> {
    let mut out = vec![];
    for p in enabled() {
        let Some(list) = p.contributes("statusItems").and_then(Value::as_array) else { continue };
        let set = settings_of(&p);
        for it in list {
            let mut it = it.clone();
            if let Some(o) = it.as_object_mut() {
                for v in o.values_mut() {
                    if let Value::String(t) = v {
                        while let Some(i) = t.find("${setting:") {
                            let Some(j) = t[i..].find('}') else { break };
                            let val = match set.get(&t[i + 10..i + j]) { Some(Value::String(x)) => x.clone(), Some(Value::Null) | None => String::new(), Some(x) => x.to_string() };
                            t.replace_range(i..i + j + 1, &val);
                        }
                    }
                }
            }
            it["plugin"] = json!(p.id);
            it["settings"] = set.clone();
            out.push(it);
        }
    }
    out
}

pub fn list_json() -> Vec<Value> {
    all()
        .into_iter()
        .map(|p| {
            let c = p.manifest.get("contributes").cloned().unwrap_or(json!({}));
            let kinds: Vec<&str> = ["modes", "skills", "systemPrompt", "mcpServers", "statusItems"]
                .into_iter()
                .filter(|k| c.get(*k).is_some())
                .collect();
            json!({
                "id": p.id, "name": if p.str("name").is_empty() { p.id.clone() } else { p.str("name") },
                "version": p.str("version"), "description": p.str("description"),
                "enabled": p.enabled, "source": p.source, "dir": p.dir.to_string_lossy(), "contributes": kinds,
                "settingsSchema": p.manifest.get("settings").cloned().unwrap_or(json!([])), "settings": settings_of(&p),
                "homepage": p.str("homepage"), "author": p.str("author"),
            })
        })
        .chain(broken().into_iter().map(|(name, source, dir, why)| json!({
            "id": format!("broken:{name}"), "name": name, "version": "", "description": "", "enabled": false,
            "source": source, "dir": dir.to_string_lossy(), "contributes": [], "error": why,
        })))
        .collect()
}

pub fn set_enabled(id: &str, on: bool) -> Result<(), String> {
    if !all().iter().any(|p| p.id == id) { return Err(format!("no plugin {id}")); }
    update_settings(|v| {
        for (key, add) in [("disabledPlugins", !on), ("enabledPlugins", on)] {
            let mut ids: Vec<String> = v.get(key).and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            ids.retain(|x| x != id);
            if add { ids.push(id.to_string()); }
            v[key] = json!(ids);
        }
    })
}

/// Change settings.json in place: other keys are kept, and the file is written beside and swapped in,
/// so a crash mid-write cannot leave the user's settings half written.
fn update_settings(change: impl FnOnce(&mut Value)) -> Result<(), String> {
    let f = paths::data_dir().join("settings.json");
    let mut v: Value = match std::fs::read_to_string(&f) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("settings.json is invalid JSON; left unchanged: {e}"))?,
        Err(_) => json!({}),
    };
    if !v.is_object() { return Err("settings.json must be an object; left unchanged".into()); }
    change(&mut v);
    let tmp = f.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------------------------ plugin settings

/// A plugin's settings: the manifest's `settings` defaults, overlaid with what the user saved
/// (settings.json `pluginSettings.<id>`). Only keys the manifest declares are kept.
pub fn settings_of(p: &Plugin) -> Value {
    let saved = settings().get("pluginSettings").and_then(|s| s.get(&p.id)).cloned().unwrap_or(json!({}));
    let mut out = serde_json::Map::new();
    for f in p.manifest.get("settings").and_then(Value::as_array).into_iter().flatten() {
        let Some(key) = f.get("key").and_then(Value::as_str) else { continue };
        let v = saved.get(key).cloned().unwrap_or_else(|| f.get("default").cloned().unwrap_or(Value::Null));
        out.insert(key.to_string(), v);
    }
    Value::Object(out)
}

pub fn set_settings(id: &str, values: &Value) -> Result<Value, String> {
    let p = all().into_iter().find(|p| p.id == id).ok_or_else(|| format!("no plugin {id}"))?;
    let schema = p.manifest.get("settings").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut clean = serde_json::Map::new();
    for f in &schema {
        let Some(key) = f.get("key").and_then(Value::as_str) else { continue };
        let Some(v) = values.get(key) else { continue };
        let ok = match f.get("type").and_then(Value::as_str).unwrap_or("text") {
            "number" => v.as_f64().is_some_and(f64::is_finite),
            "boolean" => v.is_boolean(),
            _ => v.as_str().is_some_and(|t| t.chars().count() <= 200),
        };
        if !ok { return Err(format!("{key}: wrong kind of value")); }
        clean.insert(key.to_string(), v.clone());
    }
    update_settings(|v| {
        if !v.get("pluginSettings").is_some_and(Value::is_object) { v["pluginSettings"] = json!({}); }
        v["pluginSettings"][id] = Value::Object(clean);
    })?;
    Ok(settings_of(&p))
}

// --------------------------------------------------------------------------- import, export, remove

const MAX_IMPORT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_IMPORT_FILES: usize = 20_000;

fn user_root() -> PathBuf {
    paths::data_dir().join("plugins")
}

fn copy_dir(from: &Path, to: &Path, count: &mut usize) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        *count += 1;
        if *count > MAX_IMPORT_FILES { return Err("The plugin has too many files.".into()); }
        let ft = e.file_type().map_err(|e| e.to_string())?;
        if ft.is_symlink() { continue; }
        let dest = to.join(e.file_name());
        if ft.is_dir() { copy_dir(&e.path(), &dest, count)?; } else { std::fs::copy(e.path(), dest).map_err(|e| e.to_string())?; }
    }
    Ok(())
}

pub fn unzip(zip_path: &Path, to: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| format!("Not a readable .zip: {e}"))?;
    if z.len() > MAX_IMPORT_FILES { return Err("The plugin has too many files.".into()); }
    let mut total = 0u64;
    for i in 0..z.len() {
        let mut item = z.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name refuses absolute paths and `..`, so nothing lands outside the staging folder.
        let Some(rel) = item.enclosed_name() else { return Err(format!("Unsafe path in the .zip: {}", item.name().unwrap_or_default())); };
        let dest = to.join(rel);
        if item.is_dir() { std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?; continue; }
        total += item.size();
        if total > MAX_IMPORT_BYTES { return Err("The plugin is larger than 256 MB.".into()); }
        if let Some(parent) = dest.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut (&mut item).take(MAX_IMPORT_BYTES), &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The folder holding plugin.json: the staging folder itself or its single subfolder.
fn manifest_dir(stage: &Path) -> Option<PathBuf> {
    if stage.join("plugin.json").is_file() { return Some(stage.to_path_buf()); }
    let subs: Vec<PathBuf> = std::fs::read_dir(stage).ok()?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    match subs.as_slice() {
        [one] if one.join("plugin.json").is_file() => Some(one.clone()),
        _ => None,
    }
}

/// Every plugin in the staging folder: one plugin, or a pack whose subfolders each hold a plugin.json
/// (optionally wrapped in one top folder, as a zipped pack folder is).
fn manifest_dirs(stage: &Path) -> Vec<PathBuf> {
    if let Some(one) = manifest_dir(stage) { return vec![one]; }
    let subs = |d: &Path| -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(d).map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
        v.sort();
        v
    };
    let mut top = subs(stage);
    if let [only] = top.as_slice() { top = subs(only); }
    top.into_iter().filter(|d| d.join("plugin.json").is_file()).collect()
}

fn install_dir(dir: &Path, root: &Path, n: u32) -> Result<Value, String> {
    let m: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("plugin.json")).map_err(|e| e.to_string())?)
        .map_err(|e| format!("plugin.json is not valid JSON: {e}"))?;
    let id = m.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    if !valid_id(&id) { return Err("plugin.json needs an \"id\" of letters, digits, - _ or .".into()); }
    let target = root.join(&id);
    let old = root.join(format!(".old-{n:08x}"));
    if target.exists() { std::fs::rename(&target, &old).map_err(|e| format!("Could not replace the installed copy of {id}: {e}"))?; }
    if let Err(e) = std::fs::rename(dir, &target) {
        if old.exists() { let _ = std::fs::rename(&old, &target); }
        return Err(e.to_string());
    }
    let _ = std::fs::remove_dir_all(&old);
    let runs = m.get("contributes").and_then(|c| c.get("mcpServers")).is_some_and(|v| v.as_object().is_some_and(|o| !o.is_empty()));
    if runs { set_enabled(&id, false)?; }
    Ok(json!({"id": id, "name": m.get("name").cloned().unwrap_or(json!(id)), "runsPrograms": runs, "enabled": !runs}))
}

/// Install a plugin, or a pack of plugins, from a folder or a .zip into the user plugins folder, replacing
/// older copies with the same id. A plugin that starts programs (MCP servers) arrives turned off so the user decides.
pub fn import(src: &str) -> Result<Value, String> {
    let src = PathBuf::from(src);
    let root = user_root();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let n: u32 = rand::random();
    let stage = root.join(format!(".import-{n:08x}"));
    let result = (|| {
        if src.is_dir() {
            copy_dir(&src, &stage, &mut 0)?;
        } else if src.extension().is_some_and(|x| x.eq_ignore_ascii_case("zip")) {
            unzip(&src, &stage)?;
        } else {
            return Err("Choose a plugin folder or a .zip file.".into());
        }
        let dirs = manifest_dirs(&stage);
        if dirs.is_empty() { return Err("No plugin.json found at the top of the plugin or in its subfolders.".into()); }
        // Check every manifest before installing any, so a broken pack changes nothing.
        for d in &dirs {
            let m: Value = serde_json::from_str(&std::fs::read_to_string(d.join("plugin.json")).map_err(|e| e.to_string())?)
                .map_err(|e| format!("{}: plugin.json is not valid JSON: {e}", d.file_name().unwrap_or_default().to_string_lossy()))?;
            if !valid_id(m.get("id").and_then(Value::as_str).unwrap_or("")) {
                return Err(format!("{}: plugin.json needs an \"id\" of letters, digits, - _ or .", d.file_name().unwrap_or_default().to_string_lossy()));
            }
        }
        if dirs.len() == 1 { return install_dir(&dirs[0], &root, n); }
        let mut installed = Vec::new();
        for d in &dirs { installed.push(install_dir(d, &root, n)?); }
        let names: Vec<String> = installed.iter().map(|v| v["name"].as_str().unwrap_or("").to_string()).collect();
        let runs = installed.iter().any(|v| v["runsPrograms"] == json!(true));
        Ok(json!({"name": format!("{} plugins ({})", installed.len(), names.join(", ")), "runsPrograms": runs, "plugins": installed}))
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result
}

fn zip_dir(z: &mut zip::ZipWriter<std::fs::File>, dir: &Path, prefix: &str) -> Result<(), String> {
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut entries: Vec<_> = std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = format!("{prefix}/{}", e.file_name().to_string_lossy());
        let ft = e.file_type().map_err(|e| e.to_string())?;
        if ft.is_symlink() { continue; }
        if ft.is_dir() {
            z.add_directory(format!("{name}/"), opts).map_err(|e| e.to_string())?;
            zip_dir(z, &e.path(), &name)?;
        } else {
            z.start_file(name, opts).map_err(|e| e.to_string())?;
            let mut f = std::fs::File::open(e.path()).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, z).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Write a plugin (bundled or user) to a .zip that `import` accepts.
pub fn export(id: &str, dest: &str) -> Result<(), String> {
    let p = all().into_iter().find(|p| p.id == id).ok_or_else(|| format!("no plugin {id}"))?;
    let tmp = PathBuf::from(format!("{dest}.part"));
    let f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut z = zip::ZipWriter::new(f);
    let done = zip_dir(&mut z, &p.dir, &p.id).and_then(|_| z.finish().map(|_| ()).map_err(|e| e.to_string()));
    if let Err(e) = done { let _ = std::fs::remove_file(&tmp); return Err(e); }
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

/// Remove a user-installed plugin. Bundled plugins can only be turned off.
pub fn remove(id: &str) -> Result<(), String> {
    let p = all().into_iter().find(|p| p.id == id && p.source == "user").ok_or("Only plugins you installed can be removed; bundled ones can be turned off.")?;
    let root = std::fs::canonicalize(user_root()).map_err(|e| e.to_string())?;
    let dir = std::fs::canonicalize(&p.dir).map_err(|e| e.to_string())?;
    if !dir.starts_with(&root) || dir == root { return Err("The plugin is not inside the plugins folder.".into()); }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

pub fn user_folder() -> PathBuf {
    let r = user_root();
    let _ = std::fs::create_dir_all(&r);
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expands_placeholders_and_rejects_bad_ids() {
        std::env::set_var("LW_TEST_X", "abc");
        let d = PathBuf::from("C:\\p");
        assert_eq!(expand("${pluginDir}\\x-${env:LW_TEST_X}", &d), "C:\\p\\x-abc");
        assert!(valid_id("swift.local-1"));
        assert!(!valid_id("../evil"));
        assert!(!valid_id(""));
        assert_eq!(norm("C:/A/b.json"), norm("c:\\a\\B.json"));
    }

    #[test]
    fn zip_round_trip_and_refuses_escaping_paths() {
        let base = std::env::temp_dir().join(format!("lw-plugin-test-{:08x}", rand::random::<u32>()));
        let src = base.join("demo");
        std::fs::create_dir_all(src.join("skills")).unwrap();
        std::fs::write(src.join("plugin.json"), r#"{"id":"demo"}"#).unwrap();
        std::fs::write(src.join("skills").join("a.md"), "hi").unwrap();
        let zp = base.join("demo.zip");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&zp).unwrap());
        zip_dir(&mut z, &src, "demo").unwrap();
        z.finish().unwrap();
        let out = base.join("out");
        unzip(&zp, &out).unwrap();
        let dir = manifest_dir(&out).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("skills").join("a.md")).unwrap(), "hi");

        let evil = base.join("evil.zip");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&evil).unwrap());
        z.start_file("../escape.txt", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut z, b"x").unwrap();
        z.finish().unwrap();
        assert!(unzip(&evil, &base.join("out2")).is_err());
        assert!(!base.join("escape.txt").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn lists_models_in_a_polystrata_folder() {
        let d = std::env::temp_dir().join(format!("lw-poly-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("polystrata.py"), "").unwrap();
        std::fs::write(d.join("strata-glm-5.3.json"), r#"{"exe":"x","args":["--max-context","65536"],"model_name":"glm-5.3","display_name":"GLM 5.3"}"#).unwrap();
        std::fs::write(d.join("strata-qwen.json"), r#"{"args":[]}"#).unwrap();
        std::fs::write(d.join("strata-bad.json"), r#"{"model_name":"no args"}"#).unwrap();
        std::fs::write(d.join("strata-old.json.bak"), "{}").unwrap();
        let m = super::root_models(&d);
        assert_eq!(m.iter().map(|(_, l)| l.as_str()).collect::<Vec<_>>(), ["GLM 5.3", "qwen"]);
        assert_eq!(super::context_of(&m[0].0), Some(65536));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn picker_metadata_groups_profiles_and_hides_only_picker_entries() {
        let d = std::env::temp_dir().join(format!("lw-picker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let a = d.join("swift-128.json");
        let b = d.join("swift-256.json");
        std::fs::write(&a, r#"{"model_name":"swift-qwen3.8-flash-next-q2_0","model_display_name":"Swift Q2_0","args":["--max-context","131072"]}"#).unwrap();
        std::fs::write(&b, r#"{"model_name":"swift-qwen3.8-flash-next-q2_0","model_display_name":"Swift Q2_0","args":["--max-context","262144"]}"#).unwrap();
        let mut ma = json!({"config": a.to_string_lossy(), "context": context_of(&a)});
        let mut mb = json!({"config": b.to_string_lossy(), "context": context_of(&b)});
        add_picker_metadata(&mut ma, &a, Some("swift-128"), None);
        add_picker_metadata(&mut mb, &b, Some("swift-256"), None);

        assert_eq!(ma["modelId"], mb["modelId"]);
        assert_eq!(ma["modelLabel"], "Swift Q2_0");
        assert_eq!(ma["profileLabel"], "128K");
        assert_eq!(mb["profileLabel"], "256K");
        assert_eq!(ma["local"], true);
        assert_eq!(ma["pickerVisible"], true);
        // Picker metadata contains only display/group values, never the source config path.
        for key in ["modelId", "modelLabel", "profileLabel"] {
            assert!(!ma[key].as_str().unwrap().contains(&d.to_string_lossy().to_string()));
        }

        let hidden = std::collections::BTreeSet::from([norm(&b.to_string_lossy())]);
        assert!(picker_visible(&b, Some(&hidden)));
        assert!(!picker_visible(&a, Some(&hidden)));
        assert!(picker_visible(&a, None));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn finds_every_plugin_in_a_pack() {
        let base = std::env::temp_dir().join(format!("lw-pack-test-{:08x}", rand::random::<u32>()));
        let pack = base.join("pack");
        for id in ["a", "b"] {
            std::fs::create_dir_all(pack.join(id)).unwrap();
            std::fs::write(pack.join(id).join("plugin.json"), format!(r#"{{"id":"{id}"}}"#)).unwrap();
        }
        std::fs::create_dir_all(pack.join("notes")).unwrap();
        let names = |v: Vec<PathBuf>| v.iter().map(|d| d.file_name().unwrap().to_string_lossy().to_string()).collect::<Vec<_>>();
        assert_eq!(names(manifest_dirs(&pack)), ["a", "b"]);
        // a zipped pack folder unpacks with one wrapping folder
        assert_eq!(names(manifest_dirs(&base)), ["a", "b"]);
        assert_eq!(names(manifest_dirs(&pack.join("a"))), ["a"]);
        let _ = std::fs::remove_dir_all(&base);
    }
}
