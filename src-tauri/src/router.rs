//! Local-first router. When routing is "manual" or "auto", the agent talks to this proxy on 127.0.0.1 instead of
//! Strata, and each request is sent to the local model or a cloud model:
//! 1. Hard rules keep a chat local: offline mode, a chat kept offline, a chat locked as sensitive.
//! 2. A chat pinned to a model (`chat_model:<conv>`) uses it.
//! 3. "auto" starts local and moves to the default cloud model the way NVIDIA Switchyard escalates an agent:
//!    the prompt no longer fits the local window, the same tool error came back twice, or the local model is down.
//! Before anything goes to the cloud, the privacy filter (gate.rs) replaces personal data with placeholders such as
//! `[PERSON_1]` and puts the real values back in the reply. Every decision goes to logs/routing.jsonl.
use crate::{agent::Db, cloud, gate, paths, setup, store, strata, App};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

struct Router {
    port: u16,
    token: String,
    app: AppHandle,
    db: Db,
    strata: strata::Shared,
}

static ROUTER: OnceLock<Router> = OnceLock::new();
static REDACTORS: Mutex<Option<HashMap<String, gate::Redactor>>> = Mutex::new(None);
static LAST_SENT: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);

/// A chat whose documents look sensitive (health, finance, IDs) above this score stays local until the user unlocks it.
const SENSITIVE: f32 = 0.85;

pub fn routing() -> String {
    strata::setting("routing", "local")
}

/// Whether this chat has a usable cloud choice when the local engine is stopped.
/// Saved credentials are inspected without refreshing them or contacting a provider.
pub fn available(db: &Db, conv: Option<&str>) -> bool {
    if routing() == "local" || setup::offline() { return false; }
    if routing() == "auto" && !auto_privacy_ready() { return false; }
    let c = db.lock().unwrap();
    let pinned = if let Some(conv) = conv {
        if setup::chat_is_offline(&c, conv) || store::kv_get(&c, &format!("chat_lock:{conv}")).as_deref() == Some("1") { return false; }
        store::kv_get(&c, &format!("chat_model:{conv}"))
    } else { None };
    drop(c);
    match pinned.as_deref() {
        Some("local") => false,
        Some(t) if t.starts_with("cloud:") => cloud::resolve(t).is_some(),
        _ if routing() == "auto" => cloud::settings()["cloudDefault"].as_str().and_then(cloud::resolve).is_some(),
        _ => false,
    }
}

#[tauri::command(async)]
pub fn cloud_available(s: State<App>, conv: Option<String>) -> bool { available(&s.db, conv.as_deref()) }

pub fn start(app: &AppHandle, db: Db, st: strata::Shared) {
    let Ok(l) = TcpListener::bind("127.0.0.1:0") else { return };
    let Ok(addr) = l.local_addr() else { return };
    let token: String = (0..32).map(|_| format!("{:x}", rand::random::<u8>() & 15)).collect();
    if ROUTER.set(Router { port: addr.port(), token, app: app.clone(), db, strata: st }).is_err() {
        return;
    }
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            std::thread::spawn(move || {
                let _ = handle(s);
            });
        }
    });
}

/// Base URL and key the agent should use for this chat, or None to talk to Strata directly (routing "local").
pub fn endpoint(conv: &str) -> Option<(String, String)> {
    if routing() == "local" {
        return None;
    }
    let r = ROUTER.get()?;
    Some((format!("http://127.0.0.1:{}/c/{conv}/v1", r.port), r.token.clone()))
}

fn reply(s: &mut dyn Write, code: u16, body: &Value) {
    let b = body.to_string();
    let _ = write!(s, "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len());
}

fn err(s: &mut dyn Write, code: u16, msg: &str) {
    reply(s, code, &json!({"error": {"message": msg, "type": "localwork_router"}}));
}

fn handle(mut s: TcpStream) -> std::io::Result<()> {
    let r = ROUTER.get().unwrap();
    let mut rd = BufReader::new(s.try_clone()?);
    let mut line = String::new();
    rd.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let (mut len, mut auth) = (0usize, String::new());
    loop {
        let mut h = String::new();
        if rd.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => len = v.trim().parse().unwrap_or(0),
                "authorization" => auth = v.trim().to_string(),
                _ => {}
            }
        }
    }
    if auth != format!("Bearer {}", r.token) {
        err(&mut s, 401, "bad router token");
        return Ok(());
    }
    let mut body = vec![0u8; len.min(64 << 20)];
    rd.read_exact(&mut body)?;
    let Some(rest) = path.strip_prefix("/c/") else {
        err(&mut s, 404, "unknown path");
        return Ok(());
    };
    let (conv, sub) = rest.split_once("/v1/").unwrap_or((rest, ""));
    let conv = conv.to_string();
    if method != "POST" || sub != "chat/completions" {
        return forward_local(&mut s, &method, sub, body);
    }
    let Ok(req) = serde_json::from_slice::<Value>(&body) else {
        return forward_local(&mut s, &method, sub, body);
    };
    let (target, reason) = decide(r, &conv, &req);
    let Some(t) = target.as_deref().and_then(cloud::resolve) else {
        note(r, &conv, "local", "Local model", &reason, 0);
        return forward_local(&mut s, &method, sub, body);
    };
    match to_cloud(r, &mut s, &conv, &t, req, &reason) {
        Ok(()) => Ok(()),
        // Nothing reached the agent yet: in auto mode the local model answers instead.
        Err(e) if e.starts_with("Privacy:") || (routing() == "auto" && strata_ready(r)) => {
            note(r, &conv, "local", "Local model", &format!("cloud failed ({e}), stayed local"), 0);
            forward_local(&mut s, &method, sub, body)
        }
        Err(e) => {
            note(r, &conv, &t.provider, &t.label, &format!("error: {e}"), 0);
            err(&mut s, 502, &e);
            Ok(())
        }
    }
}

fn strata_ready(r: &Router) -> bool {
    r.strata.lock().unwrap().status.state == "ready"
}

fn decide(r: &Router, conv: &str, req: &Value) -> (Option<String>, String) {
    // Busy agents can retain their proxy endpoint after the setting changes.
    if routing() == "local" { return (None, "local only".into()); }
    if routing() == "auto" && !auto_privacy_ready() { return (None, "automatic cloud requires the installed, enabled privacy filter".into()); }
    let c = r.db.lock().unwrap();
    if setup::chat_is_offline(&c, conv) {
        return (None, "offline".into());
    }
    if store::kv_get(&c, &format!("chat_lock:{conv}")).as_deref() == Some("1") {
        return (None, "kept local: sensitive content".into());
    }
    let pinned = store::kv_get(&c, &format!("chat_model:{conv}"));
    drop(c);
    match pinned.as_deref() {
        Some(t) if t.starts_with("cloud:") => return (Some(t.into()), "chosen for this chat".into()),
        Some("local") => return (None, "chosen for this chat".into()),
        _ => {}
    }
    if routing() != "auto" {
        return (None, "local by default".into());
    }
    let Some(def) = cloud::settings()["cloudDefault"].as_str().map(str::to_string) else {
        return (None, "no default cloud model".into());
    };
    if !strata_ready(r) {
        return (Some(def), "local model not running".into());
    }
    let est = req.to_string().len() as u64 * 10 / 35;
    if est > strata::context_window() * 9 / 10 {
        return (Some(def), format!("prompt (~{est} tokens) too big for the local window"));
    }
    if repeated_tool_error(req) {
        return (Some(def), "the same tool error came back twice".into());
    }
    (None, "local can handle it".into())
}

fn auto_privacy_ready() -> bool { strata::setting("privacyGate", "off") == "on" && gate::installed() }

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn repeated_tool_error(req: &Value) -> bool {
    let tools: Vec<String> = req["messages"]
        .as_array()
        .map(|m| m.iter().filter(|x| x["role"] == "tool").map(|x| text_of(&x["content"])).collect())
        .unwrap_or_default();
    let n = tools.len();
    n >= 2 && tools[n - 1] == tools[n - 2] && tools[n - 1].to_lowercase().contains("error")
}

fn note(r: &Router, conv: &str, target: &str, label: &str, reason: &str, redacted: usize) {
    let rec = json!({"ts": store::now(), "conv": conv, "target": target, "label": label, "reason": reason, "redacted": redacted});
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(paths::data_dir().join("logs").join("routing.jsonl")) {
        let _ = writeln!(f, "{rec}");
    }
    let _ = r.app.emit("route", rec);
}

fn local_client() -> reqwest::blocking::Client {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::blocking::Client::builder().no_proxy().build().unwrap_or_default()
}

/// Pass the request to Strata unchanged and copy the reply back byte for byte.
fn forward_local(s: &mut TcpStream, method: &str, sub: &str, body: Vec<u8>) -> std::io::Result<()> {
    let r = ROUTER.get().unwrap();
    let (port, key) = {
        let g = r.strata.lock().unwrap();
        (g.status.port, g.key.clone())
    };
    let url = format!("http://127.0.0.1:{port}/v1/{sub}");
    let req = match method {
        "GET" => local_client().get(url),
        _ => local_client().post(url).header("Content-Type", "application/json").body(body),
    };
    match req.bearer_auth(key).send() {
        Ok(resp) => pipe(s, resp),
        Err(e) => {
            err(s, 502, &format!("The local model is not reachable: {e}"));
            Ok(())
        }
    }
}

fn pipe(s: &mut TcpStream, mut resp: reqwest::blocking::Response) -> std::io::Result<()> {
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
    write!(s, "HTTP/1.1 {} X\r\nContent-Type: {ct}\r\nConnection: close\r\n\r\n", resp.status().as_u16())?;
    std::io::copy(&mut resp, s)?;
    s.flush()
}

// ---------- cloud path ----------

/// Scan every text in the request; lock the chat if it is sensitive, otherwise replace personal data in place.
fn redact(r: &Router, conv: &str, req: &mut Value, red: &mut gate::Redactor) -> Result<bool, String> {
    validate_text_only(req)?;
    let safe = scan_values(req, red, &mut gate::scan)?;
    if !safe {
        store::kv_set(&r.db.lock().unwrap(), &format!("chat_lock:{conv}"), "1");
    }
    Ok(safe)
}

fn validate_text_only(req: &Value) -> Result<(), String> {
    let messages = req["messages"].as_array().ok_or("Unsupported message payload")?;
    for message in messages {
        match &message["content"] {
            Value::String(_) | Value::Null => {},
            Value::Array(parts) if parts.iter().all(|p| p["type"] == "text" && p["text"].is_string() && p.as_object().is_some_and(|o| o.keys().all(|k| k == "type" || k == "text"))) => {},
            _ => return Err("The privacy filter can inspect text only; attachments stay local.".into()),
        }
    }
    fn unsupported(v: &Value) -> bool {
        match v {
            Value::Object(o) => o.iter().any(|(k, v)| matches!(k.as_str(), "image_url" | "input_audio" | "audio" | "file" | "video_url") || unsupported(v)),
            Value::Array(a) => a.iter().any(unsupported),
            _ => false,
        }
    }
    if unsupported(req) { return Err("The privacy filter cannot inspect this attachment; it stays local.".into()); }
    Ok(())
}

/// Scan every outgoing string, including tool arguments, schemas and custom metadata.
fn scan_values(v: &mut Value, red: &mut gate::Redactor, scan: &mut impl FnMut(&str) -> Result<gate::Scan, String>) -> Result<bool, String> {
    scan_values_inner(v, red, scan, false)
}

fn scan_values_inner(v: &mut Value, red: &mut gate::Redactor, scan: &mut impl FnMut(&str) -> Result<gate::Scan, String>, identity: bool) -> Result<bool, String> {
    match v {
        Value::String(t) => {
            let result = scan(t)?;
            if result.sensitivity >= SENSITIVE || (identity && !result.spans.is_empty()) { return Ok(false); }
            *t = red.redact(t, &result.spans);
        },
        Value::Array(a) => for item in a { if !scan_values_inner(item, red, scan, identity)? { return Ok(false); } },
        Value::Object(o) => {
            // Property names can themselves contain personal data. Do not change protocol/schema identities.
            for (key, item) in o {
                let result = scan(key)?;
                if result.sensitivity >= SENSITIVE || !result.spans.is_empty() { return Ok(false); }
                let identity = identity || matches!(key.as_str(), "role" | "type" | "name" | "id" | "tool_call_id" | "enum" | "const" | "$ref" | "$id" | "format" | "pattern" | "required");
                if !scan_values_inner(item, red, scan, identity)? { return Ok(false); }
            }
        },
        _ => {},
    }
    Ok(true)
}

fn to_cloud(r: &Router, s: &mut TcpStream, conv: &str, t: &cloud::Target, mut req: Value, reason: &str) -> Result<(), String> {
    let gate_on = strata::setting("privacyGate", "off") == "on";
    if routing() == "local" || (routing() == "auto" && (!gate_on || !gate::installed())) {
        return Err("Privacy: the current routing settings require this request to stay local.".into());
    }
    let mut red = REDACTORS.lock().unwrap().get_or_insert_with(HashMap::new).remove(conv).unwrap_or_else(gate::Redactor::new);
    let result = (|| {
        if gate_on {
            if !gate::installed() {
                return Err("Privacy: the filter is on but not set up; keeping this request local.".to_string());
            }
            if !redact(r, conv, &mut req, &mut red).map_err(|e| format!("Privacy: {e}"))? {
                return Err("Privacy: this chat looks sensitive, so it stays on this PC.".to_string());
            }
        }
        let stream = req["stream"].as_bool().unwrap_or(false);
        {
            let c = r.db.lock().unwrap();
            if routing() == "local" || setup::chat_is_offline(&c, conv) || store::kv_get(&c, &format!("chat_lock:{conv}")).as_deref() == Some("1") {
                return Err("Privacy: this chat now requires local processing.".into());
            }
        }
        req["model"] = json!(t.model);
        if stream && t.kind != "chatgpt" { req["stream_options"] = json!({"include_usage": true}); }
        let sent = if t.kind == "chatgpt" { to_responses(&req, &t.model) } else { req.clone() };
        LAST_SENT.lock().unwrap().get_or_insert_with(HashMap::new).insert(conv.to_string(), json!({"target": t.label, "request": sent}));
        let resp = if t.kind == "chatgpt" {
            cloud::send_chatgpt(&sent, conv)?
        } else {
            cloud::send_openai(t, &sent)?
        };
        let code = resp.status().as_u16();
        if code != 200 {
            let body = resp.text().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["error"]["message"].as_str().or(v["detail"].as_str()).map(str::to_string));
            return Err(format!("{} answered HTTP {code}{}", t.label, msg.map(|m| format!(": {m}")).unwrap_or_default()));
        }
        note(r, conv, &t.provider, &t.label, reason, red.count());
        let mut out = Out::new(s, stream, &t.model, &red);
        if t.kind == "chatgpt" {
            from_responses(resp, &mut out);
        } else if stream {
            from_chat_stream(resp, &mut out);
        } else {
            let v: Value = resp.json().map_err(|e| e.to_string())?;
            let msg = &v["choices"][0]["message"];
            out.content(msg["content"].as_str().unwrap_or(""));
            for (i, c) in msg["tool_calls"].as_array().cloned().unwrap_or_default().iter().enumerate() {
                out.tool_start(i, c["id"].as_str().unwrap_or(""), c["function"]["name"].as_str().unwrap_or(""));
                out.tool_args(i, c["function"]["arguments"].as_str().unwrap_or(""));
            }
            out.usage = v["usage"].clone();
            if matches!(v["choices"][0]["finish_reason"].as_str(), Some("stop" | "tool_calls")) {
                out.finish(v["choices"][0]["finish_reason"].as_str());
            } else { out.abort("The cloud response ended before it completed. Retry the request."); }
        }
        Ok(())
    })();
    REDACTORS.lock().unwrap().get_or_insert_with(HashMap::new).insert(conv.to_string(), red);
    result
}

/// Writes chat.completion chunks (or one chat.completion when the agent did not ask to stream) back to the agent,
/// putting real values back in place of the privacy placeholders as text arrives.
struct Out<'a> {
    s: &'a mut dyn Write,
    stream: bool,
    model: String,
    red: &'a gate::Redactor,
    text: gate::StreamRestore<'a>,
    args: HashMap<usize, gate::StreamRestore<'a>>,
    started: bool,
    content: String,
    calls: Vec<Value>,
    usage: Value,
}

impl<'a> Out<'a> {
    fn new(s: &'a mut dyn Write, stream: bool, model: &str, red: &'a gate::Redactor) -> Self {
        Out { s, stream, model: model.into(), red, text: gate::StreamRestore::new(red), args: HashMap::new(), started: false, content: String::new(), calls: vec![], usage: Value::Null }
    }

    fn chunk(&mut self, delta: Value, finish: Option<&str>) {
        if !self.stream {
            return;
        }
        if !self.started {
            self.started = true;
            let _ = write!(self.s, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n");
        }
        let c = json!({"id": "chatcmpl-localwork", "object": "chat.completion.chunk", "created": store::now(), "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]});
        let _ = write!(self.s, "data: {c}\n\n");
        let _ = self.s.flush();
    }

    fn content(&mut self, d: &str) {
        let d = self.text.push(d);
        if d.is_empty() {
            return;
        }
        self.content.push_str(&d);
        self.chunk(json!({"role": "assistant", "content": d}), None);
    }

    fn reasoning(&mut self, d: &str) {
        self.chunk(json!({"reasoning_content": self.red.restore(d)}), None);
    }

    fn tool_start(&mut self, i: usize, id: &str, name: &str) {
        self.args.insert(i, gate::StreamRestore::new(self.red));
        while self.calls.len() <= i {
            self.calls.push(json!({"id": "", "type": "function", "function": {"name": "", "arguments": ""}}));
        }
        self.calls[i]["id"] = json!(id);
        self.calls[i]["function"]["name"] = json!(name);
        // Tool calls are withheld until the provider explicitly completes the response.
    }

    fn tool_args(&mut self, i: usize, d: &str) {
        let Some(sr) = self.args.get_mut(&i) else { return };
        let d = sr.push(d);
        self.emit_args(i, d);
    }

    fn emit_args(&mut self, i: usize, d: String) {
        if d.is_empty() {
            return;
        }
        let a = self.calls[i]["function"]["arguments"].as_str().unwrap_or("").to_string() + &d;
        self.calls[i]["function"]["arguments"] = json!(a);
    }

    fn finish(&mut self, reason: Option<&str>) {
        let rest = self.text.flush();
        if !rest.is_empty() {
            self.content.push_str(&rest);
            self.chunk(json!({"content": rest}), None);
        }
        let keys: Vec<usize> = self.args.keys().copied().collect();
        for i in keys {
            let d = self.args.get_mut(&i).map(|sr| sr.flush()).unwrap_or_default();
            self.emit_args(i, d);
        }
        let reason = reason.unwrap_or(if self.calls.is_empty() { "stop" } else { "tool_calls" }).to_string();
        if !self.calls.is_empty() && (reason != "tool_calls" || self.calls.iter().any(|c| {
            c["id"].as_str().unwrap_or("").is_empty()
                || c["function"]["name"].as_str().unwrap_or("").is_empty()
                || serde_json::from_str::<Value>(c["function"]["arguments"].as_str().unwrap_or("")).is_err()
        })) {
            self.abort("The cloud model returned an incomplete tool call. Retry the request.");
            return;
        }
        if self.stream {
            if reason == "tool_calls" {
                let calls: Vec<Value> = self.calls.iter().cloned().enumerate().map(|(i, mut c)| { c["index"] = json!(i); c }).collect();
                self.chunk(json!({"tool_calls": calls}), None);
            }
            self.chunk(json!({}), Some(&reason));
            if !self.usage.is_null() {
                let u = json!({"id": "chatcmpl-localwork", "object": "chat.completion.chunk", "created": store::now(), "model": self.model, "choices": [], "usage": self.usage});
                let _ = write!(self.s, "data: {u}\n\n");
            }
            if !self.started {
                return;
            }
            let _ = write!(self.s, "data: [DONE]\n\n");
            let _ = self.s.flush();
        } else {
            let mut msg = json!({"role": "assistant", "content": self.content});
            if !self.calls.is_empty() {
                msg["tool_calls"] = json!(self.calls);
            }
            let v = json!({"id": "chatcmpl-localwork", "object": "chat.completion", "created": store::now(), "model": self.model,
                "choices": [{"index": 0, "message": msg, "finish_reason": reason}], "usage": self.usage});
            reply(self.s, 200, &v);
        }
    }

    fn abort(&mut self, message: &str) {
        // No success finish marker, no executable tool calls, and no fallback after partial output.
        if self.stream {
            self.chunk(json!({"content": ""}), None);
            let error = json!({"error": {"message": message, "type": "incomplete_cloud_response"}});
            let _ = write!(self.s, "data: {error}\n\n");
            let _ = self.s.flush();
        } else { err(self.s, 502, message); }
    }
}

fn sse_events(resp: reqwest::blocking::Response, mut f: impl FnMut(Value) -> bool) {
    for line in BufReader::new(resp).lines() {
        let Ok(line) = line else { break };
        let Some(d) = line.strip_prefix("data:").map(str::trim) else { continue };
        if d == "[DONE]" {
            break;
        }
        if let Ok(v) = serde_json::from_str::<Value>(d) {
            if !f(v) {
                break;
            }
        }
    }
}

fn from_chat_stream(resp: reqwest::blocking::Response, out: &mut Out) {
    let mut finish: Option<String> = None;
    sse_events(resp, |v| {
        if !v["error"].is_null() { finish = None; return false; }
        if !v["usage"].is_null() {
            out.usage = v["usage"].clone();
        }
        let ch = &v["choices"][0];
        let d = &ch["delta"];
        if let Some(t) = d["reasoning_content"].as_str().or(d["reasoning"].as_str()) {
            out.reasoning(t);
        }
        if let Some(t) = d["content"].as_str() {
            out.content(t);
        }
        for c in d["tool_calls"].as_array().cloned().unwrap_or_default() {
            let i = c["index"].as_u64().unwrap_or(0) as usize;
            if let Some(id) = c["id"].as_str() {
                out.tool_start(i, id, c["function"]["name"].as_str().unwrap_or(""));
            }
            if let Some(a) = c["function"]["arguments"].as_str() {
                out.tool_args(i, a);
            }
        }
        if let Some(f) = ch["finish_reason"].as_str() {
            finish = Some(f.into());
        }
        true
    });
    if matches!(finish.as_deref(), Some("stop" | "tool_calls")) {
        out.finish(finish.as_deref());
    } else {
        out.abort("The cloud response ended before it completed. Retry the request.");
    }
}

/// chat/completions request → Responses API request for the ChatGPT Codex endpoint.
fn to_responses(req: &Value, model: &str) -> Value {
    let mut instructions = vec![];
    let mut input = vec![];
    for m in req["messages"].as_array().cloned().unwrap_or_default() {
        match m["role"].as_str().unwrap_or("") {
            "system" | "developer" => instructions.push(text_of(&m["content"])),
            "user" => {
                let parts: Vec<Value> = match &m["content"] {
                    Value::Array(a) => a
                        .iter()
                        .filter_map(|p| match p["type"].as_str() {
                            Some("text") => Some(json!({"type": "input_text", "text": p["text"]})),
                            Some("image_url") => Some(json!({"type": "input_image", "image_url": p["image_url"]["url"]})),
                            _ => None,
                        })
                        .collect(),
                    v => vec![json!({"type": "input_text", "text": text_of(v)})],
                };
                input.push(json!({"role": "user", "content": parts}));
            }
            "assistant" => {
                let t = text_of(&m["content"]);
                if !t.is_empty() {
                    input.push(json!({"role": "assistant", "content": [{"type": "output_text", "text": t}]}));
                }
                for c in m["tool_calls"].as_array().cloned().unwrap_or_default() {
                    input.push(json!({"type": "function_call", "call_id": c["id"], "name": c["function"]["name"], "arguments": c["function"]["arguments"]}));
                }
            }
            "tool" => input.push(json!({"type": "function_call_output", "call_id": m["tool_call_id"], "output": text_of(&m["content"])})),
            _ => {}
        }
    }
    let tools: Vec<Value> = req["tools"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|t| json!({"type": "function", "name": t["function"]["name"], "description": t["function"]["description"], "parameters": t["function"]["parameters"]}))
        .collect();
    json!({
        "model": model,
        "instructions": instructions.join("\n\n"),
        "input": input,
        "tools": tools,
        "tool_choice": "auto",
        "parallel_tool_calls": true,
        "store": false,
        "stream": true,
        "reasoning": {"effort": strata::setting("chatgptEffort", "medium"), "summary": "auto"},
    })
}

/// Responses API stream → chat.completion chunks.
fn from_responses(resp: reqwest::blocking::Response, out: &mut Out) {
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut got_args: HashMap<usize, bool> = HashMap::new();
    let mut failed: Option<String> = None;
    let mut completed = false;
    sse_events(resp, |v| {
        match v["type"].as_str().unwrap_or("") {
            "response.output_text.delta" => out.content(v["delta"].as_str().unwrap_or("")),
            "response.reasoning_summary_text.delta" => out.reasoning(v["delta"].as_str().unwrap_or("")),
            "response.output_item.added" if v["item"]["type"] == "function_call" => {
                let i = index.len();
                index.insert(v["item"]["id"].as_str().unwrap_or("").into(), i);
                out.tool_start(i, v["item"]["call_id"].as_str().unwrap_or(""), v["item"]["name"].as_str().unwrap_or(""));
            }
            "response.function_call_arguments.delta" => {
                if let Some(&i) = index.get(v["item_id"].as_str().unwrap_or("")) {
                    got_args.insert(i, true);
                    out.tool_args(i, v["delta"].as_str().unwrap_or(""));
                }
            }
            "response.output_item.done" if v["item"]["type"] == "function_call" => {
                if let Some(&i) = index.get(v["item"]["id"].as_str().unwrap_or("")) {
                    if !got_args.contains_key(&i) {
                        out.tool_args(i, v["item"]["arguments"].as_str().unwrap_or(""));
                    }
                }
            }
            "response.completed" => {
                if v["response"]["status"].as_str().is_some_and(|s| s != "completed") { return false; }
                completed = true;
                let u = &v["response"]["usage"];
                let (i, o) = (u["input_tokens"].as_u64().unwrap_or(0), u["output_tokens"].as_u64().unwrap_or(0));
                out.usage = json!({"prompt_tokens": i, "completion_tokens": o, "total_tokens": i + o});
                return false;
            }
            "response.failed" | "response.incomplete" | "error" => {
                failed = Some(v["response"]["error"]["message"].as_str().or(v["message"].as_str()).unwrap_or("ChatGPT stopped with an error.").to_string());
                return false;
            }
            _ => {}
        }
        true
    });
    if let Some(e) = failed {
        out.abort(&e);
    } else if completed {
        out.finish(None);
    } else {
        out.abort("ChatGPT disconnected before completing the response. Retry the request.");
    }
}

// ---------- commands ----------

#[tauri::command(async)]
pub fn route_mode_set(s: State<App>, mode: String) -> Result<(), String> {
    cloud::cloud_set("routing".into(), json!(mode))?;
    // Idle chats restart on their next message so they pick up the new endpoint.
    let idle: Vec<_> = s.agents.lock().unwrap().iter().filter(|(_, a)| !a.busy()).map(|(k, a)| (k.clone(), a.clone())).collect();
    for (k, a) in idle {
        s.agents.lock().unwrap().remove(&k);
        a.retire();
    }
    Ok(())
}

/// What this chat uses: `model` is "local", a `cloud:...` target, or null (follow the routing setting).
#[tauri::command(async)]
pub fn chat_route_get(s: State<App>, conv: String) -> Value {
    let c = s.db.lock().unwrap();
    json!({
        "routing": routing(),
        "model": store::kv_get(&c, &format!("chat_model:{conv}")),
        "locked": store::kv_get(&c, &format!("chat_lock:{conv}")).as_deref() == Some("1"),
        "offline": setup::chat_is_offline(&c, &conv),
    })
}

#[tauri::command(async)]
pub fn chat_route_set(s: State<App>, conv: String, model: Option<String>) -> Result<(), String> {
    if let Some(m) = &model {
        if m != "local" && cloud::resolve(m).is_none() {
            return Err("That cloud model is not set up.".into());
        }
    }
    store::kv_set(&s.db.lock().unwrap(), &format!("chat_model:{conv}"), model.as_deref().unwrap_or(""));
    Ok(())
}

#[tauri::command(async)]
pub fn chat_unlock(s: State<App>, conv: String) {
    store::kv_set(&s.db.lock().unwrap(), &format!("chat_lock:{conv}"), "0");
}

/// The last request this chat sent to a cloud model, as sent (placeholders in), plus the placeholder list.
#[tauri::command(async)]
pub fn route_last_sent(conv: String) -> Value {
    let sent = LAST_SENT.lock().unwrap().as_ref().and_then(|m| m.get(&conv).cloned());
    let pairs: Vec<Value> = REDACTORS
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(&conv))
        .map(|r| r.pairs().into_iter().map(|(t, v)| json!({"tag": t, "value": v})).collect())
        .unwrap_or_default();
    json!({"sent": sent, "placeholders": pairs})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn privacy_rejects_uninspectable_content() {
        assert!(validate_text_only(&json!({"messages": [{"content": [{"type": "image_url", "image_url": {"url": "data:private"}}]}]})).is_err());
        assert!(validate_text_only(&json!({"messages": [{"content": "hello", "audio": {"data": "private"}}]})).is_err());
        assert!(validate_text_only(&json!({"messages": [{"content": [{"type": "text", "text": "hello"}]}]})).is_ok());
    }
    #[test]
    fn privacy_scans_schema_metadata_and_sensitive_tool_arguments() {
        let mut req = json!({"messages": [{"content": "hello", "tool_calls": [{"function": {"arguments": "medical-record"}}]}]});
        let mut scanner = |t: &str| Ok(gate::Scan { spans: vec![], sensitivity: if t.contains("medical") { 1.0 } else { 0.0 } });
        assert!(!scan_values(&mut req, &mut gate::Redactor::new(), &mut scanner).unwrap());
        for req in [json!({"tools": [{"description": "medical-record"}]}), json!({"metadata": {"note": "medical-record"}})] {
            assert!(!scan_values(&mut req.clone(), &mut gate::Redactor::new(), &mut scanner).unwrap());
        }
    }
    #[test]
    fn privacy_scan_failure_propagates() {
        assert!(scan_values(&mut json!({"messages": ["private"]}), &mut gate::Redactor::new(), &mut |_| Err("helper failed".into())).is_err());
    }
    #[test]
    fn privacy_preserves_protocol_identities_or_keeps_them_local() {
        let mut scanner = |t: &str| Ok(gate::Scan { sensitivity: 0.0, spans: if t == "Ann" { vec![gate::Span { start: 0, end: 3, label: "PERSON".into(), score: 0.2 }] } else { vec![] } });
        for mut req in [json!({"function": {"name": "Ann"}}), json!({"tool_call_id": "Ann"}), json!({"parameters": {"enum": ["Ann"]}})] {
            assert!(!scan_values(&mut req, &mut gate::Redactor::new(), &mut scanner).unwrap());
            assert!(req.to_string().contains("Ann"));
        }
        let mut req = json!({"content": "Ann", "role": "user"});
        assert!(scan_values(&mut req, &mut gate::Redactor::new(), &mut scanner).unwrap());
        assert_eq!(req["content"], "[PERSON_1]");
        assert_eq!(req["role"], "user");
    }
    fn output_for(f: impl FnOnce(&mut Out)) -> String {
        let mut bytes = Vec::new();
        let red = gate::Redactor::new();
        f(&mut Out::new(&mut bytes, true, "model", &red));
        String::from_utf8(bytes).unwrap()
    }
    #[test]
    fn incomplete_response_never_exposes_a_tool_call() {
        let body = output_for(|out| { out.tool_start(0, "call", "delete"); out.tool_args(0, "{\"path\":"); out.abort("disconnected"); });
        assert!(!body.contains("tool_calls"));
        assert!(!body.contains("[DONE]"));
        assert!(body.contains("incomplete_cloud_response"));
    }
    #[test]
    fn completed_response_requires_valid_tool_arguments() {
        let body = output_for(|out| { out.tool_start(0, "call", "read"); out.tool_args(0, "{}"); out.finish(Some("tool_calls")); });
        assert!(body.contains("tool_calls"));
        assert!(body.contains("[DONE]"));
        let body = output_for(|out| { out.tool_start(0, "call", "read"); out.tool_args(0, "{"); out.finish(Some("tool_calls")); });
        assert!(!body.contains("tool_calls"));
        assert!(!body.contains("[DONE]"));
    }
    #[test]
    fn translates_tool_history() {
        let req = json!({"messages": [
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": null, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "read", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "ok"}
        ], "tools": [{"type": "function", "function": {"name": "read", "description": "d", "parameters": {"type": "object"}}}]});
        let r = to_responses(&req, "m");
        assert_eq!(r["instructions"], "be brief");
        assert_eq!(r["input"][1]["type"], "function_call");
        assert_eq!(r["input"][2]["type"], "function_call_output");
        assert_eq!(r["tools"][0]["name"], "read");
        assert_eq!(r["store"], false);
    }
    #[test]
    fn spots_repeated_errors() {
        let e = json!({"role": "tool", "content": "Error: file not found"});
        assert!(repeated_tool_error(&json!({"messages": [e.clone(), e]})));
        assert!(!repeated_tool_error(&json!({"messages": [{"role": "tool", "content": "fine"}, {"role": "tool", "content": "fine"}]})));
    }
}
