//! Workspace deliverables and immutable, local revision snapshots.
use crate::sync::LockExt;
use crate::{paths, store, supervisor, App};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;

const MAX_PREVIEW: u64 = 8 * 1024 * 1024;
static REVISION_LOCK: Mutex<()> = Mutex::new(());

fn valid_revision(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit())
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = vec![];
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("Document exceeds the size limit".into());
    }
    Ok(bytes)
}

fn kind(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "docx" | "xlsx" | "pptx" | "pdf" | "md" | "txt" | "csv" | "html" | "json"
    )
    .then_some(ext)
}

// Old agent versions left these OfficeCLI implementation files beside deliverables.
// Keep user JSON documents visible, and never delete files based only on their name.
fn is_build_scratch(path: &Path) -> bool {
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
    name.starts_with('.') && name.ends_with(".build.json")
}

pub fn resolve_file(workspace: &Path, path: &str) -> Result<PathBuf, String> {
    let root = workspace
        .canonicalize()
        .map_err(|e| format!("Workspace: {e}"))?;
    let requested = Path::new(path);
    // Reject NTFS alternate data streams, including streams on directories.
    if requested.components().any(|part| match part {
        std::path::Component::Normal(name) => name.to_string_lossy().contains(':'),
        _ => false,
    }) {
        return Err("Alternate data streams are not documents".into());
    }
    let file = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let file = file.canonicalize().map_err(|e| format!("Document: {e}"))?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err("Document must be a regular file inside this workspace".into());
    }
    Ok(file)
}

fn workspace(s: &State<'_, App>, id: &str) -> Result<PathBuf, String> {
    let db = s.db.guard();
    store::conv_info(&db, id)
        .map(|x| PathBuf::from(x.1))
        .ok_or_else(|| "Unknown chat".into())
}

fn hash(value: &str) -> String {
    // Stable directory key across app/compiler upgrades. Source metadata also binds each
    // record to its canonical path, so a hash collision cannot expose another file's history.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[derive(Serialize, Deserialize)]
struct Revision {
    id: String,
    created: u64,
    size: u64,
    source: String,
}

fn revision_dir(data: &Path, file: &Path) -> PathBuf {
    data.join("document-revisions")
        .join(hash(&file.to_string_lossy()))
}

fn records(data: &Path, file: &Path) -> Result<Vec<Revision>, String> {
    let dir = revision_dir(data, file);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let record: Revision =
            serde_json::from_slice(&fs::read(entry.path()).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if record.source == file.to_string_lossy() && valid_revision(&record.id) {
            out.push(record);
        }
    }
    out.sort_by(|a, b| b.created.cmp(&a.created).then(b.id.cmp(&a.id)));
    Ok(out)
}

fn snapshot_at(data: &Path, workspace: &Path, path: &str) -> Result<(), String> {
    if kind(Path::new(path)).is_none() {
        return Ok(());
    }
    let candidate = workspace.join(path);
    match fs::metadata(&candidate) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
        Ok(meta) if meta.len() > 32 * 1024 * 1024 => {
            return Err("Document exceeds the 32 MB revision limit".into())
        }
        Ok(_) => {}
    }
    let file = resolve_file(workspace, path)?;
    let _guard = REVISION_LOCK.guard();
    let bytes = read_bounded(&file, 32 * 1024 * 1024)?;
    let dir = revision_dir(data, &file);
    for record in records(data, &file)? {
        if record.size == bytes.len() as u64
            && read_bounded(&dir.join(&record.id), 32 * 1024 * 1024)? == bytes
        {
            return Ok(());
        }
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let id = format!("{:016x}{:016x}", created, rand::random::<u64>());
    let record = Revision {
        id: id.clone(),
        created,
        size: bytes.len() as u64,
        source: file.to_string_lossy().into_owned(),
    };
    fs::write(dir.join(&id), bytes).map_err(|e| e.to_string())?;
    fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_vec(&record).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn snapshot(workspace: &Path, path: &str) -> Result<(), String> {
    snapshot_at(&paths::data_dir(), workspace, path)
}

fn revision_file(data: &Path, file: &Path, revision: &str) -> Result<PathBuf, String> {
    if !valid_revision(revision) {
        return Err("Invalid revision ID".into());
    }
    if !records(data, file)?.iter().any(|r| r.id == revision) {
        return Err("Revision not found for this document".into());
    }
    Ok(revision_dir(data, file).join(revision))
}

#[tauri::command]
pub async fn documents_list(s: State<'_, App>, id: String) -> Result<Value, String> {
    let root = workspace(&s, &id)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut pending = vec![(root.clone(), 0)];
        let mut out = vec![];
        let mut visited = 0;
        while let Some((dir, depth)) = pending.pop() {
            for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
                visited += 1;
                if visited > 20000 { return Err("Workspace too large to list; use a smaller project folder".to_string()); }
                let entry = entry.map_err(|e| e.to_string())?;
                let ty = entry.file_type().map_err(|e| e.to_string())?;
                let path = entry.path();
                if ty.is_symlink() || is_reparse_point(&entry)? { continue; }
                if !path.canonicalize().map_err(|e| e.to_string())?.starts_with(&root) { continue; }
                if ty.is_dir() {
                    let name = entry.file_name();
                    if depth < 4 && !name.to_string_lossy().starts_with('.') && !matches!(name.to_str(), Some("node_modules" | "target" | "vendor")) { pending.push((path, depth + 1)); }
                } else if ty.is_file() {
                    if is_build_scratch(&path) { continue; }
                    if let Some(kind) = kind(&path) {
                        if !path.canonicalize().map_err(|e| e.to_string())?.starts_with(&root) { continue; }
                        let meta = entry.metadata().map_err(|e| e.to_string())?;
                        out.push(json!({"path":path.strip_prefix(&root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/"),"name":entry.file_name().to_string_lossy(),"kind":kind,"size":meta.len(),"modified":meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_millis() as u64)}));
                    }
                }
            }
        }
        out.sort_by(|a,b| a["path"].as_str().cmp(&b["path"].as_str()));
        out.truncate(300);
        Ok(json!(out))
    }).await.map_err(|e| e.to_string())?
}

fn drain(mut stream: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut exceeded = false;
    loop {
        let n = stream.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if bytes.len() + n <= MAX_PREVIEW as usize {
            bytes.extend_from_slice(&buffer[..n]);
        } else {
            exceeded = true;
        }
    }
    if exceeded {
        Err("Preview output exceeds 8 MB".into())
    } else {
        Ok(bytes)
    }
}

fn office_preview(file: &Path) -> Result<String, String> {
    // Use the same path spelling as the agent's OfficeCLI calls, otherwise its resident
    // document server may be missed and a second process hits the open file's lock.
    let path = native_path(file);
    office_output(&[
        std::ffi::OsStr::new("view"),
        std::ffi::OsStr::new(&path),
        std::ffi::OsStr::new("html"),
    ])
}

pub(crate) fn native_path(file: &Path) -> String {
    let canonical = file.to_string_lossy();
    if let Some(unc) = canonical.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        canonical
            .strip_prefix(r"\\?\")
            .unwrap_or(&canonical)
            .to_string()
    }
}

fn office_output(args: &[&std::ffi::OsStr]) -> Result<String, String> {
    let mut command = Command::new(paths::vendor_dir().join(paths::exe("officecli")));
    command
        .env("OFFICECLI_SKIP_UPDATE", "1")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = supervisor::hidden(&mut command)
        .spawn()
        .map_err(|e| format!("Cannot start OfficeCLI: {e}"))?;
    let stdout = child.stdout.take().ok_or("Preview output unavailable")?;
    let stderr = child.stderr.take().ok_or("Preview errors unavailable")?;
    let (output_tx, output) = std::sync::mpsc::channel();
    let (errors_tx, errors) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = output_tx.send(drain(stdout));
    });
    std::thread::spawn(move || {
        let _ = errors_tx.send(drain(stderr));
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if start.elapsed() < Duration::from_secs(45) => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Ok(None) => {
                supervisor::kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                break Err("Document preview timed out after 45 seconds".to_string());
            }
            Err(e) => {
                supervisor::kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                break Err(e.to_string());
            }
        }
    };
    let status = status?;
    // A subprocess may inherit a pipe after the exporter exits. Bound pipe waits too.
    let stdout = output.recv_timeout(Duration::from_secs(45).saturating_sub(start.elapsed()));
    let stderr = errors.recv_timeout(Duration::from_secs(45).saturating_sub(start.elapsed()));
    let (stdout, stderr) = match (stdout, stderr) {
        (Ok(out), Ok(err)) => (out, err),
        _ => {
            supervisor::kill_tree(child.id());
            return Err("Preview output timed out".into());
        }
    };
    if !status.success() {
        return Err(format!(
            "OfficeCLI preview failed: {}",
            String::from_utf8_lossy(&stderr.unwrap_or_default())
        ));
    }
    String::from_utf8(stdout?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn document_preview(
    s: State<'_, App>,
    id: String,
    path: String,
    revision: Option<String>,
) -> Result<Value, String> {
    let root = workspace(&s, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let original = resolve_file(&root, &path)?;
        let kind = kind(&original).ok_or("Unsupported document type")?;
        let source = match revision {
            Some(id) => revision_file(&paths::data_dir(), &original, &id)?,
            None => original.clone(),
        };
        if fs::metadata(&source).map_err(|e| e.to_string())?.len() > MAX_PREVIEW {
            return Err("Document too large for inline preview (8 MB limit)".into());
        }
        let (preview_kind, content) = if matches!(kind.as_str(), "docx" | "xlsx" | "pptx") {
            // OfficeCLI determines the format from the extension. Revision bytes keep an immutable master.
            let temporary = if source != original {
                let temp = paths::data_dir()
                    .join("cache")
                    .join(format!("preview-{:016x}.{kind}", rand::random::<u64>()));
                fs::create_dir_all(temp.parent().ok_or("Invalid cache directory")?)
                    .map_err(|e| e.to_string())?;
                fs::copy(&source, &temp).map_err(|e| e.to_string())?;
                Some(temp)
            } else {
                None
            };
            let result = office_preview(temporary.as_deref().unwrap_or(&source));
            if let Some(temp) = temporary {
                let _ = fs::remove_file(temp);
            }
            ("html", result?)
        } else if kind == "pdf" {
            // The pane shows the bytes in the WebView's built-in PDF viewer through a blob URL.
            use base64::Engine;
            let bytes = read_bounded(&source, MAX_PREVIEW)?;
            if !bytes.starts_with(b"%PDF-") {
                return Err("This file does not look like a PDF".into());
            }
            ("pdf", base64::engine::general_purpose::STANDARD.encode(bytes))
        } else {
            (
                if kind == "html" { "html" } else { "text" },
                String::from_utf8(read_bounded(&source, MAX_PREVIEW)?)
                    .map_err(|e| e.to_string())?,
            )
        };
        Ok(json!({"kind":kind,"format":preview_kind,"content":content,"path":path}))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub fn document_revisions(s: State<'_, App>, id: String, path: String) -> Result<Value, String> {
    let file = resolve_file(&workspace(&s, &id)?, &path)?;
    Ok(json!(records(&paths::data_dir(), &file)?
        .into_iter()
        .map(|r| json!({"id":r.id,"created":r.created,"size":r.size}))
        .collect::<Vec<_>>()))
}

#[tauri::command(async)]
pub fn document_open(
    s: State<'_, App>,
    id: String,
    path: String,
    reveal: bool,
) -> Result<(), String> {
    let file = resolve_file(&workspace(&s, &id)?, &path)?;
    let kind = kind(&file).ok_or("Unsupported document type")?;
    // Explorer does not consistently accept canonicalize()'s extended-length prefix.
    let explorer_path = native_path(&file);
    let select = reveal || !matches!(kind.as_str(), "docx" | "xlsx" | "pptx" | "pdf");
    let mut command = if cfg!(windows) { Command::new("explorer.exe") } else { Command::new("xdg-open") };
    if cfg!(not(windows)) {
        // xdg-open cannot select a file; reveal opens the containing folder instead.
        command.arg(if select { file.parent().unwrap_or(&file) } else { file.as_path() });
    } else if select {
        command.arg("/select,").arg(&explorer_path);
    } else {
        command.arg(&explorer_path);
    }
    supervisor::hidden(&mut command)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn document_export(
    s: State<'_, App>,
    id: String,
    path: String,
    destination: String,
    revision: Option<String>,
) -> Result<(), String> {
    let original = resolve_file(&workspace(&s, &id)?, &path)?;
    let destination = PathBuf::from(destination);
    if !destination.is_absolute()
        || kind(&original).is_none()
        || original.extension().map(|e| e.to_ascii_lowercase())
            != destination.extension().map(|e| e.to_ascii_lowercase())
    {
        return Err("Choose an absolute destination with the same document extension".into());
    }
    let source = match revision {
        Some(id) => revision_file(&paths::data_dir(), &original, &id)?,
        None => original,
    };
    let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|e| format!("Choose a new filename: {e}"))?;
    if let Err(error) = std::io::copy(&mut input, &mut output) {
        drop(output);
        let _ = fs::remove_file(destination);
        return Err(error.to_string());
    }
    Ok(())
}

/// Only invoked by the user's Save copy dialog, never exposed as an agent tool.
#[tauri::command(async)]
pub fn document_save_visual(destination: String, html: String) -> Result<(), String> {
    use std::io::Write;
    let destination = PathBuf::from(destination);
    if !destination.is_absolute()
        || destination
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| !e.eq_ignore_ascii_case("html"))
            .unwrap_or(true)
    {
        return Err("Choose an absolute destination ending in .html".into());
    }
    if html.len() > MAX_PREVIEW as usize {
        return Err("Visual exceeds the 8 MB save limit".into());
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|e| format!("Choose a new filename: {e}"))?;
    if let Err(error) = file.write_all(html.as_bytes()) {
        drop(file);
        let _ = fs::remove_file(destination);
        return Err(error.to_string());
    }
    Ok(())
}

/// Saves the user's own edit to a text document. Refuses when the file changed since the user
/// started editing (usually the assistant), so neither side silently overwrites the other.
#[tauri::command(async)]
pub fn document_save(
    s: State<'_, App>,
    id: String,
    path: String,
    content: String,
    expected: String,
) -> Result<(), String> {
    let root = workspace(&s, &id)?;
    save_text(&paths::data_dir(), &root, &path, &content, &expected)
}

fn save_text(data: &Path, root: &Path, path: &str, content: &str, expected: &str) -> Result<(), String> {
    let file = resolve_file(root, path)?;
    if !matches!(kind(&file).as_deref(), Some("md" | "txt" | "csv" | "json" | "html")) {
        return Err("Only text documents can be edited here".into());
    }
    if content.len() > MAX_PREVIEW as usize {
        return Err("Document exceeds the 8 MB edit limit".into());
    }
    let current = String::from_utf8(read_bounded(&file, MAX_PREVIEW)?).map_err(|e| e.to_string())?;
    if current != expected {
        return Err("The file changed while you were editing (probably the assistant). Copy your text, reload and try again.".into());
    }
    snapshot_at(data, root, path)?;
    let temp = file.with_extension(format!("lw-save-{:08x}", rand::random::<u32>()));
    fs::write(&temp, content).map_err(|e| e.to_string())?;
    fs::rename(&temp, &file).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })
}

/// The smallest stretch of `before` that changed, widened until it occurs only once, with its
/// replacement. A find/replace keeps the surrounding run formatting, unlike rewriting the text.
fn find_replace(before: &str, after: &str) -> Option<(String, String)> {
    let b: Vec<char> = before.chars().collect();
    let a: Vec<char> = after.chars().collect();
    let mut start = 0;
    while start < b.len() && start < a.len() && b[start] == a[start] {
        start += 1;
    }
    let mut tail = 0;
    while tail < b.len() - start && tail < a.len() - start && b[b.len() - 1 - tail] == a[a.len() - 1 - tail] {
        tail += 1;
    }
    let (mut lo, mut hi) = (start, b.len() - tail);
    let mut left = true;
    loop {
        let old: String = b[lo..hi].iter().collect();
        // OfficeCLI reads r"..." as a regular expression.
        if !old.is_empty() && !old.starts_with("r\"") && before.matches(old.as_str()).count() == 1 {
            let new: String = a[lo..a.len() - (b.len() - hi)].iter().collect();
            return Some((old, new));
        }
        if lo == 0 && hi == b.len() {
            return None;
        }
        if (left && lo > 0) || hi == b.len() {
            lo -= 1;
        } else {
            hi += 1;
        }
        left = !left;
    }
}

/// Applies the user's in-place edit of one element in a Word, PowerPoint or Excel preview.
#[tauri::command]
pub async fn document_office_edit(
    s: State<'_, App>,
    id: String,
    path: String,
    node: String,
    before: String,
    after: String,
) -> Result<(), String> {
    let root = workspace(&s, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::ffi::OsStr;
        let file = resolve_file(&root, &path)?;
        let kind = kind(&file).ok_or("Unsupported document type")?;
        if !matches!(kind.as_str(), "docx" | "xlsx" | "pptx") {
            return Err("Not an Office document".into());
        }
        if !node.starts_with('/') || node.len() > 300 || node.chars().any(char::is_control) {
            return Err("Invalid element path".into());
        }
        if after.len() > 64 * 1024 || after.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
            return Err("Edited text is too long or contains control characters".into());
        }
        if before == after {
            return Ok(());
        }
        snapshot(&root, &path)?;
        let target = native_path(&file);
        let set = |extra: &[&str]| {
            let mut args = vec![OsStr::new("set"), OsStr::new(&target), OsStr::new(&node)];
            args.extend(extra.iter().map(OsStr::new));
            office_output(&args)
        };
        if kind == "xlsx" {
            let prop = match after.strip_prefix('=') {
                Some(formula) if !formula.trim().is_empty() => format!("formula={formula}"),
                _ => format!("value={after}"),
            };
            return set(&["--prop", &prop]).map(|_| ());
        }
        if let Some((old, new)) = find_replace(&before, &after) {
            if set(&["--find", &old, "--replace", &new])?.contains("(1 matched)") {
                return Ok(());
            }
        }
        // The preview text did not line up with the stored runs; rewrite the element's text.
        set(&["--prop", &format!("text={after}")]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_legacy_hidden_build_files_are_omitted() {
        assert!(is_build_scratch(Path::new(".brief.build.json")));
        assert!(is_build_scratch(Path::new(".build.json")));
        assert!(is_build_scratch(Path::new(".FIX.BUILD.JSON")));
        assert!(!is_build_scratch(Path::new("budget.json")));
        assert!(!is_build_scratch(Path::new("build.json")));
        assert!(!is_build_scratch(Path::new(".settings.json")));
        assert!(!is_build_scratch(Path::new("workshop-brief.docx")));
    }
    #[test]
    fn find_replace_is_minimal_and_unique() {
        let (old, new) = find_replace("Hello world", "Hello there world").unwrap();
        assert_eq!("Hello world".replacen(&old, &new, 1), "Hello there world");
        assert_eq!(find_replace("Sales rose 5%", "Sales rose 7%"), Some(("5".into(), "7".into())));
        // "a" occurs twice, so it widens until unique.
        let (old, new) = find_replace("a b a", "a b c").unwrap();
        assert_eq!("a b a".matches(&old).count(), 1);
        assert_eq!("a b a".replacen(&old, &new, 1), "a b c");
        assert_eq!(find_replace("", "new"), None);
        let (old, new) = find_replace("abc", "").unwrap();
        assert_eq!((old.as_str(), new.as_str()), ("abc", ""));
        let (old, new) = find_replace("café au lait", "café noir").unwrap();
        assert_eq!("café au lait".replacen(&old, &new, 1), "café noir");
    }
    #[test]
    fn text_save_refuses_a_changed_file() {
        let temp = Temp::new();
        let (ws, data) = (temp.0.join("ws"), temp.0.join("data"));
        fs::create_dir(&ws).unwrap();
        fs::write(ws.join("notes.md"), "v1").unwrap();
        assert!(save_text(&data, &ws, "notes.md", "mine", "old").is_err());
        assert_eq!(fs::read_to_string(ws.join("notes.md")).unwrap(), "v1");
        save_text(&data, &ws, "notes.md", "mine", "v1").unwrap();
        assert_eq!(fs::read_to_string(ws.join("notes.md")).unwrap(), "mine");
        assert_eq!(records(&data, &resolve_file(&ws, "notes.md").unwrap()).unwrap().len(), 1);
        fs::write(ws.join("run.bat"), "x").unwrap();
        assert!(save_text(&data, &ws, "run.bat", "y", "x").is_err());
    }
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "localwork-documents-{:016x}",
                rand::random::<u64>()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn rejects_workspace_escape() {
        let temp = Temp::new();
        let ws = temp.0.join("workspace");
        fs::create_dir(&ws).unwrap();
        fs::write(temp.0.join("outside.md"), "private").unwrap();
        assert!(resolve_file(&ws, "../outside.md").is_err());
        assert!(resolve_file(&ws, temp.0.join("outside.md").to_str().unwrap()).is_err());
    }
    #[test]
    fn a_panicking_snapshot_does_not_break_later_revisions() {
        let temp = Temp::new();
        let ws = temp.0.join("workspace");
        let data = temp.0.join("data");
        fs::create_dir(&ws).unwrap();
        fs::write(ws.join("report.md"), "one").unwrap();
        // A panic while a snapshot held the revision lock used to poison it, so every later save failed.
        // Recovering leaves the lock poisoned for the rest of this test binary, which `guard()` tolerates.
        assert!(std::thread::spawn(|| {
            let _g = REVISION_LOCK.guard();
            panic!("a snapshot panicked while holding the revision lock");
        })
        .join()
        .is_err());
        assert!(REVISION_LOCK.lock().is_err(), "the panic must poison the revision lock");
        snapshot_at(&data, &ws, "report.md").unwrap();
        let file = resolve_file(&ws, "report.md").unwrap();
        assert_eq!(records(&data, &file).unwrap().len(), 1);
    }

    #[test]
    fn revisions_deduplicate_and_preserve_changed_bytes() {
        let temp = Temp::new();
        let ws = temp.0.join("workspace");
        let data = temp.0.join("data");
        fs::create_dir(&ws).unwrap();
        fs::write(ws.join("report.md"), "one").unwrap();
        snapshot_at(&data, &ws, "report.md").unwrap();
        snapshot_at(&data, &ws, "report.md").unwrap();
        let file = resolve_file(&ws, "report.md").unwrap();
        assert_eq!(records(&data, &file).unwrap().len(), 1);
        fs::write(&file, "two").unwrap();
        snapshot_at(&data, &ws, "report.md").unwrap();
        let revisions = records(&data, &file).unwrap();
        assert_eq!(revisions.len(), 2);
        let mut bytes = revisions
            .iter()
            .map(|r| fs::read(revision_file(&data, &file, &r.id).unwrap()).unwrap())
            .collect::<Vec<_>>();
        bytes.sort();
        assert_eq!(bytes, vec![b"one".to_vec(), b"two".to_vec()]);
    }
    #[test]
    fn revisions_are_scoped_to_original_file() {
        let temp = Temp::new();
        let ws = temp.0.join("workspace");
        let data = temp.0.join("data");
        fs::create_dir(&ws).unwrap();
        fs::write(ws.join("a.md"), "a").unwrap();
        fs::write(ws.join("b.md"), "b").unwrap();
        snapshot_at(&data, &ws, "a.md").unwrap();
        let a = resolve_file(&ws, "a.md").unwrap();
        let b = resolve_file(&ws, "b.md").unwrap();
        let revision = records(&data, &a).unwrap().remove(0);
        assert!(revision_file(&data, &b, &revision.id).is_err());
        assert!(revision_file(&data, &a, "../escape").is_err());
        snapshot_at(&data, &ws, "new.md").unwrap();
        assert!(!ws.join("new.md").exists());
    }

    #[test]
    fn visual_export_never_overwrites_an_existing_file() {
        let temp = Temp::new();
        let destination = temp.0.join("visual.html").to_string_lossy().into_owned();
        document_save_visual(destination.clone(), "<p>original</p>".into()).unwrap();
        assert!(document_save_visual(destination.clone(), "replacement".into()).is_err());
        assert_eq!(fs::read_to_string(destination).unwrap(), "<p>original</p>");
        assert!(document_save_visual(
            temp.0.join("program.exe").to_string_lossy().into_owned(),
            "not a document".into()
        )
        .is_err());
        assert!(!temp.0.join("program.exe").exists());
    }

    #[test]
    #[ignore = "Requires the pinned OfficeCLI vendor binary; uses isolated temporary fixtures only"]
    fn officecli_html_previews() {
        use std::ffi::OsStr;
        let temp = Temp::new();
        for (ext, commands) in [
            (
                "docx",
                json!([{"command":"add","parent":"/","type":"paragraph","props":{"text":"PreviewFixtureWord"}}]),
            ),
            (
                "xlsx",
                json!([{"command":"set","path":"/Sheet1/A1","props":{"value":"PreviewFixtureSheet"}}]),
            ),
            (
                "pptx",
                json!([{"command":"add","parent":"/","type":"slide","props":{"layout":"Title Slide","title":"PreviewFixtureSlides","text":"Synthetic fixture"}}]),
            ),
        ] {
            let file = temp.0.join(format!("fixture.{ext}"));
            let batch = temp.0.join(format!("build-{ext}.json"));
            fs::write(&batch, serde_json::to_vec(&commands).unwrap()).unwrap();
            office_output(&[OsStr::new("create"), file.as_os_str()]).unwrap();
            office_output(&[
                OsStr::new("batch"),
                file.as_os_str(),
                OsStr::new("--input"),
                batch.as_os_str(),
            ])
            .unwrap();
            let html = office_preview(&file.canonicalize().unwrap()).unwrap();
            office_output(&[OsStr::new("close"), file.as_os_str()]).unwrap();
            assert!(
                html.to_ascii_lowercase().contains("<html"),
                "{ext} must return an HTML document"
            );
            assert!(
                html.contains("PreviewFixture"),
                "{ext} preview must include the fixture content"
            );
        }
    }
}

#[cfg(windows)]
fn is_reparse_point(entry: &fs::DirEntry) -> Result<bool, String> {
    use std::os::windows::fs::MetadataExt;
    Ok(entry.metadata().map_err(|e| e.to_string())?.file_attributes() & 0x400 != 0)
}

#[cfg(not(windows))]
fn is_reparse_point(_entry: &fs::DirEntry) -> Result<bool, String> {
    Ok(false)
}
