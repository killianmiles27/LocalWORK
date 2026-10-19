//! Version safety net (spec 16): keep a copy of each version's executable, back up the database
//! before a new version first opens it, and let the user switch back to an older version.
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Serialize)]
pub struct Version {
    pub version: String,
    pub current: bool,
}

fn exe_dir(dir: &Path) -> PathBuf {
    dir.join("rollback")
}

/// Call before the database is opened.
pub fn on_start(dir: &Path) {
    let last = fs::read_to_string(dir.join("last_version.txt")).unwrap_or_default();
    let last = last.trim();
    let db = dir.join("workbench.db");
    if db.exists() && last != VERSION {
        let b = dir.join("backups");
        let _ = fs::create_dir_all(&b);
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let tag = if last.is_empty() { "unknown" } else { last };
        let _ = fs::copy(&db, b.join(format!("workbench-from-{tag}-{ts}.db")));
        prune(&b, 5);
    }
    let _ = fs::write(dir.join("last_version.txt"), VERSION);
    if let Ok(me) = std::env::current_exe() {
        let r = exe_dir(dir);
        let _ = fs::create_dir_all(&r);
        let target = r.join(format!("LocalWORK-{VERSION}.exe"));
        if !target.exists() {
            let _ = fs::copy(&me, &target);
        }
        prune(&r, 3);
    }
}

fn prune(d: &Path, keep: usize) {
    let mut v: Vec<_> = fs::read_dir(d).into_iter().flatten().flatten().filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect();
    v.sort();
    while v.len() > keep {
        let (_, p) = v.remove(0);
        let _ = fs::remove_file(p);
    }
}

#[tauri::command(async)]
pub fn rollback_list() -> Vec<Version> {
    let dir = crate::paths::data_dir();
    let mut out = vec![];
    for e in fs::read_dir(exe_dir(&dir)).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if let Some(v) = n.strip_prefix("LocalWORK-").and_then(|x| x.strip_suffix(".exe")) {
            out.push(Version { version: v.to_string(), current: v == VERSION });
        }
    }
    out.sort_by(|a, b| b.version.cmp(&a.version));
    out
}

/// Replace the installed executable with the saved copy of `version`, then restart.
#[tauri::command(async)]
pub fn rollback_to(app: tauri::AppHandle, version: String) -> Result<(), String> {
    if !version.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return Err("bad version".into());
    }
    let dir = crate::paths::data_dir();
    let src = exe_dir(&dir).join(format!("LocalWORK-{version}.exe"));
    if !src.exists() {
        return Err("that version is not saved".into());
    }
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let _ = fs::write(dir.join("last_version.txt"), &version);
    let script = format!(
        "ping -n 4 127.0.0.1 >nul & copy /y \"{}\" \"{}\" >nul & start \"\" \"{}\"",
        src.display(),
        me.display(),
        me.display()
    );
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd").args(["/c", &script]).creation_flags(0x0800_0000 | 0x0000_0008).spawn().map_err(|e| e.to_string())?;
    }
    app.exit(0);
    Ok(())
}
