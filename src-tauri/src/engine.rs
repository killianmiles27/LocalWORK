//! Model library back end: installs and updates PolyStrata, lists its models, sets a model up, adds a GGUF the user
//! already has, inspects a Hugging Face model and tunes Qwen-engine configs. All blocking, so every command is
//! `#[tauri::command(async)]`. Every spawned program runs hidden, in the engine folder, with no stdin; its output is
//! streamed as `engine-log` {line} and appended to `<data>/logs/engine-setup.log`. `engine_cancel` stops it.
//! The engine zip uses `download::fetch` (host allowlist, `download-progress` events, id `engine-install`).
//! Model downloads are done by PolyStrata's own setup.py (through pip/Hugging Face), not by the app downloader.
use crate::sync::LockExt;
use crate::{download, http, paths, runconfig, setup, strata, supervisor};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, Emitter};

const REPO: &str = "VecSzn/PolyStrata";
const CANCELLED: &str = "Cancelled.";
const DL_ID: &str = "engine-install";
const HF_DL_ID: &str = "hf-model-download";
const POLY_EXE: &str = if cfg!(windows) { "strata-poly.exe" } else { "strata-poly" };

static PID: Mutex<Option<u32>> = Mutex::new(None);
static CANCEL: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);

/// One engine job at a time; dropping it frees the slot.
struct Busy;
impl Busy {
    fn take() -> Result<Busy, String> {
        if BUSY.swap(true, SeqCst) {
            return Err("Another model task is already running. Wait for it to finish or cancel it.".into());
        }
        CANCEL.store(false, SeqCst);
        Ok(Busy)
    }
}
impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, SeqCst);
    }
}

fn online() -> Result<(), String> {
    if setup::offline() { Err(setup::OFFLINE_MSG.into()) } else { Ok(()) }
}

fn root() -> PathBuf {
    PathBuf::from(strata::setting("strataRoot", &paths::default_strata_root()))
}
fn venv_py(root: &Path) -> PathBuf {
    paths::venv_python(root)
}
fn poly_marker(root: &Path) -> bool {
    root.join(".engine-tag").is_file() || root.join("polystrata.py").is_file()
}
fn python_for(engine_root: &Path) -> Option<PathBuf> {
    [venv_py(engine_root), venv_py(&root())].into_iter().find(|p| p.is_file()).or_else(find_python)
}
fn installed(root: &Path) -> bool {
    poly_marker(root) && root.join("setup.py").is_file() && root.join("serve").join("server.py").is_file()
        && python_for(root).is_some()
}
/// PolyStrata may be the configured root, or an engine_root/cwd used by the selected profile while
/// strataRoot still points at the user's ordinary Strata install.
fn poly_root() -> Option<PathBuf> {
    let base = root();
    if installed(&base) { return Some(base); }
    let config = strata::setting("modelConfig", "");
    if config.is_empty() { return None; }
    let engine = strata::server_root(&config, &base);
    (engine != base && installed(&engine)).then_some(engine)
}
fn need_installed() -> Result<PathBuf, String> {
    poly_root().ok_or_else(|| "PolyStrata is not installed or selected. Install it first.".into())
}
fn python_cmd(engine_root: &Path) -> Command {
    Command::new(python_for(engine_root).unwrap_or_else(|| venv_py(engine_root)))
}
fn tag_of(root: &Path) -> Option<String> {
    fs::read_to_string(root.join(".engine-tag")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
/// Calibration launches the configured engine itself; refuse if LocalWORK's model process is still alive,
/// and check the conventional standalone port for a server started outside this app.
fn model_is_running() -> bool {
    let pids = paths::data_dir().join("pids.json");
    if fs::read_to_string(pids).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_array().cloned()).into_iter().flatten().any(|v| {
            v["role"].as_str() == Some("strata") && v["pid"].as_u64().zip(v["exe"].as_str()).is_some_and(|(pid, exe)| {
                supervisor::image_path(pid as u32).is_some_and(|actual| supervisor::same_image(&actual, exe))
            })
        }) { return true; }
    let ports = [8080, strata::setting("serverPort", "8080").parse().unwrap_or(8080)];
    ports.into_iter().any(|port| {
        matches!(http::get(port, "/health", None, std::time::Duration::from_millis(250)), Some((200, _)))
            || matches!(http::get(port, "/v1/models", None, std::time::Duration::from_millis(250)), Some((200 | 401 | 403, _)))
    })
}
fn tok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-+".contains(c))
}

fn log(app: &AppHandle, line: &str) {
    let line: String = line.chars().take(2000).collect();
    let _ = app.emit("engine-log", json!({ "line": line }));
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(paths::data_dir().join("logs").join("engine-setup.log")) {
        let _ = writeln!(f, "{line}");
    }
}

/// Read a pipe and send each line (split on \n or \r, so progress bars stream too).
fn pump<R: Read + Send + 'static>(mut r: R, tx: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        let (mut buf, mut cur) = ([0u8; 4096], Vec::<u8>::new());
        loop {
            let n = match r.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => n };
            for &b in &buf[..n] {
                if b == b'\n' || b == b'\r' {
                    if !cur.is_empty() {
                        let _ = tx.send(String::from_utf8_lossy(&cur).into_owned());
                        cur.clear();
                    }
                } else {
                    cur.push(b);
                }
            }
        }
        if !cur.is_empty() {
            let _ = tx.send(String::from_utf8_lossy(&cur).into_owned());
        }
    });
}

/// Run a program to the end. Returns (exit code, captured output). `quiet` skips the live log.
fn run(app: &AppHandle, mut cmd: Command, quiet: bool) -> Result<(i32, String), String> {
    if CANCEL.load(SeqCst) {
        return Err(CANCELLED.into());
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    supervisor::hidden(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the program: {e}"))?;
    *PID.guard() = Some(child.id());
    let (tx, rx) = mpsc::channel::<String>();
    if let Some(o) = child.stdout.take() { pump(o, tx.clone()); }
    if let Some(o) = child.stderr.take() { pump(o, tx.clone()); }
    drop(tx);
    let mut all = String::new();
    for l in rx {
        if !quiet { log(app, &l); }
        if all.len() < (1 << 20) { all.push_str(&l); all.push('\n'); }
    }
    let st = child.wait().map_err(|e| e.to_string());
    *PID.guard() = None;
    if CANCEL.load(SeqCst) {
        return Err(CANCELLED.into());
    }
    Ok((st?.code().unwrap_or(-1), all))
}

fn tail(s: &str) -> String {
    let l: Vec<&str> = s.lines().rev().take(6).collect();
    l.into_iter().rev().collect::<Vec<_>>().join("\n")
}
fn must(r: (i32, String), what: &str) -> Result<String, String> {
    if r.0 == 0 { Ok(r.1) } else { Err(format!("{what} failed (exit {}).\n{}", r.0, tail(&r.1))) }
}
fn py(root: &Path, args: &[&str]) -> Command {
    let mut c = python_cmd(root);
    c.current_dir(root).args(args);
    c
}
fn marked(out: &str, marker: &str) -> Option<Value> {
    out.lines().find_map(|l| l.strip_prefix(marker)).and_then(|j| serde_json::from_str(j).ok())
}

fn find_python() -> Option<PathBuf> {
    let probe = |exe: &Path, pre: &[&str]| -> Option<PathBuf> {
        let mut c = Command::new(exe);
        c.args(pre).args(["-c", "import sys;assert sys.version_info>=(3,10);print(sys.executable)"])
            .stdin(Stdio::null()).stderr(Stdio::null());
        supervisor::hidden(&mut c);
        let o = c.output().ok().filter(|o| o.status.success())?;
        let p = PathBuf::from(String::from_utf8_lossy(&o.stdout).trim());
        p.is_file().then_some(p)
    };
    if let Some(p) = probe(Path::new("py"), &["-3"]).or_else(|| probe(Path::new("python3"), &[])).or_else(|| probe(Path::new("python"), &[])) {
        return Some(p);
    }
    let base = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Programs").join("Python");
    let mut dirs: Vec<PathBuf> = fs::read_dir(base).ok()?.flatten().map(|e| e.path()).collect();
    dirs.sort();
    dirs.reverse();
    dirs.iter().find_map(|d| probe(&d.join("python.exe"), &[]))
}

fn latest_tag() -> Result<String, String> {
    let v = download::json(&format!("https://api.github.com/repos/{REPO}/releases/latest"), None)?;
    v["tag_name"].as_str().filter(|t| tok(t)).map(String::from).ok_or_else(|| "GitHub gave no release tag.".to_string())
}

/// Unzip `zip` into `dest`, dropping the top folder; refuses paths that escape and absurd sizes.
fn unzip_strip(zip: &Path, dest: &Path) -> Result<(), String> {
    let mut z = zip::ZipArchive::new(File::open(zip).map_err(|e| e.to_string())?).map_err(|e| format!("Bad zip: {e}"))?;
    let (mut total, cap) = (0u64, 3u64 << 30);
    for i in 0..z.len() {
        let mut e = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = e.enclosed_name() else { continue };
        if e.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) { continue; }
        let mut comps = rel.components();
        comps.next();
        let rest: PathBuf = comps.collect();
        if rest.as_os_str().is_empty() { continue; }
        let out = dest.join(rest);
        if e.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        total += e.size();
        if total > cap { return Err("The engine archive is larger than expected; stopped.".into()); }
        if let Some(p) = out.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        let mut o = File::create(&out).map_err(|e| format!("{}: {e}", out.display()))?;
        std::io::copy(&mut (&mut e).take(cap), &mut o).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn configs(root: &Path) -> Vec<(PathBuf, Option<std::time::SystemTime>)> {
    fs::read_dir(root).into_iter().flatten().flatten().map(|e| e.path()).filter(|f| {
        let n = f.file_name().and_then(|n| n.to_str()).unwrap_or("");
        n.starts_with("strata-") && n.ends_with(".json") && n.matches('.').count() == 1
    }).map(|f| { let m = f.metadata().and_then(|m| m.modified()).ok(); (f, m) }).collect()
}

/// Import a config into the profiles folder unless an identical one is already there.
fn import_dedupe(src: &Path) -> Result<String, String> {
    let bytes = fs::read(src).map_err(|e| e.to_string())?;
    let dir = root().join("profiles");
    for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "json") && fs::read(&p).ok().is_some_and(|b| b == bytes) {
            return Ok(p.to_string_lossy().into());
        }
    }
    runconfig::import(&src.to_string_lossy())
}

fn rebase(v: &mut Value, old: &str, new: &str) {
    match v {
        Value::String(s) => {
            if s.get(..old.len()).is_some_and(|h| h.eq_ignore_ascii_case(old)) {
                *s = format!("{new}{}", &s[old.len()..]);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| rebase(x, old, new)),
        Value::Object(o) => o.values_mut().for_each(|x| rebase(x, old, new)),
        _ => {}
    }
}

const CHOICES_PY: &str = "import setup, json, pathlib\nr = []\nfor p in sorted(pathlib.Path('.').glob('strata-*.json')):\n    try:\n        c = setup.choices_from_config(p)\n        r.append({k: c.get(k) for k in ('family', 'model', 'context')})\n    except Exception:\n        pass\nprint('@@CH@@' + json.dumps(r))";

const CATALOG_PY: &str = "import setup, json\nS = (str, int, float, bool)\nfams = list(setup.FAMILIES.items()) + list(getattr(setup, 'OWN_PATH_FAMILIES', {}).items())\nout = []\nfor name, d in fams:\n    try:\n        ms = setup.family_models(name)\n    except Exception:\n        ms = d.get('models') or {}\n    items = list(ms.items()) if isinstance(ms, dict) else [(m, {}) for m in ms]\n    out.append({'id': name, 'poly': d.get('engine') == 'poly', 'preview': name in getattr(setup, 'PREVIEW_FAMILIES', ()), 'family': {k: v for k, v in d.items() if isinstance(v, S)}, 'models': [dict({k: v for k, v in (m if isinstance(m, dict) else {}).items() if isinstance(v, S)}, id=mid) for mid, m in items]})\nprint('@@CAT@@' + json.dumps(out, default=str))";

const LIBS_PY: &str = "import setup, json, pathlib\nprint('@@LIB@@' + json.dumps([str(x) for x in setup.engine_lib_dirs(pathlib.Path('engine-poly').resolve())]))";

#[tauri::command(async)]
pub fn engine_status(check: Option<bool>) -> Value {
    let configured = root();
    let poly = poly_root();
    let ok = poly.is_some();
    let r = poly.as_deref().unwrap_or(&configured);
    let latest = if check.unwrap_or(false) && !setup::offline() { latest_tag().ok() } else { None };
    let engine = if ok { "PolyStrata" } else { setup::engine(&configured) };
    json!({ "installed": ok, "root": r.to_string_lossy(), "engine": engine, "version": tag_of(r),
            "python_ok": find_python().is_some(), "latest_tag": latest, "offline": setup::offline() })
}

#[tauri::command(async)]
pub fn engine_hw() -> Value {
    setup::hardware_check()
}

#[tauri::command(async)]
pub fn engine_cancel() {
    CANCEL.store(true, SeqCst);
    download::cancel(DL_ID);
    download::cancel(HF_DL_ID);
    if let Some(p) = *PID.guard() {
        supervisor::kill_tree(p);
    }
}

#[derive(Clone, Debug)]
struct HfFile {
    path: String,
    size: Option<u64>,
}

fn valid_hf_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let valid = |s: &str| !s.is_empty() && s.len() <= 96
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        && s != "." && s != "..";
    parts.next().is_some_and(valid) && parts.next().is_some_and(valid) && parts.next().is_none()
}

fn valid_hf_revision(revision: &str) -> bool {
    revision.len() == 40 && revision.chars().all(|c| c.is_ascii_hexdigit())
}

/// Accept repository-relative paths but reject traversal, Windows drive syntax, and invalid Windows filename chars.
fn valid_hf_path(path: &str) -> bool {
    !path.is_empty() && !path.starts_with('/') && !path.contains('\\')
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != ".."
            && !part.ends_with('.') && !part.ends_with(' ')
            && !part.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c)))
}

fn hf_files_from_info(info: &Value) -> Result<(String, Vec<HfFile>), String> {
    let revision = info["sha"].as_str().filter(|s| valid_hf_revision(s))
        .ok_or("Hugging Face did not return a valid pinned revision.")?.to_ascii_lowercase();
    let siblings = info["siblings"].as_array().ok_or("Hugging Face returned no file list.")?;
    let files = siblings.iter().filter_map(|s| {
        let path = s["rfilename"].as_str()?;
        if !valid_hf_path(path) || !path.to_ascii_lowercase().ends_with(".gguf") { return None; }
        let size = s["size"].as_u64().or_else(|| s["lfs"]["size"].as_u64());
        Some(HfFile { path: path.to_string(), size })
    }).collect();
    Ok((revision, files))
}

/// GGUF split convention: `<prefix>-00001-of-00003.gguf`.
fn shard_parts(path: &str) -> Option<(String, u32, u32, String)> {
    let (stem, ext) = path.rsplit_once('.')?;
    if !ext.eq_ignore_ascii_case("gguf") { return None; }
    let mut tail = stem.rsplitn(4, '-');
    let count = tail.next()?;
    let of = tail.next()?;
    let index = tail.next()?;
    let prefix = tail.next()?;
    if of != "of" || prefix.is_empty() || index.len() != 5 || count.len() != 5
        || !index.chars().all(|c| c.is_ascii_digit()) || !count.chars().all(|c| c.is_ascii_digit()) { return None; }
    let (index, count) = (index.parse().ok()?, count.parse().ok()?);
    (index > 0 && count > 0 && index <= count).then(|| (prefix.to_string(), index, count, format!(".{ext}")))
}

fn hf_download_set(files: &[HfFile], selected: &str) -> Result<Vec<HfFile>, String> {
    if !valid_hf_path(selected) { return Err("Invalid Hugging Face file path.".into()); }
    let get = |path: &str| files.iter().find(|f| f.path == path).cloned();
    let Some(file) = get(selected) else { return Err("That file is not in the selected Hugging Face revision.".into()) };
    let Some((prefix, index, count, ext)) = shard_parts(selected) else { return Ok(vec![file]); };
    if index != 1 {
        return Err("Select the first shard; LocalWORK downloads all numbered shards together.".into());
    }
    (1..=count).map(|i| {
        let path = format!("{prefix}-{i:05}-of-{count:05}{ext}");
        get(&path).ok_or_else(|| format!("The model is missing shard {i:05} of {count:05} in this revision."))
    }).collect()
}

/// Look up GGUF files and their sizes at one immutable Hugging Face revision. This lists files only; it downloads no model data.
#[tauri::command(async)]
pub fn engine_hf_files(repo: String) -> Result<Value, String> {
    online()?;
    if !valid_hf_repo(&repo) { return Err("Use a Hugging Face repository in owner/name form.".into()); }
    let _busy = Busy::take()?;
    let info = download::json(&format!("https://huggingface.co/api/models/{repo}?blobs=true"), None)?;
    let (revision, files) = hf_files_from_info(&info)?;
    let listed: Vec<Value> = files.iter().filter(|f| shard_parts(&f.path).is_none_or(|(_, index, _, _)| index == 1)).filter_map(|file| {
        let group = hf_download_set(&files, &file.path).ok()?;
        let total = group.iter().try_fold(0u64, |sum, f| sum.checked_add(f.size?));
        Some(json!({ "file": file.path, "size": file.size, "download_files": group.iter().map(|f| json!({"file": f.path, "size": f.size})).collect::<Vec<_>>(), "total_bytes": total }))
    }).collect();
    Ok(json!({ "repo": repo, "revision": revision, "files": listed }))
}

/// Download a selected GGUF (or its complete shard set) after rechecking it against the pinned repository revision.
#[tauri::command(async)]
pub fn engine_hf_download(app: AppHandle, repo: String, revision: String, file: String, destination: String) -> Result<Value, String> {
    online()?;
    if !valid_hf_repo(&repo) { return Err("Use a Hugging Face repository in owner/name form.".into()); }
    if !valid_hf_revision(&revision) { return Err("Invalid Hugging Face revision.".into()); }
    if !valid_hf_path(&file) { return Err("Invalid Hugging Face file path.".into()); }
    let dest = PathBuf::from(destination);
    if !dest.is_absolute() { return Err("Choose a full destination folder path.".into()); }
    let _busy = Busy::take()?;
    let info = download::json(&format!("https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true"), None)?;
    let (actual_revision, files) = hf_files_from_info(&info)?;
    if actual_revision != revision.to_ascii_lowercase() { return Err("The Hugging Face revision changed. List the files again before downloading.".into()); }
    let selected = hf_download_set(&files, &file)?;
    let mut url = reqwest::Url::parse("https://huggingface.co/").map_err(|e| e.to_string())?;
    {
        let mut segments = url.path_segments_mut().map_err(|_| "Could not build the Hugging Face download URL.")?;
        for part in repo.split('/').chain(["resolve", &actual_revision]).chain(file.split('/')) { segments.push(part); }
    }
    // Keep repos and pinned revisions separate so same-named files from different sources cannot overwrite each other.
    let mut folder = dest;
    for part in repo.split('/') { folder.push(part); }
    folder.push(&actual_revision);
    let mut paths = Vec::with_capacity(selected.len());
    for (index, item) in selected.iter().enumerate() {
        if CANCEL.load(SeqCst) { return Err(CANCELLED.into()); }
        let target = folder.join(&item.path);
        if let Some(size) = item.size {
            if fs::metadata(&target).ok().is_some_and(|m| m.len() == size) {
                paths.push(target.to_string_lossy().to_string());
                continue;
            }
        }
        if target.exists() { return Err(format!("{} already exists with a different size; it was left untouched.", target.display())); }
        log(&app, &format!("Downloading GGUF file {} of {}: {}", index + 1, selected.len(), item.path));
        let mut file_url = url.clone();
        // Replace the last file path by the current shard while keeping the pinned repository revision.
        let mut segments = file_url.path_segments_mut().map_err(|_| "Could not build the Hugging Face download URL.")?;
        segments.pop_if_empty();
        for _ in file.split('/') { segments.pop(); }
        for part in item.path.split('/') { segments.push(part); }
        drop(segments);
        download::fetch(&app, HF_DL_ID, file_url.as_str(), &target, None)?;
        paths.push(target.to_string_lossy().to_string());
    }
    Ok(json!({ "files": paths, "folder": folder.to_string_lossy(), "total_bytes": selected.iter().try_fold(0u64, |sum, f| sum.checked_add(f.size?)) }))
}

/// Install the latest PolyStrata, or update: a newer tag goes into a fresh `PolyStrata-<tag>` folder, the models
/// are set up again there, and the app switches to it only when that worked. The old folder is kept.
#[tauri::command(async)]
pub fn engine_install(app: AppHandle, dir: Option<String>, install_python: Option<bool>) -> Result<Value, String> {
    online()?;
    let _busy = Busy::take()?;
    let tag = latest_tag()?;
    let old = poly_root().unwrap_or_else(root);
    let old_ok = installed(&old);
    let mut target = match dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => paths::data_dir().join("PolyStrata"),
    };
    if !target.is_absolute() { return Err("Choose a full folder path.".into()); }
    if installed(&target) {
        if tag_of(&target).as_deref() == Some(tag.as_str()) {
            return Err(format!("PolyStrata {tag} is already installed there."));
        }
        let name = format!("PolyStrata-{tag}");
        target = target.parent().map(|p| p.join(&name)).unwrap_or_else(|| paths::data_dir().join(name));
    }
    let partial = target.join(".localwork-partial");
    if target.exists() {
        if partial.is_file() { let _ = fs::remove_dir_all(&target); }
        else if fs::read_dir(&target).map(|mut d| d.next().is_some()).unwrap_or(false) {
            return Err(format!("{} is not empty. Pick an empty folder.", target.display()));
        }
    }
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let _ = fs::write(&partial, "");
    let result = (|| -> Result<(), String> {
        log(&app, &format!("Downloading PolyStrata {tag}..."));
        let zip = paths::data_dir().join("downloads").join(format!("PolyStrata-{tag}.zip"));
        download::fetch(&app, DL_ID, &format!("https://codeload.github.com/{REPO}/zip/refs/tags/{tag}"), &zip, None)?;
        log(&app, "Unpacking...");
        unzip_strip(&zip, &target)?;
        let _ = fs::remove_file(&zip);
        if !target.join("setup.py").is_file() { return Err("The download did not contain setup.py.".into()); }
        let mut python = find_python();
        if python.is_none() && install_python.unwrap_or(false) {
            log(&app, "Installing Python 3.12 for this user with winget...");
            let mut c = Command::new("winget");
            c.args(["install", "--id", "Python.Python.3.12", "--scope", "user", "--silent", "--accept-package-agreements", "--accept-source-agreements"]);
            must(run(&app, c, false)?, "Installing Python")?;
            python = find_python();
        }
        let python = python.ok_or("Python 3.10 or newer was not found. Install Python 3.12 (python.org) and try again.")?;
        log(&app, "Creating the Python environment...");
        let mut c = Command::new(&python);
        c.current_dir(&target).args(["-m", "venv", ".venv"]);
        must(run(&app, c, false)?, "Creating the environment")?;
        if target.join("requirements.txt").is_file() {
            log(&app, "Installing Python packages (from PyPI)...");
            must(run(&app, py(&target, &["-m", "pip", "install", "--disable-pip-version-check", "-r", "requirements.txt"]), false)?, "Installing packages")?;
        }
        fs::write(target.join(".engine-tag"), &tag).map_err(|e| e.to_string())
    })();
    if let Err(e) = result {
        if e == CANCELLED { let _ = fs::remove_dir_all(&target); }
        return Err(e);
    }
    let _ = fs::remove_file(&partial);
    let mut migrated = 0;
    if old_ok && old != target {
        log(&app, "Setting your models up again in the new version...");
        let choices = run(&app, py(&old, &["-c", CHOICES_PY]), true).ok().and_then(|r| marked(&r.1, "@@CH@@"));
        for c in choices.as_ref().and_then(Value::as_array).into_iter().flatten() {
            let (Some(f), Some(m)) = (c["family"].as_str(), c["model"].as_str()) else { continue };
            if !(tok(f) && tok(m)) { continue; }
            let mut args = vec!["setup.py", "--yes", "--family", f, "--model", m, "--no-start"];
            let ctx = c["context"].as_u64().map(|n| n.to_string());
            if let Some(n) = &ctx { args.extend(["--context", n]); }
            match run(&app, py(&target, &args), false) {
                Ok((0, _)) => migrated += 1,
                Err(e) if e == CANCELLED => return Err(e),
                _ => log(&app, &format!("Could not set up {f}/{m} again; add it from the library.")),
            }
        }
    }
    setup::set_strata_root(target.to_string_lossy().into())?;
    if old_ok && old != target {
        let (o, n) = (old.to_string_lossy().to_string(), target.to_string_lossy().to_string());
        let dest_dir = target.join("profiles");
        let _ = fs::create_dir_all(&dest_dir);
        for e in fs::read_dir(old.join("profiles")).into_iter().flatten().flatten() {
            let (p, d) = (e.path(), dest_dir.join(e.file_name()));
            if p.extension().is_some_and(|x| x == "json") && !d.exists() {
                if let Some(mut v) = fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                    rebase(&mut v, &o, &n);
                    let _ = fs::write(&d, serde_json::to_string_pretty(&v).unwrap_or_default());
                }
            }
        }
        let cur = strata::setting("modelConfig", "");
        if cur.to_lowercase().starts_with(&o.to_lowercase()) {
            let moved = format!("{n}{}", &cur[o.len()..]);
            if Path::new(&moved).is_file() { let _ = setup::set_model_config(moved); }
        }
    }
    log(&app, &format!("PolyStrata {tag} is ready."));
    Ok(json!({ "root": target.to_string_lossy(), "tag": tag, "migrated": migrated,
               "old_root": if old_ok && old != target { Some(old.to_string_lossy().to_string()) } else { None } }))
}

/// Families and models from the installed engine. `installed: false` means the UI should use its static list.
#[tauri::command(async)]
pub fn engine_catalog(app: AppHandle) -> Result<Value, String> {
    let Some(r) = poly_root() else { return Ok(json!({ "installed": false, "families": [] })) };
    let Ok(_busy) = Busy::take() else { return Ok(json!({ "installed": true, "families": [], "busy": true })) };
    let out = must(run(&app, py(&r, &["-c", CATALOG_PY]), true)?, "Reading the model list")?;
    let fams = marked(&out, "@@CAT@@").ok_or("The engine returned no model list.")?;
    Ok(json!({ "installed": true, "families": fams }))
}

/// Set a model up with PolyStrata's setup (downloads it), then add its config to the model menu and make it current.
#[tauri::command(async)]
pub fn engine_add_model(app: AppHandle, family: String, model: String, context: Option<u64>, data_dir: Option<String>) -> Result<Value, String> {
    online()?;
    if !tok(&family) || !tok(&model) { return Err("Unknown model name.".into()); }
    let r = need_installed()?;
    let _busy = Busy::take()?;
    let before = configs(&r);
    let mut args: Vec<String> = ["setup.py", "--yes", "--family", &family, "--model", &model, "--no-start"].map(String::from).to_vec();
    if let Some(c) = context { args.extend(["--context".into(), c.to_string()]); }
    if let Some(d) = data_dir.filter(|d| !d.trim().is_empty()) { args.extend(["--data-dir".into(), d]); }
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    must(run(&app, py(&r, &a), false)?, "Setting the model up")?;
    let changed: Vec<PathBuf> = configs(&r).into_iter()
        .filter(|(p, m)| !before.iter().any(|(bp, bm)| bp == p && bm == m)).map(|(p, _)| p).collect();
    if changed.is_empty() { return Err("Setup finished but wrote no run config. See the log.".into()); }
    let mut dests = vec![];
    for c in &changed { dests.push(import_dedupe(c)?); }
    let active = dests.last().cloned().unwrap_or_default();
    setup::set_model_config(active.clone())?;
    log(&app, "Model added.");
    Ok(json!({ "configs": dests, "active": active }))
}

/// Use a GGUF already on this PC with the poly engine. Returns {path, name, verdict}.
#[tauri::command(async)]
pub fn engine_add_gguf(app: AppHandle, gguf_path: String, context: Option<u64>) -> Result<Value, String> {
    let r = need_installed()?;
    let _busy = Busy::take()?;
    let gguf = PathBuf::from(&gguf_path);
    if !gguf.is_file() || !gguf.extension().is_some_and(|x| x.eq_ignore_ascii_case("gguf")) {
        return Err("Choose a .gguf file.".into());
    }
    let poly = r.join("engine-poly").join(POLY_EXE);
    if !poly.is_file() { return Err("The poly engine is not built yet. Set up one model from the library first.".into()); }
    let stem = gguf.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let name: String = stem.chars().filter(|c| c.is_ascii_alphanumeric() || " -_.".contains(*c)).take(40).collect::<String>().trim().to_string();
    if name.is_empty() || name.starts_with('.') { return Err("Could not make a name from that file name.".into()); }
    let dest = r.join("profiles").join(format!("{name}.json"));
    if dest.exists() { return Err(format!("A profile named {name} already exists.")); }
    log(&app, "Reading the GGUF...");
    let verdict = run(&app, py(&r, &["tools/strata_inspect.py", &gguf_path]), false).map(|x| x.1)?;
    let tokdir = paths::data_dir().join("models").join(&name).join("tokenizer");
    fs::create_dir_all(&tokdir).map_err(|e| e.to_string())?;
    log(&app, "Building the tokenizer...");
    must(run(&app, py(&r, &["tools/strata_tokenizer.py", "--gguf", &gguf_path, "--out", &tokdir.to_string_lossy()]), false)?, "Building the tokenizer")?;
    let lib_dirs = configs(&r).iter().find_map(|(p, _)| {
        let v: Value = serde_json::from_str(&fs::read_to_string(p).ok()?).ok()?;
        v["exe"].as_str()?.to_lowercase().contains("poly").then(|| v["lib_dirs"].clone()).filter(Value::is_array)
    }).or_else(|| run(&app, py(&r, &["-c", LIBS_PY]), true).ok().and_then(|x| marked(&x.1, "@@LIB@@"))).unwrap_or(json!([]));
    let ctx = context.unwrap_or(32768);
    let cfg = json!({
        "exe": poly.to_string_lossy(), "args": ["--model", gguf_path, "--max-context", ctx.to_string()],
        "cwd": r.to_string_lossy(), "tokenizer": tokdir.to_string_lossy(), "model_name": name, "display_name": name,
        "log": paths::data_dir().join("logs").join(format!("{name}.engine.log")).to_string_lossy(), "lib_dirs": lib_dirs });
    fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&dest, serde_json::to_string_pretty(&cfg).unwrap_or_default()).map_err(|e| e.to_string())?;
    setup::set_model_config(dest.to_string_lossy().into())?;
    log(&app, "GGUF added.");
    Ok(json!({ "path": dest.to_string_lossy(), "name": name, "verdict": verdict.trim() }))
}

/// Ask the engine's inspector whether a Hugging Face repo's GGUF would run. Returns {code, output}.
#[tauri::command(async)]
pub fn engine_inspect_hf(app: AppHandle, repo: String, variant: Option<String>) -> Result<Value, String> {
    online()?;
    let ok = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    let valid = repo.split_once('/').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && ok(a) && ok(b) && !b.contains('/'));
    if !valid { return Err("Use the form owner/repository, for example unsloth/Qwen3-8B-GGUF.".into()); }
    let v = variant.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if v.as_deref().is_some_and(|v| !v.chars().all(|c| c.is_ascii_alphanumeric() || "._-*".contains(c))) {
        return Err("That variant name has characters that are not allowed.".into());
    }
    let r = need_installed()?;
    let _busy = Busy::take()?;
    let src = format!("hf:{repo}");
    let mut args = vec!["tools/strata_inspect.py", src.as_str()];
    if let Some(v) = &v { args.push(v); }
    let (code, out) = run(&app, py(&r, &args), true)?;
    Ok(json!({ "code": code, "output": out.trim() }))
}

/// Calibrate a supported config for this PC. setup.calibrate_config writes the selected settings into the
/// config; tools/calibrate.py by itself only prints measurements and does not save them.
#[tauri::command(async)]
pub fn engine_tune(app: AppHandle, config: String) -> Result<Value, String> {
    runconfig::read(&config)?;
    if model_is_running() {
        return Err("Stop the running model before tuning. Calibration starts the engine for its measurements.".into());
    }
    let _busy = Busy::take()?;
    let base = root();
    let r = strata::server_root(&config, &base);
    if !r.join("setup.py").is_file() {
        return Err("This model's engine folder does not include setup.py, so LocalWORK cannot calibrate it.".into());
    }
    log(&app, "Tuning for this PC. Close other GPU programs; this can take a while...");
    let script = "import sys; from pathlib import Path; import setup; sys.exit(0 if setup.calibrate_config(Path(sys.argv[1])) else 2)";
    must(run(&app, py(&r, &["-c", script, &config]), false)?, "Tuning")?;
    Ok(json!({ "tuned": true, "message": "Tuning finished and saved. Restart the model to use the new settings." }))
}

#[cfg(test)]
mod hf_tests {
    use super::*;

    #[test]
    fn hf_repo_revision_and_paths_are_bounded() {
        assert!(valid_hf_repo("owner/model.name-1"));
        assert!(!valid_hf_repo("owner/model/subdir"));
        assert!(!valid_hf_repo("../model"));
        assert!(valid_hf_revision("0123456789abcdef0123456789abcdef01234567"));
        assert!(!valid_hf_revision("main"));
        assert!(valid_hf_path("nested/model file.gguf"));
        assert!(!valid_hf_path("../outside.gguf"));
        assert!(!valid_hf_path("nested\\outside.gguf"));
        assert!(!valid_hf_path("C:/outside.gguf"));
    }

    #[test]
    fn selecting_first_shard_requires_and_returns_the_complete_numbered_group() {
        let files = [1, 2, 3].map(|i| HfFile {
            path: format!("nested/model-{i:05}-of-00003.gguf"),
            size: Some(10),
        });
        let group = hf_download_set(&files, "nested/model-00001-of-00003.gguf").unwrap();
        assert_eq!(group.len(), 3);
        assert_eq!(group[2].path, "nested/model-00003-of-00003.gguf");
        assert!(hf_download_set(&files[..2], "nested/model-00001-of-00003.gguf").is_err());
        assert!(hf_download_set(&files, "nested/model-00002-of-00003.gguf").is_err());
    }
}
