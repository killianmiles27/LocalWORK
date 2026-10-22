//! Privacy gate: a CPU-only PII finder (perplexity-ai/PII-Tracer-GGUF, MIT) run through llama.cpp's llama-server.
//! Text is scanned locally before it goes to a cloud model; found spans become stable `[PERSON_1]` tags and are restored on the way back.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::paths::data_dir;
use crate::supervisor::{hidden, record, PidRec};

const HF: &str = "https://huggingface.co/perplexity-ai/PII-Tracer-GGUF/resolve/main/";
const MODEL: &str = "pplx-pii-masking-backbone-f16.gguf";
const HEADS: &str = "heads.safetensors";
const CONFIG: &str = "pii_head_config.json";
const CHUNK_CHARS: usize = 8000;
const CACHE_CAP: usize = 2000;

#[derive(Clone, Debug, PartialEq)]
pub struct Span { pub start: usize, pub end: usize, pub label: String, pub score: f32 }
#[derive(Clone, Debug)]
pub struct Scan { pub spans: Vec<Span>, pub sensitivity: f32 }

struct Helper { child: Child, port: u16 }
static HELPER: Mutex<Option<Helper>> = Mutex::new(None);
static CACHE: Mutex<Option<HashMap<u64, Scan>>> = Mutex::new(None);
static HEAD: OnceLock<Heads> = OnceLock::new();

fn gate_dir() -> PathBuf { data_dir().join("gate") }
fn model_path() -> PathBuf { gate_dir().join(MODEL) }
fn heads_path() -> PathBuf { gate_dir().join(HEADS) }
fn config_path() -> PathBuf { gate_dir().join(CONFIG) }

fn find_exe(dir: &Path) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_exe(&p) { return Some(f); }
        } else if p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("llama-server.exe")) {
            return Some(p);
        }
    }
    None
}
fn server_exe() -> Option<PathBuf> { find_exe(&gate_dir().join("llama")) }

pub fn installed() -> bool {
    model_path().exists() && heads_path().exists() && config_path().exists() && server_exe().is_some()
}

// ---------- safetensors + heads ----------

/// Parse a safetensors buffer into name -> (shape, f32 data). Only F32 tensors are supported.
fn parse_safetensors(buf: &[u8]) -> Result<HashMap<String, (Vec<usize>, Vec<f32>)>, String> {
    let n = u64::from_le_bytes(buf.get(..8).ok_or("heads file too short")?.try_into().unwrap()) as usize;
    let hdr = buf.get(8..8usize.checked_add(n).ok_or("bad header")?).ok_or("heads header truncated")?;
    let h: Value = serde_json::from_slice(hdr).map_err(|e| format!("heads header: {e}"))?;
    let data = &buf[8 + n..];
    let mut out = HashMap::new();
    for (k, v) in h.as_object().ok_or("heads header is not an object")? {
        let Some(dt) = v.get("dtype").and_then(|d| d.as_str()) else { continue };
        if dt != "F32" { return Err(format!("tensor {k} is {dt}, expected F32")); }
        let shape: Vec<usize> = v["shape"].as_array().ok_or("no shape")?.iter().filter_map(|x| x.as_u64().map(|x| x as usize)).collect();
        let off = v["data_offsets"].as_array().ok_or("no offsets")?;
        let (a, b) = (off.first().and_then(|x| x.as_u64()).ok_or("bad offsets")? as usize, off.get(1).and_then(|x| x.as_u64()).ok_or("bad offsets")? as usize);
        let raw = data.get(a..b).ok_or_else(|| format!("tensor {k} out of range"))?;
        if raw.len() != shape.iter().product::<usize>() * 4 { return Err(format!("tensor {k} size does not match its shape")); }
        out.insert(k.clone(), (shape, raw.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()));
    }
    Ok(out)
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind { O, B, I, E, S }

struct Heads { w: Vec<f32>, b: Vec<f32>, sw: Vec<f32>, sb: f32, hidden: usize, labels: Vec<(Kind, String)>, b_bias: f32, e_bias: f32 }

fn tag_name(t: &str) -> String {
    let t = t.strip_prefix("private_").unwrap_or(t);
    t.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect()
}

fn parse_label(l: &str) -> (Kind, String) {
    match l.split_once('-') {
        Some((p, t)) if p.len() == 1 => {
            let k = match p { "B" => Kind::B, "I" => Kind::I, "E" => Kind::E, "S" => Kind::S, _ => return (Kind::O, String::new()) };
            (k, tag_name(t))
        }
        _ => (Kind::O, String::new()),
    }
}

fn load_heads() -> Result<Heads, String> {
    let cfg: Value = serde_json::from_str(&std::fs::read_to_string(config_path()).map_err(|e| e.to_string())?).map_err(|e| format!("{CONFIG}: {e}"))?;
    let labels: Vec<(Kind, String)> = cfg["labels"].as_array().ok_or("config has no labels")?.iter().map(|l| parse_label(l.as_str().unwrap_or("O"))).collect();
    let hidden = cfg["hidden_size"].as_u64().unwrap_or(1024) as usize;
    let mut t = parse_safetensors(&std::fs::read(heads_path()).map_err(|e| e.to_string())?)?;
    let mut take = |k: &str, n: usize| -> Result<Vec<f32>, String> {
        let v = t.remove(k).ok_or_else(|| format!("heads file lacks {k}"))?.1;
        if v.len() != n { return Err(format!("{k} has {} values, expected {n}", v.len())); }
        Ok(v)
    };
    let (w, b) = (take("token_cls_head.weight", labels.len() * hidden)?, take("token_cls_head.bias", labels.len())?);
    let (sw, sb) = (take("sensitivity_head.weight", hidden)?, take("sensitivity_head.bias", 1)?);
    Ok(Heads { w, b, sw, sb: sb[0], hidden, labels, b_bias: cfg["viterbi_b_bias"].as_f64().unwrap_or(0.0) as f32, e_bias: cfg["viterbi_e_bias"].as_f64().unwrap_or(0.0) as f32 })
}

// ---------- decoding ----------

fn sigmoid(x: f32) -> f32 { 1.0 / (1.0 + (-x).exp()) }

fn allowed(a: &(Kind, String), b: &(Kind, String)) -> bool {
    match a.0 {
        Kind::O | Kind::E | Kind::S => matches!(b.0, Kind::O | Kind::B | Kind::S),
        Kind::B | Kind::I => matches!(b.0, Kind::I | Kind::E) && a.1 == b.1,
    }
}

/// Constrained BIOES Viterbi over per-token logits [T][L]. Returns the best label index per token.
fn viterbi(logits: &[Vec<f32>], labels: &[(Kind, String)], b_bias: f32, e_bias: f32) -> Vec<usize> {
    let (t, l) = (logits.len(), labels.len());
    if t == 0 { return vec![]; }
    const NEG: f32 = f32::NEG_INFINITY;
    let mut trans = vec![vec![NEG; l]; l];
    for i in 0..l {
        for j in 0..l {
            if allowed(&labels[i], &labels[j]) {
                trans[i][j] = (if labels[j].0 == Kind::B { b_bias } else { 0.0 }) + (if labels[i].0 == Kind::E { e_bias } else { 0.0 });
            }
        }
    }
    let mut score: Vec<f32> = (0..l).map(|j| if matches!(labels[j].0, Kind::O | Kind::B | Kind::S) { logits[0][j] } else { NEG }).collect();
    let mut back = vec![vec![0usize; l]; t];
    for k in 1..t {
        let mut next = vec![NEG; l];
        for j in 0..l {
            let (mut best, mut arg) = (NEG, 0);
            for i in 0..l {
                let s = score[i] + trans[i][j];
                if s > best { best = s; arg = i; }
            }
            next[j] = best + logits[k][j];
            back[k][j] = arg;
        }
        score = next;
    }
    let (mut best, mut cur) = (NEG, 0);
    for j in 0..l {
        if matches!(labels[j].0, Kind::O | Kind::E | Kind::S) && score[j] > best { best = score[j]; cur = j; }
    }
    let mut path = vec![0; t];
    for k in (0..t).rev() {
        path[k] = cur;
        if k > 0 { cur = back[k][cur]; }
    }
    path
}

/// Turn a label path into spans. `offs[k]` is the byte range of token k in `text`.
fn path_spans(text: &str, path: &[usize], logits: &[Vec<f32>], offs: &[(usize, usize)], labels: &[(Kind, String)]) -> Vec<Span> {
    let mut out = Vec::new();
    let mut k = 0;
    while k < path.len() {
        let (kind, ty) = &labels[path[k]];
        let first = k;
        match kind {
            Kind::S => k += 1,
            Kind::B => {
                k += 1;
                while k < path.len() && labels[path[k]].0 == Kind::I { k += 1; }
                if k < path.len() && labels[path[k]].0 == Kind::E { k += 1; }
            }
            _ => { k += 1; continue; }
        }
        let mean = (first..k).map(|i| logits[i][path[i]]).sum::<f32>() / (k - first) as f32;
        let (mut s, mut e) = (offs[first].0.min(text.len()), offs[k - 1].1.min(text.len()));
        while s > 0 && !text.is_char_boundary(s) { s -= 1; }
        while e < text.len() && !text.is_char_boundary(e) { e += 1; }
        if e <= s { continue; }
        let raw = &text[s..e];
        let lead = raw.len() - raw.trim_start().len();
        let trimmed = raw.trim();
        if trimmed.is_empty() { continue; }
        out.push(Span { start: s + lead, end: s + lead + trimmed.len(), label: ty.clone(), score: sigmoid(mean) });
    }
    out
}

// ---------- helper process ----------

fn install_hint() -> String { "The privacy filter is not installed. Install it in Settings first.".into() }

fn spawn_helper() -> Result<Helper, String> {
    if !installed() { return Err(install_hint()); }
    let exe = server_exe().ok_or_else(install_hint)?;
    let port = crate::http::free_port();
    let log = std::fs::OpenOptions::new().create(true).append(true).open(data_dir().join("logs").join("gate.log")).map_err(|e| e.to_string())?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;
    let mut c = Command::new(&exe);
    c.args(["-m", &model_path().to_string_lossy(), "--host", "127.0.0.1", "--port", &port.to_string(), "--embeddings", "--pooling", "none", "-c", "4096", "-b", "4096", "-ub", "4096", "-ngl", "0", "-t", "4"])
        .stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(log2));
    if let Some(d) = exe.parent() { c.current_dir(d); }
    hidden(&mut c);
    let mut child = c.spawn().map_err(|e| format!("Could not start the privacy filter: {e}"))?;
    record(&data_dir(), PidRec { pid: child.id(), exe: exe.to_string_lossy().into_owned(), role: "gate".into() });
    let t0 = Instant::now();
    loop {
        if let Ok(Some(st)) = child.try_wait() {
            return Err(format!("The privacy filter exited at start ({st}). See logs/gate.log."));
        }
        if crate::http::get(port, "/health", None, Duration::from_secs(2)).is_some_and(|(c, _)| c == 200) { break; }
        if t0.elapsed() > Duration::from_secs(60) {
            let _ = child.kill();
            return Err("The privacy filter did not become ready within 60 seconds.".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(Helper { child, port })
}

fn ensure(g: &mut Option<Helper>) -> Result<u16, String> {
    if let Some(h) = g.as_mut() {
        if matches!(h.child.try_wait(), Ok(None)) { return Ok(h.port); }
        *g = None;
    }
    let h = spawn_helper()?;
    let p = h.port;
    *g = Some(h);
    Ok(p)
}

pub fn stop() {
    if let Some(mut h) = HELPER.lock().unwrap_or_else(|e| e.into_inner()).take() {
        crate::supervisor::kill_tree(h.child.id());
        let _ = h.child.kill();
        let _ = h.child.wait();
        crate::supervisor::forget(&data_dir(), h.child.id());
    }
}

// ---------- scanning ----------

/// Byte ranges of each token in `text`, from /tokenize pieces. Special tokens that are not in the text get an empty range.
fn token_offsets(text: &str, toks: &Value) -> Result<Vec<(usize, usize)>, String> {
    let arr = toks["tokens"].as_array().ok_or("The tokenizer reply had no tokens.")?;
    let mut cur = 0;
    let mut out = Vec::with_capacity(arr.len());
    for t in arr {
        let piece: Vec<u8> = match &t["piece"] {
            Value::String(s) => s.clone().into_bytes(),
            Value::Array(a) => a.iter().map(|x| x.as_u64().and_then(|n| u8::try_from(n).ok()).ok_or("The tokenizer returned an invalid byte.")).collect::<Result<Vec<_>, _>>()?,
            _ => return Err("The tokenizer returned a token without a piece.".into()),
        };
        let rest = text.as_bytes().get(cur..).unwrap_or(&[]);
        let alt = String::from_utf8_lossy(&piece).replace('\u{2581}', " ").into_bytes();
        let n = if rest.starts_with(&piece) { piece.len() }
            else if rest.starts_with(&alt) { alt.len() }
            else if piece.first() == Some(&b'<') && piece.last() == Some(&b'>') { 0 }
            else { return Err("The tokenizer pieces do not match the scanned text.".into()); };
        out.push((cur, (cur + n).min(text.len())));
        cur = (cur + n).min(text.len());
    }
    if cur != text.len() { return Err("The tokenizer did not cover all scanned text.".into()); }
    Ok(out)
}

fn embed_rows(v: &Value) -> Result<Vec<Vec<f32>>, String> {
    let e = if v.is_array() { &v[0]["embedding"] } else { &v["embedding"] };
    let rows = e.as_array().ok_or("The embedding reply had no embedding.")?;
    rows.iter().map(|r| {
        r.as_array().ok_or_else(|| "The filter returned pooled embeddings, not per-token ones.".to_string())?
            .iter().map(|x| x.as_f64().map(|n| n as f32).filter(|n| n.is_finite()).ok_or_else(|| "The filter returned an invalid embedding value.".to_string())).collect()
    }).collect()
}

fn scan_chunk(g: &mut Option<Helper>, heads: &Heads, text: &str) -> Result<Scan, String> {
    let port = ensure(g)?;
    let body = json!({"content": text}).to_string();
    let post = |path: &str, b: &str| -> Result<Value, String> {
        let (c, r) = crate::http::post_json(port, path, None, b, Duration::from_secs(120)).ok_or("The privacy filter did not answer.")?;
        if c != 200 { return Err(format!("The privacy filter answered HTTP {c}.")); }
        serde_json::from_str(&r).map_err(|e| format!("Unexpected reply from the privacy filter: {e}"))
    };
    let h = post("/embeddings", &body)?;
    let toks = post("/tokenize", &json!({"content": text, "with_pieces": true}).to_string())?;
    let rows = embed_rows(&h)?;
    let offs = token_offsets(text, &toks)?;
    if rows.len() != offs.len() { return Err(format!("Token count mismatch ({} embeddings, {} tokens).", rows.len(), offs.len())); }
    if rows.is_empty() { return Ok(Scan { spans: vec![], sensitivity: 0.0 }); }
    let (d, l) = (heads.hidden, heads.labels.len());
    let mut mean = vec![0f32; d];
    let mut logits = Vec::with_capacity(rows.len());
    for r in &rows {
        if r.len() != d { return Err("Unexpected embedding size.".into()); }
        for (m, x) in mean.iter_mut().zip(r) { *m += x; }
        logits.push((0..l).map(|j| heads.b[j] + heads.w[j * d..(j + 1) * d].iter().zip(r).map(|(a, b)| a * b).sum::<f32>()).collect::<Vec<f32>>());
    }
    let n = rows.len() as f32;
    let sens = sigmoid(heads.sb + mean.iter().zip(&heads.sw).map(|(m, w)| m / n * w).sum::<f32>());
    let path = viterbi(&logits, &heads.labels, heads.b_bias, heads.e_bias);
    Ok(Scan { spans: path_spans(text, &path, &logits, &offs, &heads.labels), sensitivity: sens })
}

fn chunks(text: &str) -> Vec<(usize, &str)> {
    let mut out = vec![];
    let mut s = 0;
    while s < text.len() {
        let mut e = text[s..].char_indices().nth(CHUNK_CHARS).map(|(i, _)| s + i).unwrap_or(text.len());
        if e < text.len() {
            if let Some((w, ch)) = text[s..e].char_indices().rev().find(|(_, ch)| ch.is_whitespace()) { if w > 0 { e = s + w + ch.len_utf8(); } }
        }
        out.push((s, &text[s..e]));
        s = e;
    }
    out
}

fn hash(t: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    t.hash(&mut h);
    h.finish()
}

pub fn scan(text: &str) -> Result<Scan, String> {
    if text.trim().is_empty() { return Ok(Scan { spans: vec![], sensitivity: 0.0 }); }
    let key = hash(text);
    if let Some(s) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|c| c.get(&key)) { return Ok(s.clone()); }
    if HEAD.get().is_none() {
        let _ = HEAD.set(load_heads()?);
    }
    let heads = HEAD.get().ok_or("heads not loaded")?;
    let mut g = HELPER.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = Scan { spans: vec![], sensitivity: 0.0 };
    for (off, c) in chunks(text) {
        if c.trim().is_empty() { continue; }
        let r = scan_chunk(&mut g, heads, c).map_err(|e| {
            if let Some(mut h) = g.take() { let _ = h.child.kill(); let _ = h.child.wait(); }
            e
        })?;
        all.sensitivity = all.sensitivity.max(r.sensitivity);
        all.spans.extend(r.spans.into_iter().map(|s| Span { start: s.start + off, end: s.end + off, ..s }));
    }
    drop(g);
    let mut c = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let m = c.get_or_insert_with(HashMap::new);
    if m.len() >= CACHE_CAP { m.clear(); }
    m.insert(key, all.clone());
    Ok(all)
}

// ---------- redaction ----------

#[derive(Default)]
pub struct Redactor { by_val: HashMap<String, String>, by_tag: HashMap<String, String>, order: Vec<String>, counters: HashMap<String, usize> }

fn tag_re() -> &'static regex::Regex {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"\[[A-Z0-9_]+_\d+\]").unwrap())
}

impl Redactor {
    pub fn new() -> Self { Self::default() }

    pub fn redact(&mut self, text: &str, spans: &[Span]) -> String {
        // Viterbi already selects entities; an extra sigmoid threshold can drop valid PII.
        let mut sp: Vec<&Span> = spans.iter().filter(|s| s.start < s.end && s.end <= text.len() && text.is_char_boundary(s.start) && text.is_char_boundary(s.end)).collect();
        sp.sort_by_key(|s| (s.start, std::cmp::Reverse(s.end)));
        let (mut out, mut pos) = (String::with_capacity(text.len()), 0);
        for s in sp {
            if s.start < pos { continue; }
            let val = &text[s.start..s.end];
            let tag = match self.by_val.get(val) {
                Some(t) => t.clone(),
                None => {
                    let n = self.counters.entry(s.label.clone()).or_insert(0);
                    *n += 1;
                    let t = format!("[{}_{}]", s.label, n);
                    self.by_val.insert(val.to_string(), t.clone());
                    self.by_tag.insert(t.clone(), val.to_string());
                    self.order.push(t.clone());
                    t
                }
            };
            out.push_str(&text[pos..s.start]);
            out.push_str(&tag);
            pos = s.end;
        }
        out.push_str(&text[pos..]);
        out
    }

    pub fn restore(&self, text: &str) -> String {
        tag_re().replace_all(text, |c: &regex::Captures| self.by_tag.get(&c[0]).cloned().unwrap_or_else(|| c[0].to_string())).into_owned()
    }

    pub fn count(&self) -> usize { self.order.len() }

    pub fn pairs(&self) -> Vec<(String, String)> {
        self.order.iter().map(|t| (t.clone(), self.by_tag[t].clone())).collect()
    }
}

pub struct StreamRestore<'a> { r: &'a Redactor, buf: String }

impl<'a> StreamRestore<'a> {
    pub fn new(r: &'a Redactor) -> Self { Self { r, buf: String::new() } }

    pub fn push(&mut self, delta: &str) -> String {
        self.buf.push_str(delta);
        let hold = match self.buf.rfind('[') {
            Some(i) => {
                let t = &self.buf[i + 1..];
                if t.len() < 32 && t.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') { i } else { self.buf.len() }
            }
            None => self.buf.len(),
        };
        let ready: String = self.buf.drain(..hold).collect();
        self.r.restore(&ready)
    }

    pub fn flush(&mut self) -> String {
        let all = std::mem::take(&mut self.buf);
        self.r.restore(&all)
    }
}

// ---------- commands ----------

#[tauri::command(async)]
pub fn gate_status() -> Value {
    let running = HELPER.try_lock().map(|mut g| g.as_mut().is_some_and(|h| matches!(h.child.try_wait(), Ok(None)))).unwrap_or(true);
    json!({
        "installed": installed(),
        "running": running,
        "enabled": crate::strata::setting("privacyGate", "off") == "on",
        "downloadMb": 1250,
        "files": {"llama": 30, "model": 1200, "heads": 1, "config": 1},
    })
}

#[tauri::command(async)]
pub fn gate_install(app: tauri::AppHandle) -> Result<(), String> {
    crate::download::stage(&app, "gate-install", "resolving", "Finding the privacy filter runtime…");
    let result = install_filter(&app);
    match &result {
        Ok(()) => crate::download::stage(&app, "gate-install", "done", "Privacy filter installed."),
        Err(error) => crate::download::stage(&app, "gate-install", "error", error),
    }
    result
}

fn cpu_asset(release: &Value) -> Option<String> {
    release["assets"].as_array()?.iter().find_map(|a| {
        let name = a["name"].as_str()?;
        (name.starts_with("llama-") && name.ends_with("bin-win-cpu-x64.zip"))
            .then(|| a["browser_download_url"].as_str().map(str::to_string)).flatten()
    })
}

fn nightly_tag(marker: &str) -> Option<&str> {
    let tag = marker.trim();
    (tag.starts_with('b') && tag.len() > 1 && tag[1..].bytes().all(|b| b.is_ascii_digit())).then_some(tag)
}

fn runtime_url() -> Result<String, String> {
    resolve_runtime(|url| crate::download::json(url, None), crate::download::text)
}

fn resolve_runtime(get_json: impl Fn(&str) -> Result<Value, String>, get_text: impl Fn(&str) -> Result<String, String>) -> Result<String, String> {
    let base = "https://api.github.com/repos/ggml-org/llama.cpp/releases";
    let latest = get_json(&format!("{base}/latest"))?;
    if let Some(url) = cpu_asset(&latest) { return Ok(url); }
    // Stable releases now publish a tiny pointer to the nightly containing their binaries.
    let marker = latest["assets"].as_array().into_iter().flatten()
        .find(|a| a["name"] == "nightly-tag.txt")
        .and_then(|a| a["browser_download_url"].as_str());
    if let Some(marker) = marker {
        if let Ok(text) = get_text(marker) {
            if let Some(tag) = nightly_tag(&text) {
                if let Ok(release) = get_json(&format!("{base}/tags/{tag}")) {
                    if let Some(url) = cpu_asset(&release) { return Ok(url); }
                }
            }
        }
    }
    // Bounded fallback for an incomplete stable release or a missing marker.
    let releases = get_json(&format!("{base}?per_page=10"))?;
    releases.as_array().into_iter().flatten().filter(|r| r["draft"] != true)
        .find_map(cpu_asset).ok_or_else(|| "No Windows x64 CPU runtime was found in recent llama.cpp releases. Try again later.".into())
}

fn install_filter(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = gate_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if server_exe().is_none() {
        let url = runtime_url()?;
        let zip = dir.join("llama.zip");
        crate::download::stage(app, "gate-install", "downloading", "Downloading CPU runtime (1 of 4)…");
        crate::download::fetch(app, "gate-llama", &url, &zip, None)?;
        let out = dir.join("llama");
        let _ = std::fs::remove_dir_all(&out);
        crate::download::stage(app, "gate-install", "extracting", "Extracting CPU runtime…");
        unzip(&zip, &out)?;
        let _ = std::fs::remove_file(&zip);
        if server_exe().is_none() { return Err("The llama.cpp download did not contain llama-server.exe.".into()); }
    }
    for (index, (id, f)) in [("gate-config", CONFIG), ("gate-heads", HEADS), ("gate-model", MODEL)].into_iter().enumerate() {
        let p = dir.join(f);
        if !p.exists() {
            crate::download::stage(app, "gate-install", "downloading", &format!("Downloading privacy filter ({} of 4)…", index + 2));
            crate::download::fetch(app, id, &format!("{HF}{f}"), &p, None)?;
        }
    }
    Ok(())
}

fn unzip(zip: &Path, out: &Path) -> Result<(), String> {
    let mut a = zip::ZipArchive::new(std::fs::File::open(zip).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    for i in 0..a.len() {
        let mut f = a.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name() else { continue };
        let dest = out.join(rel);
        if f.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = dest.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
            let mut w = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn gate_test(text: String) -> Result<Value, String> {
    let s = scan(&text)?;
    let masked = Redactor::new().redact(&text, &s.spans);
    let spans: Vec<Value> = s.spans.iter().map(|p| json!({"start": p.start, "end": p.end, "label": p.label, "score": p.score, "text": &text[p.start..p.end]})).collect();
    Ok(json!({"sensitivity": s.sensitivity, "spans": spans, "masked": masked}))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_windows_x64_cpu_runtime_assets() {
        let release = json!({"assets":[
            {"name":"llama-b11669-bin-win-cpu-arm64.zip","browser_download_url":"wrong-arm"},
            {"name":"llama-b11669-bin-win-cuda-13.4-x64.zip","browser_download_url":"wrong-gpu"},
            {"name":"llama-b11669-bin-win-cpu-x64.zip","browser_download_url":"correct"}
        ]});
        assert_eq!(cpu_asset(&release), Some("correct".into()));
        assert_eq!(cpu_asset(&json!({"assets":[{"name":"nightly-tag.txt"}]})), None);
        assert_eq!(cpu_asset(&json!({})), None);
        assert_eq!(nightly_tag("b11669\n"), Some("b11669"));
        for invalid in ["", "b", "../b11669", "b123?x=1", "https://example.com", "b12\n34"] {
            assert_eq!(nightly_tag(invalid), None);
        }
    }

    #[test]
    fn resolves_stable_release_marker_and_bounded_fallback() {
        let stable = json!({"tag_name":"v0.7.0", "assets":[{"name":"nightly-tag.txt", "browser_download_url":"https://github.com/ggml-org/llama.cpp/releases/download/v0.7.0/nightly-tag.txt"}]});
        let nightly = json!({"tag_name":"b11669", "assets":[{"name":"llama-b11669-bin-win-cpu-x64.zip", "browser_download_url":"cpu-runtime"}]});
        let result = resolve_runtime(|url| {
            if url.ends_with("/latest") { Ok(stable.clone()) }
            else if url.ends_with("/tags/b11669") { Ok(nightly.clone()) }
            else { panic!("Unexpected metadata request: {url}") }
        }, |_| Ok("b11669\n".into()));
        assert_eq!(result.unwrap(), "cpu-runtime");
        let result = resolve_runtime(|url| {
            if url.ends_with("/latest") { Ok(stable.clone()) }
            else if url.ends_with("?per_page=10") { Ok(json!([{"draft":true,"assets":nightly["assets"]},nightly])) }
            else { panic!("Unexpected metadata request: {url}") }
        }, |_| Ok("../../invalid".into()));
        assert_eq!(result.unwrap(), "cpu-runtime");
        assert!(resolve_runtime(|_| Ok(json!([])), |_| Err("missing".into())).is_err());
        assert_eq!(resolve_runtime(|_| Err("offline".into()), |_| unreachable!()), Err("offline".into()));
    }

    fn labels() -> Vec<(Kind, String)> {
        ["O", "B-private_person", "I-private_person", "E-private_person", "S-private_person", "S-private_email"].iter().map(|l| parse_label(l)).collect()
    }
    fn onehot(path: &[usize], n: usize) -> Vec<Vec<f32>> {
        path.iter().map(|&p| (0..n).map(|j| if j == p { 5.0 } else { 0.0 }).collect()).collect()
    }

    #[test]
    fn viterbi_follows_constraints() {
        let l = labels();
        // tokens: O B I E O S-email
        let lg = onehot(&[0, 1, 2, 3, 0, 5], 6);
        assert_eq!(viterbi(&lg, &l, 0.0, 0.0), vec![0, 1, 2, 3, 0, 5]);
        // an invalid I right after O (strongest) must be repaired into a legal path
        let lg = onehot(&[0, 2, 0], 6);
        let p = viterbi(&lg, &l, 0.0, 0.0);
        assert!(matches!(l[p[0]].0, Kind::O | Kind::B | Kind::S));
        assert!(matches!(l[p[2]].0, Kind::O | Kind::E | Kind::S));
        for w in p.windows(2) { assert!(allowed(&l[w[0]], &l[w[1]])); }
        // a trailing B cannot end the path
        let p = viterbi(&onehot(&[0, 1], 6), &l, 0.0, 0.0);
        assert!(matches!(l[p[1]].0, Kind::O | Kind::E | Kind::S));
    }

    #[test]
    fn spans_trimmed_and_offset() {
        let l = labels();
        let text = "Hi John Smith ok";
        let offs = [(0, 2), (2, 7), (7, 13), (13, 16)];
        let lg = onehot(&[0, 1, 3, 0], 6);
        let path = viterbi(&lg, &l, 0.0, 0.0);
        let sp = path_spans(text, &path, &lg, &offs, &l);
        assert_eq!(sp.len(), 1);
        assert_eq!(&text[sp[0].start..sp[0].end], "John Smith");
        assert_eq!(sp[0].label, "PERSON");
        assert!(sp[0].score > 0.99);
    }

    #[test]
    fn redactor_is_stable_and_restores() {
        let mut r = Redactor::new();
        let t = "Mail Ann and Bob; Ann again";
        let sp = |s: &str, n: usize| { let a = t.find(s).unwrap(); Span { start: a, end: a + s.len(), label: "PERSON".into(), score: n as f32 } };
        let spans = vec![sp("Ann", 1), sp("Bob", 1), Span { start: 18, end: 21, label: "PERSON".into(), score: 0.2 }];
        let m = r.redact(t, &spans);
        assert_eq!(m, "Mail [PERSON_1] and [PERSON_2]; [PERSON_1] again");
        assert_eq!(r.count(), 2);
        assert_eq!(r.restore(&m), t);
        assert_eq!(r.pairs()[1], ("[PERSON_2]".to_string(), "Bob".to_string()));
        assert_eq!(r.restore("[PERSON_9]"), "[PERSON_9]");
    }

    #[test]
    fn stream_restore_handles_split_tags() {
        let mut r = Redactor::new();
        let t = "Ann";
        r.redact(t, &[Span { start: 0, end: 3, label: "PERSON".into(), score: 1.0 }]);
        let mut s = StreamRestore::new(&r);
        let mut out = String::new();
        for d in ["Hi [PER", "SON_", "1] and [", "x", "] done ["] { out += &s.push(d); }
        out += &s.flush();
        assert_eq!(out, "Hi Ann and [x] done [");
    }

    #[test]
    fn safetensors_roundtrip() {
        let hdr = r#"{"a":{"dtype":"F32","shape":[2,2],"data_offsets":[0,16]},"b":{"dtype":"F32","shape":[1],"data_offsets":[16,20]},"__metadata__":{"x":"y"}}"#;
        let mut buf = (hdr.len() as u64).to_le_bytes().to_vec();
        buf.extend_from_slice(hdr.as_bytes());
        for f in [1.0f32, 2.0, 3.0, 4.0, -0.5] { buf.extend_from_slice(&f.to_le_bytes()); }
        let t = parse_safetensors(&buf).unwrap();
        assert_eq!(t["a"].0, vec![2, 2]);
        assert_eq!(t["a"].1, vec![1.0, 2.0, 3.0, 4.0]);
        assert_eq!(t["b"].1, vec![-0.5]);
        assert!(parse_safetensors(&buf[..20]).is_err());
    }

    #[test]
    fn chunking_splits_on_whitespace() {
        let t = "word ".repeat(5000);
        let c = chunks(&t);
        assert!(c.len() > 2);
        assert_eq!(c.iter().map(|x| x.1).collect::<String>(), t);
    }
    #[test]
    fn chunking_respects_unicode_whitespace_boundaries() {
        let t = "a\u{3000}".repeat(9000);
        assert_eq!(chunks(&t).iter().map(|x| x.1).collect::<String>(), t);
    }
    #[test]
    fn tokenizer_mismatch_fails_closed() {
        assert!(token_offsets("private", &json!({"tokens": [{"piece": "wrong"}]})).is_err());
        assert!(token_offsets("private", &json!({"tokens": [{"piece": "pri"}]})).is_err());
        assert_eq!(token_offsets("private", &json!({"tokens": [{"piece": "pri"}, {"piece": "vate"}]})).unwrap(), vec![(0, 3), (3, 7)]);
    }
}
