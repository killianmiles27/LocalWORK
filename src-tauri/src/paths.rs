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

/// `name` plus the platform's executable suffix (`.exe` on Windows).
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
pub fn vendor_dir() -> PathBuf {
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
