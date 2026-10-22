//! Cloud models. Two kinds of provider:
//! - `openai`: any OpenAI-compatible server (OpenRouter, nano-gpt, OpenAI, LM Studio on another PC...). Key in Credential Manager.
//! - `chatgpt`: the user's ChatGPT subscription, signed in the way the Codex CLI, pi and opencode do it
//!   (OAuth with PKCE against auth.openai.com, requests to the Codex Responses endpoint). Unofficial, opt-in, personal use.
//! Provider list lives in settings.json `cloudProviders`; nothing here runs unless the user adds a provider.
use crate::{creds, desktop, setup};
use base64::Engine;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH: &str = "https://auth.openai.com";
const REDIRECT: &str = "http://localhost:1455/auth/callback";
pub const CODEX_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const ORIGINATOR: &str = "localwork";
static REFRESH: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn settings() -> Value {
    std::fs::read_to_string(crate::paths::data_dir().join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(json!({}))
}

pub fn providers() -> Vec<Value> {
    settings()["cloudProviders"].as_array().cloned().unwrap_or_default()
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect::<Vec<_>>().join("&")
}

/// Plain http is allowed only to this PC or the local network; keys never cross the internet unencrypted.
fn url_ok(u: &reqwest::Url) -> bool {
    match u.scheme() {
        "https" => true,
        "http" => match u.host() {
            Some(url::Host::Domain(d)) => d == "localhost" || d.ends_with(".local"),
            Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        },
        _ => false,
    }
}

pub fn client() -> Result<reqwest::blocking::Client, String> {
    if setup::offline() {
        return Err(setup::OFFLINE_MSG.into());
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::blocking::Client::builder()
        .user_agent(concat!("LocalWORK/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

fn provider(id: &str) -> Option<Value> {
    providers().into_iter().find(|p| p["id"] == id)
}

fn key_name(id: &str) -> String {
    format!("cloud:{id}")
}

/// A resolved cloud target: `cloud:<provider>:<model>`.
pub struct Target {
    pub provider: String,
    pub kind: String,
    pub base: String,
    pub model: String,
    pub label: String,
}

pub fn resolve(target: &str) -> Option<Target> {
    let mut it = target.splitn(3, ':');
    if it.next()? != "cloud" {
        return None;
    }
    let (pid, model) = (it.next()?, it.next()?.trim().to_string());
    if model.is_empty() { return None; }
    if pid == "chatgpt" {
        // Resolving a saved choice must never refresh tokens or make a network request.
        let rec: Value = serde_json::from_str(&creds::get("chatgpt")?).ok()?;
        if rec["access"].as_str().filter(|s| !s.is_empty()).is_none() { return None; }
        if rec["account"].as_str().filter(|s| !s.is_empty()).is_none() { return None; }
        if rec["expires"].as_u64().unwrap_or(0) <= now() + 120 && rec["refresh"].as_str().filter(|s| !s.is_empty()).is_none() { return None; }
        return Some(Target { provider: pid.into(), kind: "chatgpt".into(), base: CODEX_URL.into(), label: format!("ChatGPT · {model}"), model });
    }
    let p = provider(pid)?;
    let base = p["baseUrl"].as_str()?.trim_end_matches('/');
    if !reqwest::Url::parse(base).ok().is_some_and(|u| url_ok(&u)) { return None; }
    Some(Target {
        provider: pid.into(),
        kind: "openai".into(),
        base: base.to_string(),
        label: format!("{} · {model}", p["name"].as_str().unwrap_or(pid)),
        model,
    })
}

/// Send an OpenAI chat/completions body to an `openai` provider. The caller streams the reply.
pub fn send_openai(t: &Target, body: &Value) -> Result<reqwest::blocking::Response, String> {
    let u = reqwest::Url::parse(&format!("{}/chat/completions", t.base)).map_err(|e| e.to_string())?;
    if !url_ok(&u) {
        return Err("Cloud providers must use https (plain http only on this PC or the local network).".into());
    }
    let mut r = client()?.post(u).json(body);
    if let Some(k) = creds::get(&key_name(&t.provider)) {
        r = r.bearer_auth(k);
    }
    r.send().map_err(|e| format!("Could not reach {}: {e}", t.label))
}

/// Send a Responses API body to the ChatGPT Codex endpoint.
pub fn send_chatgpt(body: &Value, session: &str) -> Result<reqwest::blocking::Response, String> {
    let (access, account) = chatgpt_tokens().ok_or("Sign in to ChatGPT again in Settings → Models → Cloud.")?;
    client()?
        .post(CODEX_URL)
        .bearer_auth(access)
        .header("chatgpt-account-id", account)
        .header("OpenAI-Beta", "responses=experimental")
        .header("originator", ORIGINATOR)
        .header("session_id", session)
        .header("Accept", "text/event-stream")
        .json(body)
        .send()
        .map_err(|e| format!("Could not reach ChatGPT: {e}"))
}

// ---------- ChatGPT sign-in ----------

fn jwt_claims(t: &str) -> Value {
    t.split('.')
        .nth(1)
        .and_then(|p| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(json!({}))
}

fn save_tokens(v: &Value, old_refresh: Option<&str>) -> Result<Value, String> {
    let access = v["access_token"].as_str().ok_or("ChatGPT did not return an access token.")?;
    let claims = jwt_claims(access);
    let account = claims["https://api.openai.com/auth"]["chatgpt_account_id"].as_str().unwrap_or_default();
    let email = jwt_claims(v["id_token"].as_str().unwrap_or_default())["email"].as_str().map(str::to_string);
    let rec = json!({
        "access": access,
        "refresh": v["refresh_token"].as_str().or(old_refresh),
        "expires": now() + v["expires_in"].as_u64().unwrap_or(3600),
        "account": account,
        "email": email,
    });
    creds::set("chatgpt", &rec.to_string())?;
    Ok(rec)
}

fn token_post(body: String) -> Result<Value, String> {
    let r = client()?
        .post(format!("{AUTH}/oauth/token"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .timeout(Duration::from_secs(30))
        .send()
        .map_err(|e| format!("Could not reach OpenAI sign-in: {e}"))?;
    let code = r.status().as_u16();
    let v: Value = r.json().unwrap_or(json!({}));
    if code != 200 {
        return Err(format!("OpenAI sign-in answered HTTP {code}: {}", v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("")));
    }
    Ok(v)
}

/// (access token, account id), refreshed when it is about to expire.
pub fn chatgpt_tokens() -> Option<(String, String)> {
    let _guard = REFRESH.lock().unwrap_or_else(|e| e.into_inner());
    let rec: Value = serde_json::from_str(&creds::get("chatgpt")?).ok()?;
    if rec["expires"].as_u64().unwrap_or(0) > now() + 120 {
        return Some((rec["access"].as_str()?.into(), rec["account"].as_str()?.into()));
    }
    let refresh = rec["refresh"].as_str()?;
    let v = token_post(form(&[("grant_type", "refresh_token"), ("refresh_token", refresh), ("client_id", CLIENT_ID)])).ok()?;
    let rec = save_tokens(&v, Some(refresh)).ok()?;
    Some((rec["access"].as_str()?.into(), rec["account"].as_str()?.into()))
}

fn wait_for_code(listener: std::net::TcpListener, state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(300);
    while Instant::now() < deadline {
        let Ok((mut s, _)) = listener.accept() else {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        };
        let _ = s.set_nonblocking(false);
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 4096];
        let n = s.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let path = req.split_whitespace().nth(1).unwrap_or("");
        if !path.starts_with("/auth/callback") {
            let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        }
        let q: std::collections::HashMap<String, String> = path
            .split_once('?')
            .map(|(_, q)| q)
            .unwrap_or("")
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .map(|(k, v)| (k.to_string(), decode(v)))
            .collect();
        let ok = q.get("state").map(String::as_str) == Some(state) && q.contains_key("code");
        let page = if ok { "Signed in. You can close this tab and go back to LocalWORK." } else { "Sign-in did not finish. Go back to LocalWORK and try again." };
        let html = format!("<!doctype html><meta charset=utf-8><title>LocalWORK</title><body style=\"font:16px system-ui;padding:40px\">{page}</body>");
        let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len()).as_bytes());
        if ok {
            return Ok(q["code"].clone());
        }
        return Err(q.get("error_description").or(q.get("error")).cloned().unwrap_or_else(|| "Sign-in was cancelled.".into()));
    }
    Err("Sign-in timed out after 5 minutes.".into())
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command(async)]
pub fn chatgpt_login() -> Result<Value, String> {
    if setup::offline() {
        return Err(setup::OFFLINE_MSG.into());
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:1455")
        .map_err(|_| "Port 1455 is busy (another app is signing in to ChatGPT). Close it and try again.".to_string())?;
    let mut rnd = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut rnd).map_err(|_| "no randomness")?;
    let verifier = b64(&rnd);
    let challenge = b64(ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()).as_ref());
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut rnd[..16]).map_err(|_| "no randomness")?;
    let state = b64(&rnd[..16]);
    let url = format!(
        "{AUTH}/oauth/authorize?{}",
        form(&[
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", REDIRECT),
            ("scope", "openid profile email offline_access"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("state", &state),
            ("originator", ORIGINATOR),
        ])
    );
    desktop::open_external_url(&url)?;
    let code = wait_for_code(listener, &state)?;
    let v = token_post(form(&[
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", &code),
        ("code_verifier", &verifier),
        ("redirect_uri", REDIRECT),
    ]))?;
    let rec = {
        let _guard = REFRESH.lock().unwrap_or_else(|e| e.into_inner());
        save_tokens(&v, None)?
    };
    let _ = chatgpt_models();
    Ok(json!({"signedIn": true, "email": rec["email"]}))
}

#[tauri::command(async)]
pub fn chatgpt_logout() {
    let _guard = REFRESH.lock().unwrap_or_else(|e| e.into_inner());
    creds::delete("chatgpt");
}

/// Ask the Codex backend for the models this subscription can use; remember them, or fall back to the saved list.
fn catalog_ids(v: &Value, codex: bool) -> Option<Vec<String>> {
    let list = v["models"].as_array().or(v["data"].as_array())?;
    let mut ids = Vec::new();
    for model in list {
        if codex && model["visibility"] == "hidden" { continue; }
        let id = model["slug"].as_str().or(model["id"].as_str()).or(model.as_str()).map(str::trim);
        if let Some(id) = id.filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)) {
            if !ids.iter().any(|existing| existing == id) { ids.push(id.to_string()); }
        }
    }
    Some(ids)
}

#[tauri::command(async)]
pub fn chatgpt_models() -> Vec<String> {
    let fetched = (|| {
        let (access, account) = chatgpt_tokens()?;
        let r = client()
            .ok()?
            .get("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0")
            .bearer_auth(access)
            .header("chatgpt-account-id", account)
            .header("originator", ORIGINATOR)
            .timeout(Duration::from_secs(20))
            .send()
            .ok()?;
        if r.status().as_u16() != 200 {
            return None;
        }
        let v: Value = r.json().ok()?;
        catalog_ids(&v, true)
    })();
    if let Some(ids) = fetched {
        let _ = setup::write_setting_value("chatgptModels", json!(ids));
        return ids;
    }
    settings()["chatgptModels"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .filter(|v: &Vec<String>| !v.is_empty())
        .unwrap_or_default()
}

// ---------- settings commands ----------

#[tauri::command(async)]
pub fn cloud_get() -> Value {
    let s = settings();
    let chatgpt = creds::get("chatgpt").and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let list: Vec<Value> = providers()
        .into_iter()
        .map(|mut p| {
            let id = p["id"].as_str().unwrap_or_default().to_string();
            p["hasKey"] = json!(creds::get(&key_name(&id)).is_some());
            p["visibleModels"] = s["cloudVisibleModels"][&id].clone();
            p
        })
        .collect();
    json!({
        "routing": s["routing"].as_str().unwrap_or("local"),
        "cloudDefault": s["cloudDefault"],
        "cloudVisibleModels": s["cloudVisibleModels"].as_object().cloned().unwrap_or_default(),
        "privacyGate": s["privacyGate"].as_str().unwrap_or("off"),
        "providers": list,
        "chatgpt": {
            "signedIn": chatgpt.is_some(),
            "email": chatgpt.as_ref().map(|c| c["email"].clone()),
            "models": s["chatgptModels"].as_array().cloned().unwrap_or_default(),
            "visibleModels": s["cloudVisibleModels"]["chatgpt"],
        },
    })
}

fn valid_visible_models(value: &Value, s: &Value) -> bool {
    let Some(map) = value.as_object() else { return false };
    map.iter().all(|(provider_id, selected)| {
        let catalog = if provider_id == "chatgpt" { Some(&s["chatgptModels"]) } else {
            s["cloudProviders"].as_array().and_then(|p| p.iter().find(|p| p["id"] == provider_id.as_str())).map(|p| &p["models"])
        };
        let Some(catalog) = catalog else { return false };
        selected.is_null() || selected.as_array().is_some_and(|ids| {
            ids.len() <= 1000 && ids.iter().all(|id| id.is_string() && catalog.as_array().is_some_and(|models| models.contains(id)))
        })
    })
}

/// Only these keys can be changed from the Cloud settings.
#[tauri::command(async)]
pub fn cloud_set(key: String, value: Value) -> Result<(), String> {
    if key == "routing" && value == "auto" && (crate::strata::setting("privacyGate", "off") != "on" || !crate::gate::installed()) {
        return Err("Install and enable the privacy filter before choosing Automatic routing.".into());
    }
    let ok = match key.as_str() {
        "routing" => matches!(value.as_str(), Some("local" | "manual" | "auto")),
        "privacyGate" => matches!(value.as_str(), Some("on" | "off")),
        "cloudDefault" => value.is_null() || value.as_str().is_some_and(|t| t.starts_with("cloud:")),
        "chatgptModels" => value.as_array().is_some_and(|a| a.iter().all(Value::is_string)),
        "cloudVisibleModels" => valid_visible_models(&value, &settings()),
        _ => false,
    };
    if !ok {
        return Err(format!("Not a cloud setting: {key}"));
    }
    setup::write_setting_value(&key, value)
}

#[tauri::command(async)]
pub fn cloud_provider_save(provider: Value, key: Option<String>) -> Result<Value, String> {
    let name = provider["name"].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or("Give the provider a name.")?;
    let base = provider["baseUrl"].as_str().map(|s| s.trim().trim_end_matches('/')).ok_or("Enter the server address.")?;
    let u = reqwest::Url::parse(base).map_err(|_| "That address is not a valid URL.".to_string())?;
    if !url_ok(&u) {
        return Err("Use https (plain http only on this PC or the local network).".into());
    }
    let id = provider["id"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| {
        let slug: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        format!("{}-{:04x}", slug.trim_matches('-'), rand::random::<u16>())
    });
    if id == "chatgpt" || id.contains(':') {
        return Err("Pick another name.".into());
    }
    let models: Vec<Value> = provider["models"].as_array().cloned().unwrap_or_default().into_iter().filter(Value::is_string).collect();
    let rec = json!({"id": id, "name": name, "kind": "openai", "baseUrl": base, "models": models});
    let mut list = providers();
    list.retain(|p| p["id"] != id.as_str());
    list.push(rec.clone());
    setup::write_setting_value("cloudProviders", json!(list))?;
    if let Some(k) = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        creds::set(&key_name(&id), &k)?;
    }
    Ok(rec)
}

#[tauri::command(async)]
pub fn cloud_provider_remove(id: String) -> Result<(), String> {
    let mut list = providers();
    list.retain(|p| p["id"] != id.as_str());
    creds::delete(&key_name(&id));
    let s = settings();
    if s["cloudDefault"].as_str().is_some_and(|t| t.starts_with(&format!("cloud:{id}:"))) {
        setup::write_setting_value("cloudDefault", Value::Null)?;
    }
    if let Some(mut visible) = s["cloudVisibleModels"].as_object().cloned() {
        visible.remove(&id);
        setup::write_setting_value("cloudVisibleModels", json!(visible))?;
    }
    setup::write_setting_value("cloudProviders", json!(list))
}

/// Fetch `/models` from an OpenAI-compatible provider and store the list on it.
#[tauri::command(async)]
pub fn cloud_models(id: String) -> Result<Vec<String>, String> {
    let p = provider(&id).ok_or("Unknown provider.")?;
    let base = p["baseUrl"].as_str().unwrap_or_default();
    let u = reqwest::Url::parse(&format!("{base}/models")).map_err(|e| e.to_string())?;
    if !url_ok(&u) {
        return Err("Use https.".into());
    }
    let mut r = client()?.get(u).timeout(Duration::from_secs(30));
    if let Some(k) = creds::get(&key_name(&id)) {
        r = r.bearer_auth(k);
    }
    let r = r.send().map_err(|e| format!("Could not connect: {e}"))?;
    let code = r.status().as_u16();
    if code != 200 {
        return Err(if code == 401 || code == 403 { "The key was refused.".into() } else { format!("The server answered HTTP {code}.") });
    }
    let v: Value = r.json().map_err(|e| format!("Unexpected reply: {e}"))?;
    let mut ids = catalog_ids(&v, false).ok_or("No model list in the reply.")?;
    ids.sort();
    let mut list = providers();
    for q in list.iter_mut().filter(|q| q["id"] == id.as_str()) {
        q["models"] = json!(ids);
    }
    setup::write_setting_value("cloudProviders", json!(list))?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_codex_and_compatible_catalog_shapes() {
        let codex = json!({"models": [
            {"slug": "gpt-example", "visibility": "list", "supported_in_api": false},
            {"slug": "hidden-model", "visibility": "hidden"},
            {"slug": "gpt-example"}, {"id": "id-fallback"}, {"slug": "  "}
        ]});
        assert_eq!(catalog_ids(&codex, true).unwrap(), ["gpt-example", "id-fallback"]);
        assert_eq!(catalog_ids(&json!({"data": [{"id":"model-a"}, "model-b", {"id":"model-a"}]}), false).unwrap(), ["model-a", "model-b"]);
        assert_eq!(catalog_ids(&json!({"models": []}), true), Some(vec![]));
        assert_eq!(catalog_ids(&json!({"error":"denied"}), true), None);
    }
    #[test]
    fn visible_selection_requires_known_provider_and_catalog_ids() {
        let s = json!({"chatgptModels":["one","two"], "cloudProviders":[{"id":"provider","models":["other"]}]});
        assert!(valid_visible_models(&json!({"chatgpt":["two"],"provider":[]}), &s));
        assert!(valid_visible_models(&json!({"chatgpt":null}), &s));
        assert!(!valid_visible_models(&json!({"chatgpt":["invented"]}), &s));
        assert!(!valid_visible_models(&json!({"unknown":[]}), &s));
        assert!(!valid_visible_models(&json!({"provider":[2]}), &s));
        assert!(!valid_visible_models(&json!([]), &s));
    }
    #[test]
    fn decodes_query() {
        assert_eq!(decode("a%20b+c%2F"), "a b c/");
        assert_eq!(decode("100%"), "100%");
    }
    #[test]
    fn http_only_local() {
        assert!(url_ok(&reqwest::Url::parse("http://127.0.0.1:1234/v1").unwrap()));
        assert!(url_ok(&reqwest::Url::parse("http://192.168.1.5/v1").unwrap()));
        assert!(!url_ok(&reqwest::Url::parse("http://example.com/v1").unwrap()));
        assert!(url_ok(&reqwest::Url::parse("https://openrouter.ai/api/v1").unwrap()));
    }
}
