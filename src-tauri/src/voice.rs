//! Push-to-talk dictation: the WebView sends a 16 kHz mono WAV, whisper.cpp's `whisper-cli` turns it into text on the CPU,
//! and the transcript goes back to the composer. The process lives for one clip only, inside the host's Job Object.
//! "Tidy up" asks the local model to turn a long ramble into a clear request.
use crate::sync::LockExt;
use crate::{http, paths, strata, supervisor};
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::ipc::{InvokeBody, Request};
use tauri::State;

const MODEL_FILE: &str = "ggml-small-q5_1.bin";
const MAX_WAV_BYTES: usize = 40 << 20; // ~20 minutes of 16 kHz mono 16-bit
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(300);

static BUSY: AtomicBool = AtomicBool::new(false);

fn whisper_dir() -> PathBuf {
    let custom = strata::setting("whisperDir", "");
    if custom.is_empty() { paths::vendor_dir().join("whisper") } else { PathBuf::from(custom) }
}

fn missing() -> Option<String> {
    let d = whisper_dir();
    for f in [paths::exe("whisper-cli").as_str(), MODEL_FILE] {
        if !d.join(f).exists() {
            return Some(format!("Voice input needs {f} in {} (see vendor\\README.md)", d.display()));
        }
    }
    None
}

#[tauri::command(async)]
pub fn voice_status() -> Value {
    match missing() {
        None => json!({"available": true, "detail": ""}),
        Some(d) => json!({"available": false, "detail": d}),
    }
}

/// Body is the raw WAV file. Runs whisper-cli on it and returns the transcript.
#[tauri::command]
pub async fn voice_transcribe(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(wav) = request.body() else { return Err("Expected raw WAV bytes".into()) };
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err("Not a WAV recording".into());
    }
    if wav.len() > MAX_WAV_BYTES {
        return Err("Recording is too long".into());
    }
    if let Some(m) = missing() {
        return Err(m);
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("Still transcribing the previous clip".into());
    }
    let wav = wav.clone();
    let res = tauri::async_runtime::spawn_blocking(move || transcribe(&wav)).await.map_err(|e| e.to_string());
    BUSY.store(false, Ordering::SeqCst);
    res?
}

fn transcribe(wav: &[u8]) -> Result<String, String> {
    let data = paths::data_dir();
    let tmp = data.join("voice");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    // Leftovers from a clip that was cut off by the app closing mid-transcription.
    if let Ok(rd) = std::fs::read_dir(&tmp) {
        rd.flatten().for_each(|f| { let _ = std::fs::remove_file(f.path()); });
    }
    let stem = format!("clip-{}", std::process::id());
    let wav_path = tmp.join(format!("{stem}.wav"));
    let out_base = tmp.join(&stem);
    let txt_path = tmp.join(format!("{stem}.txt"));
    let log_path = data.join("logs").join("whisper.log");
    std::fs::write(&wav_path, wav).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&txt_path);

    let dir = whisper_dir();
    let exe = dir.join(paths::exe("whisper-cli"));
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&exe);
    cmd.arg("-m").arg(dir.join(MODEL_FILE))
        .args(["-l", "auto", "-nt", "-otxt", "-t", &threads.to_string(), "-f"])
        .arg(&wav_path)
        .arg("-of").arg(&out_base)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log2));
    // The Linux build ships whisper.cpp's shared libraries next to the binary.
    #[cfg(unix)]
    cmd.env("LD_LIBRARY_PATH", match std::env::var_os("LD_LIBRARY_PATH") {
        Some(old) if !old.is_empty() => { let mut p = dir.clone().into_os_string(); p.push(":"); p.push(old); p }
        _ => dir.clone().into_os_string(),
    });
    supervisor::hidden(&mut cmd);
    let result = (|| {
        let mut child = cmd.spawn().map_err(|e| format!("could not start whisper-cli: {e}"))?;
        let pid = child.id();
        supervisor::record(&data, supervisor::PidRec { pid, exe: exe.to_string_lossy().to_string(), role: "whisper".into() });
        let t0 = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Ok(s),
                Ok(None) if t0.elapsed() > TRANSCRIBE_TIMEOUT => {
                    supervisor::kill_tree(pid);
                    let _ = child.wait();
                    break Err("Transcription timed out".to_string());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => break Err(e.to_string()),
            }
        };
        supervisor::forget(&data, pid);
        let status = status?;
        if !status.success() {
            return Err(format!("whisper-cli failed ({status}); see logs\\whisper.log"));
        }
        let mut text = String::new();
        std::fs::File::open(&txt_path)
            .and_then(|mut f| f.read_to_string(&mut text))
            .map_err(|_| "whisper-cli produced no transcript".to_string())?;
        Ok(clean(&text))
    })();
    let _ = std::fs::remove_file(&wav_path);
    let _ = std::fs::remove_file(&txt_path);
    result
}

/// Drop whisper's bracketed non-speech markers ("[BLANK_AUDIO]", "(music)") and collapse whitespace.
fn clean(t: &str) -> String {
    let re = regex::Regex::new(r"\[[A-Za-z_ ]+\]|\((?i:music|silence|noise|applause|laughter)\)").unwrap();
    re.replace_all(t, " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

const TIDY_PROMPT: &str = "You rewrite dictated speech as a clear written request. Keep the speaker's intent, names, numbers and \
requirements exactly; remove filler words, false starts and repetition; put the points in logical order and use a short list when \
there are several separate asks. Do not answer the request and do not add anything new. Reply with only the rewritten request, in the \
language the speaker used.";

#[tauri::command]
pub async fn voice_tidy(s: State<'_, crate::App>, text: String) -> Result<String, String> {
    let (state, port, key, model) = {
        let g = s.strata.guard();
        (g.status.state.clone(), g.status.port, g.key.clone(), g.status.model.clone())
    };
    if state != "ready" {
        return Err("The model is still loading".into());
    }
    if text.trim().is_empty() {
        return Ok(text);
    }
    let body = json!({
        "model": model,
        "messages": [{"role": "system", "content": TIDY_PROMPT}, {"role": "user", "content": text}],
        "stream": false,
        "temperature": 0.2,
        "max_tokens": 1500,
        "chat_template_kwargs": {"enable_thinking": false},
    })
    .to_string();
    let reply = tauri::async_runtime::spawn_blocking(move || {
        http::post_json(port, "/v1/chat/completions", Some(&key), &body, Duration::from_secs(180))
    })
    .await
    .map_err(|e| e.to_string())?;
    let (code, raw) = reply.ok_or("The model did not answer")?;
    if code != 200 {
        return Err(format!("The model returned an error ({code})"));
    }
    let v: Value = serde_json::from_str(&raw).map_err(|_| "Unreadable reply from the model".to_string())?;
    let out = v["choices"][0]["message"]["content"].as_str().unwrap_or("");
    let out = regex::Regex::new(r"(?s)<think>.*?</think>").unwrap().replace_all(out, "");
    let out = out.trim();
    if out.is_empty() { Err("The model returned nothing".into()) } else { Ok(out.to_string()) }
}
