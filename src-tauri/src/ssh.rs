//! SSH host management for Settings: hosts list, ed25519 key, host-key pinning. Uses the system OpenSSH.
use crate::paths;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn dir() -> PathBuf {
    let d = paths::data_dir().join("ssh");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn tool(name: &str) -> PathBuf {
    if cfg!(not(windows)) {
        return PathBuf::from(name);
    }
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let p = PathBuf::from(root).join("System32").join("OpenSSH").join(format!("{name}.exe"));
    if p.exists() { p } else { PathBuf::from(name) }
}

fn run(c: &mut Command, input: Option<&str>) -> Result<String, String> {
    use std::io::Write;
    crate::supervisor::hidden(c).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut ch = c.spawn().map_err(|e| e.to_string())?;
    if let Some(mut si) = ch.stdin.take() {
        if let Some(t) = input { let _ = si.write_all(t.as_bytes()); }
    }
    let o = ch.wait_with_output().map_err(|e| e.to_string())?;
    let out = String::from_utf8_lossy(&o.stdout).to_string();
    if o.status.success() { Ok(out) } else { Err(format!("{}{}", out, String::from_utf8_lossy(&o.stderr))) }
}

pub fn hosts() -> Value {
    std::fs::read_to_string(dir().join("hosts.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}))
}

/// Used by the approval policy: may read-only commands on this host run without asking?
pub fn read_allowed(host: &str) -> bool {
    hosts().get(host).and_then(|h| h.get("read_ok")).and_then(|v| v.as_bool()).unwrap_or(false)
}

#[tauri::command(async)]
pub fn ssh_hosts() -> Value {
    hosts()
}

#[tauri::command(async)]
pub fn ssh_save_host(name: String, host: String, user: String, port: u16, read_ok: bool) -> Result<(), String> {
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if !ok(&name) || !ok(&host) || !ok(&user) {
        return Err("Name, host and user may only contain letters, digits, dot, dash and underscore".into());
    }
    let mut h = hosts();
    h[name] = json!({"host": host, "user": user, "port": port, "read_ok": read_ok});
    std::fs::write(dir().join("hosts.json"), serde_json::to_string_pretty(&h).unwrap()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn ssh_delete_host(name: String) -> Result<(), String> {
    let mut h = hosts();
    if let Some(o) = h.as_object_mut() { o.remove(&name); }
    std::fs::write(dir().join("hosts.json"), serde_json::to_string_pretty(&h).unwrap()).map_err(|e| e.to_string())
}

/// Public key text; generates the ed25519 key on first use and limits its ACL to the current user.
#[tauri::command(async)]
pub fn ssh_public_key() -> Result<String, String> {
    let key = dir().join("id_ed25519");
    if !key.exists() {
        run(Command::new(tool("ssh-keygen")).args(["-t", "ed25519", "-N", "", "-C", "localwork", "-f"]).arg(&key), None)?;
        if let Ok(u) = std::env::var("USERNAME") {
            let _ = run(Command::new("icacls").arg(&key).args(["/inheritance:r", "/grant:r", &format!("{u}:F")]), None);
        }
    }
    std::fs::read_to_string(dir().join("id_ed25519.pub")).map(|s| s.trim().to_string()).map_err(|e| e.to_string())
}

/// Fetch the server's host key and return its fingerprint for the user to confirm.
#[tauri::command(async)]
pub fn ssh_scan(host: String, port: u16) -> Result<Value, String> {
    let keys = run(Command::new(tool("ssh-keyscan")).args(["-T", "8", "-t", "ed25519,ecdsa,rsa", "-p", &port.to_string(), &host]), None)?;
    let keys: String = keys.lines().filter(|l| !l.starts_with('#')).collect::<Vec<_>>().join("\n");
    if keys.trim().is_empty() { return Err("Could not reach that host".into()); }
    let fp = run(Command::new(tool("ssh-keygen")).args(["-lf", "-"]), Some(&format!("{keys}\n")))?;
    Ok(json!({"keys": keys, "fingerprint": fp.trim()}))
}

/// Pin a scanned host key (after the user confirmed the fingerprint).
#[tauri::command(async)]
pub fn ssh_pin(keys: String) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir().join("known_hosts")).map_err(|e| e.to_string())?;
    writeln!(f, "{}", keys.trim()).map_err(|e| e.to_string())
}
