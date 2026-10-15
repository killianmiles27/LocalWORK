use std::path::PathBuf;

pub const DEFAULT_STRATA_ROOT: &str = r"C:\Random\Working Folder\LocalWORK\strata";
pub const DEFAULT_MODEL_CONFIG: &str =
    r"C:\Random\Working Folder\LocalWORK\benchmark\configs\selected-model.json";

pub fn data_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| r"C:\Users\Public".into());
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
            if v.join("aionrs.exe").exists() {
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
