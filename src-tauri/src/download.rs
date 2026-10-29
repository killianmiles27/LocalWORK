//! Large-file downloads (engines and models) with resume, progress events and cancel.
//! Only https hosts the app knows are allowed, so a page or plugin cannot point the downloader anywhere else.
use crate::sync::LockExt;
use serde_json::json;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

const HOSTS: &[&str] = &[
    "huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs-us-1.huggingface.co", "cas-bridge.xethub.hf.co", "transfer.xethub.hf.co",
    "github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
];

fn host_ok(u: &reqwest::Url) -> bool {
    u.scheme() == "https" && u.host_str().is_some_and(|h| HOSTS.contains(&h) || h.ends_with(".hf.co") || h.ends_with(".huggingface.co"))
}

pub fn client(timeout: Option<Duration>) -> Result<reqwest::blocking::Client, String> {
    if crate::setup::OFFLINE.load(Ordering::Relaxed) {
        return Err("Offline mode is on. Turn it off in Settings to download.".into());
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let mut b = reqwest::blocking::Client::builder()
        .user_agent(concat!("LocalWORK/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|a| if host_ok(a.url()) && a.previous().len() < 8 { a.follow() } else { a.stop() }));
    if let Some(t) = timeout {
        b = b.timeout(t);
    }
    b.build().map_err(|e| e.to_string())
}

pub fn cancel(id: &str) {
    CANCELLED.guard().get_or_insert_with(HashSet::new).insert(id.to_string());
}

fn cancelled(id: &str) -> bool {
    CANCELLED.guard().as_mut().is_some_and(|s| s.remove(id))
}

fn resumed_total(header: &str, have: u64) -> Option<u64> {
    let (range, total) = header.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total) = (start.parse::<u64>().ok()?, end.parse::<u64>().ok()?, total.parse::<u64>().ok()?);
    (start == have && end >= start && end < total).then_some(total)
}

pub fn stage(app: &AppHandle, id: &str, state: &str, message: &str) {
    let _ = app.emit("download-progress", json!({"id": id, "done": 0, "total": null, "rate": 0, "state": state, "stage": state, "message": message}));
}

/// GET a small JSON document (catalog, API listing) from an allowed host.
pub fn json(url: &str, bearer: Option<&str>) -> Result<serde_json::Value, String> {
    let u = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    if !host_ok(&u) {
        return Err(format!("LocalWORK does not download from {}", u.host_str().unwrap_or("?")));
    }
    let github = u.host_str().is_some_and(|h| h == "api.github.com" || h == "github.com");
    let mut r = client(Some(Duration::from_secs(30)))?.get(u).header("Accept", "application/json");
    if let Some(t) = bearer {
        r = r.bearer_auth(t);
    }
    let r = r.send().map_err(|e| format!("Could not connect: {e}"))?;
    let code = r.status().as_u16();
    if code != 200 {
        return Err(match code {
            403 if github => "GitHub refused the release lookup or its public rate limit was reached. Try again later.".into(),
            404 if github => "That upstream release no longer exists on GitHub.".into(),
            401 | 403 => "This Hugging Face model needs access approval or a sign-in. Accept its licence on Hugging Face and try again.".into(),
            404 => "That model or pinned revision no longer exists on Hugging Face.".into(),
            _ => format!("The server answered HTTP {code}."),
        });
    }
    r.json().map_err(|e| format!("Unexpected reply: {e}"))
}

/// Download `url` to `dest`, resuming a `.part` file. Emits `download-progress` {id, done, total, rate, state}.
/// Blocking: call from a command thread.
pub fn fetch(app: &AppHandle, id: &str, url: &str, dest: &Path, bearer: Option<&str>) -> Result<(), String> {
    let result = fetch_inner(app, id, url, dest, bearer);
    if let Err(ref error) = result { stage(app, id, "error", error); }
    result
}

fn fetch_inner(app: &AppHandle, id: &str, url: &str, dest: &Path, bearer: Option<&str>) -> Result<(), String> {
    stage(app, id, "connecting", "Connecting to download server…");
    let u = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    if !host_ok(&u) {
        return Err(format!("LocalWORK does not download from {}", u.host_str().unwrap_or("?")));
    }
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let part = dest.with_extension(format!("{}part", dest.extension().map(|e| format!("{}.", e.to_string_lossy())).unwrap_or_default()));
    let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut req = client(None)?.get(u);
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    if let Some(t) = bearer {
        req = req.bearer_auth(t);
    }
    let mut r = req.send().map_err(|e| format!("Could not connect: {e}"))?;
    let code = r.status().as_u16();
    let resumed = code == 206;
    if code != 200 && !resumed {
        return Err(match code {
            401 | 403 => "The download needs a sign-in or licence acceptance on Hugging Face (gated model).".into(),
            404 => "That file no longer exists at the source.".into(),
            416 => {
                // A server rejects a range past EOF with 416. Promote the partial file only when its
                // byte count exactly matches the server's advertised total; otherwise preserve it for retry.
                let total = r.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("bytes */")).and_then(|n| n.parse::<u64>().ok());
                if total == Some(have) {
                    std::fs::rename(&part, dest).map_err(|e| format!("Could not finish the download: {e}"))?;
                    let _ = app.emit("download-progress", json!({"id": id, "done": have, "total": have, "rate": 0, "state": "done"}));
                    return Ok(());
                }
                return Err("The saved partial download does not match the source size. Try again to restart it.".into());
            }
            _ => format!("The server answered HTTP {code}."),
        });
    }
    let start = if resumed { have } else { 0 };
    let total = if resumed {
        Some(r.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok())
            .and_then(|v| resumed_total(v, have))
            .ok_or("The server returned an invalid resume range; the partial file was left untouched.")?)
    } else { r.content_length() };
    let mut f = std::fs::OpenOptions::new().create(true).write(true).append(resumed).truncate(!resumed).open(&part).map_err(|e| e.to_string())?;
    let mut done = start;
    let mut buf = vec![0u8; 1 << 20];
    let (mut last, t0) = (Instant::now(), Instant::now());
    let emit = |done: u64, state: &str| {
        let secs = t0.elapsed().as_secs_f64().max(0.1);
        let _ = app.emit("download-progress", json!({"id": id, "done": done, "total": total, "rate": ((done - start) as f64 / secs) as u64, "state": state}));
    };
    emit(done, "running");
    loop {
        if cancelled(id) {
            emit(done, "cancelled");
            return Err("Download cancelled. It will resume where it stopped next time.".into());
        }
        let n = r.read(&mut buf).map_err(|e| format!("The download was interrupted ({e}). Try again to resume."))?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n]).map_err(|e| format!("Could not write to disk: {e}"))?;
        done += n as u64;
        if last.elapsed() > Duration::from_millis(400) {
            emit(done, "running");
            last = Instant::now();
        }
    }
    f.flush().map_err(|e| e.to_string())?;
    drop(f);
    if total.is_some_and(|t| t != done) {
        return Err("The download ended early. Try again to resume.".into());
    }
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    emit(done, "done");
    Ok(())
}

#[tauri::command(async)]
pub fn download_cancel(id: String) {
    cancel(&id);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resume_requires_the_exact_requested_offset_and_valid_total() {
        assert_eq!(resumed_total("bytes 10-19/20", 10), Some(20));
        assert_eq!(resumed_total("bytes 0-19/20", 10), None);
        assert_eq!(resumed_total("bytes 10-20/20", 10), None);
        assert_eq!(resumed_total("bytes 10-9/20", 10), None);
        assert_eq!(resumed_total("bytes 10-19/*", 10), None);
    }
}
