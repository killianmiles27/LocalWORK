//! Folder undo points, separate from document revisions and never agent tools.
use crate::{paths, store, sync::LockExt, App};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

const KEEP_SNAPSHOTS: usize = 10;
const MAX_FILES: usize = 10_000;
const MAX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 50_000;
const MAX_DEPTH: usize = 64;
const MAX_MANIFEST_BYTES: u64 = 32 * 1024 * 1024;
static SNAPSHOT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, Deserialize)]
pub struct FileRecord {
    path: String,
    size: u64,
    /// Milliseconds since the Unix epoch; informational, not a deduplication key.
    mtime: u64,
    /// SHA-256 of the stored bytes (also the blob filename).
    hash: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Skipped {
    path: String,
    reason: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    id: String,
    chat: String,
    workspace: String,
    created: u64,
    files: Vec<FileRecord>,
    skipped: Vec<Skipped>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn chat_dir(data: &Path, chat: &str) -> PathBuf {
    data.join("workspace-snapshots")
        .join(digest(chat.as_bytes()))
}

fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn excluded(name: &str) -> bool {
    // Local search stores its index at .localwork/search.sqlite. Exclude its entire
    // folder (including SQLite sidecars), alongside the other index folder spellings.
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | "node_modules"
            | "target"
            | ".localwork"
            | ".localwork-index"
            | ".search-index"
            | ".workbench-index"
    )
}

/// Use a portable subset on both platforms: no Windows drive/UNC/ADS spelling hidden in a
/// Linux manifest, and no normalization of dot components before validation.
fn relative(path: &str) -> Result<&Path, String> {
    let unsafe_component = |part: &str| {
        let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let device = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ["COM", "LPT"].iter().any(|prefix| {
                base.strip_prefix(prefix)
                    .is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
            });
        part.is_empty()
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "<>\"|?*".contains(c))
            || device
            || excluded(part)
    };
    if path.is_empty() || path.contains(['\\', ':']) || path.split('/').any(unsafe_component) {
        return Err(format!("Unsafe snapshot path: {path}"));
    }
    let p = Path::new(path);
    if p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("Unsafe snapshot path: {path}"));
    }
    Ok(p)
}

/// Refuse links/reparse points in *every* existing component, including dangling links.
/// Missing descendants are allowed during restore. This deliberately also refuses internal links.
fn checked_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let mut target = root.to_path_buf();
    for component in relative(path)?.components() {
        target.push(component);
        match fs::symlink_metadata(&target) {
            Ok(meta) => {
                if linked(&meta)
                    || !target
                        .canonicalize()
                        .map_err(|e| e.to_string())?
                        .starts_with(root)
                {
                    return Err(format!("Snapshot path crosses a link: {path}"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{path}: {e}")),
        }
    }
    Ok(target)
}

fn root_and_data(data: &Path, workspace: &Path) -> Result<(PathBuf, PathBuf), String> {
    let root = workspace
        .canonicalize()
        .map_err(|e| format!("Workspace: {e}"))?;
    if !root.is_dir() {
        return Err("Workspace is not a folder".into());
    }
    // Resolve the longest existing prefix before creating app data, to catch linked parents too.
    let mut prefix = data.to_path_buf();
    let mut suffix = Vec::new();
    while !prefix.exists() {
        suffix.push(
            prefix
                .file_name()
                .ok_or("Invalid app data path")?
                .to_os_string(),
        );
        prefix = prefix
            .parent()
            .ok_or("Invalid app data path")?
            .to_path_buf();
    }
    let mut real_data = prefix.canonicalize().map_err(|e| e.to_string())?;
    for part in suffix.iter().rev() {
        real_data.push(part);
    }
    if real_data.starts_with(&root) || root.starts_with(&real_data) {
        return Err("Workspace and app data must be separate folders; snapshots cannot live inside the workspace".into());
    }
    Ok((root, real_data))
}

fn store_dir(data: &Path, chat: &str) -> Result<PathBuf, String> {
    let dir = chat_dir(data, chat);
    checked_path(
        data,
        dir.strip_prefix(data)
            .map_err(|e| e.to_string())?
            .to_str()
            .ok_or("Non-UTF-8 snapshot store")?
            .replace(std::path::MAIN_SEPARATOR, "/")
            .as_str(),
    )
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "{} changed or exceeds the byte limit",
            path.display()
        ));
    }
    Ok(bytes)
}

fn path_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

fn load(dir: &Path, root: &Path, chat: &str, id: &str) -> Result<Manifest, String> {
    if !valid_hex(id, 32) {
        return Err("Invalid snapshot ID".into());
    }
    // Stored data must not redirect reads outside the snapshot store either.
    for path in [
        dir.to_path_buf(),
        dir.join(id),
        dir.join(id).join("manifest.json"),
    ] {
        if linked(&fs::symlink_metadata(&path).map_err(|e| e.to_string())?) {
            return Err("Snapshot store contains a link".into());
        }
    }
    let manifest: Manifest = serde_json::from_slice(&read_bounded(
        &dir.join(id).join("manifest.json"),
        MAX_MANIFEST_BYTES,
    )?)
    .map_err(|e| e.to_string())?;
    if manifest.id != id
        || manifest.chat != chat
        || Path::new(&manifest.workspace) != root
        || manifest.files.len() > MAX_FILES
        || manifest.skipped.len() > MAX_ENTRIES + MAX_DEPTH
    {
        return Err(
            "Snapshot does not belong to this chat and workspace, or exceeds limits".into(),
        );
    }
    let mut seen = HashSet::new();
    let mut bytes = 0u64;
    for file in &manifest.files {
        relative(&file.path)?;
        // Windows aliases are case-insensitive, even if the snapshot was produced on Linux.
        if !seen.insert(path_key(&file.path))
            || file.size > MAX_FILE_BYTES
            || !valid_hex(&file.hash, 64)
        {
            return Err("Invalid or duplicate snapshot file".into());
        }
        bytes = bytes
            .checked_add(file.size)
            .ok_or("Snapshot byte limit exceeded")?;
    }
    if bytes > MAX_BYTES {
        return Err("Snapshot byte limit exceeded".into());
    }
    Ok(manifest)
}

/// Incomplete staging directories are never listed; malformed committed manifests fail closed.
fn records(dir: &Path, root: &Path, chat: &str) -> Result<Vec<Manifest>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if valid_hex(&id, 32) {
            out.push(load(dir, root, chat, &id)?);
        }
    }
    out.sort_by(|a, b| b.created.cmp(&a.created).then(b.id.cmp(&a.id)));
    Ok(out)
}

struct Walk {
    files: Vec<String>,
    skipped: Vec<Skipped>,
    visited: usize,
}
impl Walk {
    fn skip(&mut self, path: String, reason: &str) {
        self.skipped.push(Skipped {
            path,
            reason: reason.into(),
        });
    }
    fn folder(&mut self, root: &Path, dir: &Path, depth: usize) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
            if self.visited >= MAX_ENTRIES {
                self.skip(
                    dir.strip_prefix(root)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .into_owned(),
                    "entry count cap: remaining subtree not visited",
                );
                break;
            }
            self.visited += 1;
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or("Non-UTF-8 filenames cannot be snapshotted")?;
            if excluded(name) {
                continue;
            }
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("Non-UTF-8 path")?
                .replace(std::path::MAIN_SEPARATOR, "/");
            let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if linked(&meta) {
                self.skip(rel, "symlink or reparse point (not followed)");
                continue;
            }
            checked_path(root, &rel)?;
            if meta.is_dir() {
                if depth >= MAX_DEPTH {
                    self.skip(rel, "directory depth cap");
                } else {
                    self.folder(root, &path, depth + 1)?;
                }
            } else if meta.is_file() {
                self.files.push(rel);
            } else {
                self.skip(rel, "not a regular file");
            }
        }
        Ok(())
    }
}
fn walk(root: &Path) -> Result<Walk, String> {
    let mut walk = Walk {
        files: Vec::new(),
        skipped: Vec::new(),
        visited: 0,
    };
    walk.folder(root, root, 0)?;
    walk.files.sort();
    Ok(walk)
}

fn blob(snapshot: &Path, hash: &str, size: u64) -> Result<PathBuf, String> {
    let folder = snapshot.join("files");
    let path = folder.join(hash);
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if linked(&fs::symlink_metadata(folder).map_err(|e| e.to_string())?)
        || linked(&meta)
        || !meta.is_file()
        || meta.len() != size
    {
        return Err("Invalid snapshot contents".into());
    }
    if digest(&read_bounded(&path, size)?) != hash {
        return Err("Snapshot content hash mismatch".into());
    }
    Ok(path)
}

pub fn create_at(data: &Path, workspace: &Path, chat: &str) -> Result<Manifest, String> {
    let _guard = SNAPSHOT_LOCK.guard();
    let (root, data) = root_and_data(data, workspace)?;
    let dir = store_dir(&data, chat)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let previous = records(&dir, &root, chat)?;
    let previous_hashes: HashMap<_, _> = previous
        .first()
        .into_iter()
        .flat_map(|p| &p.files)
        .map(|f| (f.hash.as_str(), f.size))
        .collect();
    // A crash may leave a staging directory. It is not a snapshot and is safe to reclaim.
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_string_lossy().starts_with(".partial-") {
            fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    let stage = tempfile::Builder::new()
        .prefix(".partial-")
        .tempdir_in(&dir)
        .map_err(|e| e.to_string())?;
    fs::create_dir(stage.path().join("files")).map_err(|e| e.to_string())?;
    let scanned = walk(&root)?;
    let created = store::now().max(0) as u64;
    // Strictly monotonic per chat, even when two commands arrive within the same millisecond.
    let created = previous
        .first()
        .map_or(created, |p| created.max(p.created.saturating_add(1)));
    let id = format!("{:016x}{:016x}", created, rand::random::<u64>());
    let mut manifest = Manifest {
        id: id.clone(),
        chat: chat.into(),
        workspace: root.to_str().ok_or("Non-UTF-8 workspace")?.into(),
        created,
        files: Vec::new(),
        skipped: scanned.skipped,
    };
    let mut total = 0;
    for rel in scanned.files {
        let source = checked_path(&root, &rel)?;
        let meta = fs::metadata(&source).map_err(|e| e.to_string())?;
        let reason = if manifest.files.len() >= MAX_FILES {
            Some("file count cap")
        } else if meta.len() > MAX_FILE_BYTES {
            Some("per-file byte cap")
        } else if meta.len() > MAX_BYTES - total {
            Some("total byte cap")
        } else {
            None
        };
        if let Some(reason) = reason {
            manifest.skipped.push(Skipped {
                path: rel,
                reason: reason.into(),
            });
            continue;
        }
        let bytes = read_bounded(&source, meta.len())?;
        let after = fs::metadata(&source).map_err(|e| e.to_string())?;
        if bytes.len() as u64 != meta.len()
            || after.len() != meta.len()
            || after.modified().ok() != meta.modified().ok()
        {
            return Err(format!("{rel} changed while being snapshotted; try again"));
        }
        let hash = digest(&bytes);
        let destination = stage.path().join("files").join(&hash);
        if !destination.exists() {
            if previous_hashes.get(hash.as_str()) == Some(&meta.len()) {
                let source = blob(&dir.join(&previous[0].id), &hash, meta.len())?;
                // Only link immutable snapshot blobs, never the user's mutable files.
                if fs::hard_link(&source, &destination).is_err() {
                    fs::copy(&source, &destination).map_err(|e| e.to_string())?;
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&destination)
                        .and_then(|f| f.sync_all())
                        .map_err(|e| e.to_string())?;
                }
            } else {
                let mut file = fs::File::create(&destination).map_err(|e| e.to_string())?;
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|e| e.to_string())?;
            }
        }
        total += meta.len();
        manifest.files.push(FileRecord {
            path: rel,
            size: meta.len(),
            mtime: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64),
            hash,
        });
    }
    let encoded = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    if encoded.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Snapshot manifest exceeds byte limit".into());
    }
    let mut file =
        fs::File::create(stage.path().join("manifest.json")).map_err(|e| e.to_string())?;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    // Publish only the complete directory. TempDir removes all partial writes on any error.
    fs::rename(stage.path(), dir.join(&id)).map_err(|e| e.to_string())?;
    for old in previous.iter().skip(KEEP_SNAPSHOTS - 1) {
        fs::remove_dir_all(dir.join(&old.id))
            .map_err(|e| format!("Snapshot saved, but could not prune old snapshots: {e}"))?;
    }
    Ok(manifest)
}

fn list_at(data: &Path, workspace: &Path, chat: &str) -> Result<Vec<Manifest>, String> {
    let _guard = SNAPSHOT_LOCK.guard();
    let (root, data) = root_and_data(data, workspace)?;
    records(&store_dir(&data, chat)?, &root, chat)
}

#[derive(Debug, Serialize)]
pub struct RestoreReport {
    restored: Vec<String>,
    deleted: Vec<String>,
}

fn restore_at(
    data: &Path,
    workspace: &Path,
    chat: &str,
    id: &str,
    exact: bool,
) -> Result<RestoreReport, String> {
    let _guard = SNAPSHOT_LOCK.guard();
    let (root, data) = root_and_data(data, workspace)?;
    let dir = store_dir(&data, chat)?;
    let manifest = load(&dir, &root, chat, id)?;
    if exact && !manifest.skipped.is_empty() {
        return Err("Exact restore is unavailable for a snapshot with skipped files".into());
    }
    // Preflight every manifest target and blob before writing anything. Each write rechecks the
    // destination as well; this is not an OS sandbox against concurrent hostile filesystem swaps.
    for record in &manifest.files {
        let target = checked_path(&root, &record.path)?;
        if target.exists() && !target.is_file() {
            return Err(format!("Not a regular file: {}", record.path));
        }
        blob(&dir.join(id), &record.hash, record.size)?;
    }
    let mut deletions = Vec::new();
    if exact {
        let current = walk(&root)?;
        if !current.skipped.is_empty() {
            return Err("Exact restore cannot traverse the current folder completely".into());
        }
        let keep: HashSet<_> = manifest.files.iter().map(|r| path_key(&r.path)).collect();
        deletions = current
            .files
            .into_iter()
            .filter(|p| !keep.contains(&path_key(p)))
            .collect();
    }
    let mut report = RestoreReport {
        restored: Vec::new(),
        deleted: Vec::new(),
    };
    let result = (|| -> Result<(), String> {
        for record in &manifest.files {
            let target = checked_path(&root, &record.path)?;
            let parent = target.parent().ok_or("Invalid restore destination")?;
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            checked_path(&root, &record.path)?;
            let source = blob(&dir.join(id), &record.hash, record.size)?;
            let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
            let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
            std::io::copy(&mut input, &mut temp).map_err(|e| e.to_string())?;
            temp.as_file().sync_all().map_err(|e| e.to_string())?;
            checked_path(&root, &record.path)?;
            // persist uses atomic replacement where supported, including Windows. Never hardlink
            // restored files to immutable snapshots (an in-place user edit would corrupt history).
            temp.persist(&target).map_err(|e| e.to_string())?;
            report.restored.push(record.path.clone());
        }
        for path in deletions {
            let target = checked_path(&root, &path)?;
            fs::remove_file(target).map_err(|e| e.to_string())?;
            report.deleted.push(path);
        }
        Ok(())
    })();
    result.map_err(|e| {
        format!(
            "Restore stopped: {e}; completed: {}",
            serde_json::to_string(&report).unwrap_or_default()
        )
    })?;
    Ok(report)
}

pub fn cleanup_at(data: &Path, chat: &str) -> Result<(), String> {
    let _guard = SNAPSHOT_LOCK.guard();
    if !data.exists() {
        return Ok(());
    }
    let data = data.canonicalize().map_err(|e| e.to_string())?;
    let dir = store_dir(&data, chat)?;
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn workspace(s: &State<'_, App>, id: &str) -> Result<PathBuf, String> {
    store::conv_info(&s.db.guard(), id)
        .map(|x| PathBuf::from(x.1))
        .ok_or_else(|| "Unknown chat".into())
}
fn ensure_idle(s: &State<'_, App>, id: &str) -> Result<(), String> {
    if s.agents.guard().get(id).is_some_and(|a| a.busy()) {
        return Err("Stop the current reply before restoring or removing snapshots".into());
    }
    Ok(())
}

/// User-only IPC commands: deliberately absent from the workbench MCP server/tool definitions.
#[tauri::command(async)]
pub fn workspace_snapshots_list(s: State<'_, App>, id: String) -> Result<Vec<Manifest>, String> {
    list_at(&paths::data_dir(), &workspace(&s, &id)?, &id)
}
#[tauri::command(async)]
pub fn workspace_snapshot_restore(
    s: State<'_, App>,
    id: String,
    snapshot: String,
    exact: Option<bool>,
) -> Result<RestoreReport, String> {
    ensure_idle(&s, &id)?;
    restore_at(
        &paths::data_dir(),
        &workspace(&s, &id)?,
        &id,
        &snapshot,
        exact.unwrap_or(false),
    )
}
#[tauri::command(async)]
pub fn workspace_snapshots_cleanup(s: State<'_, App>, id: String) -> Result<(), String> {
    ensure_idle(&s, &id)?;
    cleanup_at(&paths::data_dir(), &id)
}

#[cfg(test)]
#[path = "snapshots_tests.rs"]
mod tests;
