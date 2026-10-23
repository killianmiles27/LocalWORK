use std::path::PathBuf;

// A machine-specific path must never be baked into the distributable.
pub fn default_strata_root() -> String {
    std::env::var("LOCALWORK_STRATA_ROOT")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .or_else(|| {
            let sibling = app_dir().join("strata");
            sibling
                .exists()
                .then(|| sibling.to_string_lossy().into_owned())
        })
        .unwrap_or_default()
}

pub fn default_model_config() -> String {
    std::env::var("LOCALWORK_MODEL_CONFIG")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_default()
}

/// `name` plus the platform's executable suffix (`.exe` on Windows, nothing on Linux).
pub fn exe(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

/// The Python inside a virtual environment folder (`.venv` under `root`).
pub fn venv_python(root: &std::path::Path) -> PathBuf {
    if cfg!(windows) {
        root.join(".venv").join("Scripts").join("python.exe")
    } else {
        root.join(".venv").join("bin").join("python")
    }
}

#[cfg(not(windows))]
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
        .unwrap_or_else(|| PathBuf::from("."));
    let d = base.join("Workbench");
    let _ = std::fs::create_dir_all(d.join("logs"));
    d
}

#[cfg(windows)]
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .map(|p| p.join("AppData").join("Local"))
        })
        .or_else(|| app_dir().canonicalize().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let d = PathBuf::from(base).join("Workbench");
    let _ = std::fs::create_dir_all(d.join("logs"));
    d
}

pub fn app_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `vendor` next to the exe (installed layout), else walk up (dev layout: src-tauri/target/release -> app/vendor).
/// Where the Linux packages put bundled resources: `/usr/lib/LocalWORK` next to `/usr/bin`
/// (deb, rpm, Arch), or the same layout inside the AppImage.
fn linux_resources() -> Option<PathBuf> {
    if cfg!(windows) { return None; }
    let d = app_dir().parent()?.join("lib").join("LocalWORK");
    d.is_dir().then_some(d)
}

pub fn vendor_dir() -> PathBuf {
    if let Some(v) = linux_resources().map(|d| d.join("vendor")).filter(|v| v.join(exe("aionrs")).exists()) {
        return v;
    }
    let mut cur = Some(app_dir());
    for _ in 0..6 {
        if let Some(d) = cur {
            let v = d.join("vendor");
            if v.join(exe("aionrs")).exists() {
                return v;
            }
            cur = d.parent().map(|p| p.to_path_buf());
        } else {
            break;
        }
    }
    app_dir().join("vendor")
}

pub fn resource_dir(name: &str) -> PathBuf {
    if let Some(v) = linux_resources().map(|d| d.join(name)).filter(|v| v.exists()) {
        return v;
    }
    let mut cur = Some(app_dir());
    for _ in 0..6 {
        if let Some(d) = cur {
            let v = d.join(name);
            if v.exists() {
                return v;
            }
            cur = d.parent().map(|p| p.to_path_buf());
        } else {
            break;
        }
    }
    app_dir().join(name)
}
