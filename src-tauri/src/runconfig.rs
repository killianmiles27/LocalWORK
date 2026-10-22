//! Read and save Strata run configs from Settings, so context, KV cache, model file, speculation and
//! sampling can be changed without editing JSON by hand. Saving keeps every field the editor does not
//! know about, refuses to change what the config runs (exe, cwd, lib_dirs, env), and backs up the
//! previous file once per save.
use crate::{paths, plugins, strata};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn profiles_dir() -> PathBuf {
    PathBuf::from(strata::setting("strataRoot", &paths::default_strata_root())).join("profiles")
}

fn same(a: &Path, b: &Path) -> bool {
    let n = |p: &Path| p.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    n(a) == n(b)
}

/// Only configs the app already knows: the current one, a mode's, or one in the profiles folder.
fn allowed(path: &Path) -> Result<(), String> {
    if !path.extension().is_some_and(|x| x.eq_ignore_ascii_case("json")) || !path.is_file() {
        return Err("Not a run config file.".into());
    }
    let current = PathBuf::from(strata::setting("modelConfig", &paths::default_model_config()));
    let in_profiles = path.parent().is_some_and(|d| same(d, &profiles_dir()));
    let a_mode = plugins::modes().iter().any(|m| same(Path::new(m["config"].as_str().unwrap_or("")), path));
    if in_profiles || a_mode || same(path, &current) { Ok(()) } else { Err("That file is not one of the app's run configs.".into()) }
}

pub fn read(path: &str) -> Result<Value, String> {
    let p = PathBuf::from(path);
    allowed(&p)?;
    serde_json::from_str(&std::fs::read_to_string(&p).map_err(|e| e.to_string())?).map_err(|e| format!("Invalid JSON: {e}"))
}

fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 40 && n.chars().all(|c| c.is_ascii_alphanumeric() || " -_.".contains(c)) && !n.starts_with('.')
}

/// Save `config` over `path`, or as `<profiles>/<new_name>.json`. Returns the written path.
pub fn save(path: &str, config: Value, new_name: Option<String>) -> Result<String, String> {
    let src = PathBuf::from(path);
    let old = read(path)?;
    let mut cfg = config;
    let Some(obj) = cfg.as_object_mut() else { return Err("Config must be an object.".into()) };
    for k in ["exe", "cwd", "lib_dirs", "env"] {
        if obj.get(k) != old.get(k) { return Err(format!("`{k}` cannot be changed here.")); }
    }
    if !obj.get("args").is_some_and(|a| a.as_array().is_some_and(|a| a.iter().all(Value::is_string))) {
        return Err("`args` must be a list of strings.".into());
    }
    let dest = match &new_name {
        Some(n) => {
            let n = n.trim();
            if !valid_name(n) { return Err("Use letters, digits, spaces, - _ or . (up to 40) for the name.".into()); }
            let d = profiles_dir().join(format!("{n}.json"));
            if d.exists() { return Err(format!("A profile named {n} already exists.")); }
            if let Some(log) = obj.get("log").and_then(Value::as_str) {
                let dir = Path::new(log).parent().map(Path::to_path_buf).unwrap_or_default();
                obj.insert("log".into(), Value::String(dir.join(format!("{n}.engine.log")).to_string_lossy().into()));
            }
            d
        }
        None => {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let bak = src.with_extension(format!("json.bak-{stamp}"));
            std::fs::copy(&src, &bak).map_err(|e| format!("Backup failed: {e}"))?;
            src.clone()
        }
    };
    std::fs::create_dir_all(dest.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    let tmp = dest.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into())
}

/// Add a model: copy a Strata or PolyStrata run config (for example one its setup or a tuning tool wrote) into
/// the profiles folder, so it shows in the model menu. Returns the new path.
pub fn import(src: &str) -> Result<String, String> {
    let src = PathBuf::from(src);
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&src).map_err(|e| format!("Could not read {}: {e}", src.display()))?)
        .map_err(|e| format!("Not valid JSON: {e}"))?;
    if !v.get("args").is_some_and(|a| a.as_array().is_some_and(|a| a.iter().all(Value::is_string))) {
        return Err("This is not a Strata or PolyStrata run config: it needs an `args` list.".into());
    }
    if !v.get("exe").and_then(Value::as_str).is_some_and(|e| Path::new(e).is_file()) {
        return Err("The engine program this config names (`exe`) was not found.".into());
    }
    let stem: String = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
        .trim_end_matches(".config").chars().filter(|c| c.is_ascii_alphanumeric() || " -_.".contains(*c)).take(32).collect();
    let stem = if valid_name(&stem) { stem } else { "Model".into() };
    let dir = profiles_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = (1..100).map(|i| dir.join(if i == 1 { format!("{stem}.json") } else { format!("{stem} {i}.json") }))
        .find(|d| !d.exists()).ok_or("Too many profiles with that name.")?;
    std::fs::copy(&src, &dest).map_err(|e| format!("Could not copy: {e}"))?;
    Ok(dest.to_string_lossy().into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn names() {
        assert!(super::valid_name("Swift 32K"));
        assert!(!super::valid_name("..\\x"));
        assert!(!super::valid_name(".hidden"));
        assert!(!super::valid_name(""));
    }
}
