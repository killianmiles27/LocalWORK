//! Plugin store: lists the plugins in GitHub repositories the user adds as sources and installs one on
//! request. The official LocalWORK-plugins repository is the default source. Only GitHub hosts are
//! contacted, nothing runs during install, and offline mode blocks all of it.
use crate::{paths, plugins, setup};
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

pub const OFFICIAL: &str = "https://github.com/killianmiles27/LocalWORK-plugins";
const MAX_ZIP: u64 = 256 * 1024 * 1024;
const MAX_LISTED: usize = 200;

#[derive(Debug, PartialEq)]
pub struct Repo {
    pub owner: String,
    pub name: String,
    pub branch: Option<String>,
    pub sub: String,
}

impl Repo {
    pub fn url(&self) -> String {
        format!("https://github.com/{}/{}", self.owner, self.name)
    }
}

fn part_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// Accepts `owner/repo`, `https://github.com/owner/repo(.git)` and `.../tree/<branch>/<folder>`.
pub fn parse_repo(input: &str) -> Result<Repo, String> {
    let t = input.trim().trim_end_matches('/');
    let rest = t
        .strip_prefix("https://github.com/")
        .or_else(|| t.strip_prefix("http://github.com/"))
        .or_else(|| t.strip_prefix("github.com/"))
        .unwrap_or(t);
    if rest.contains("://") {
        return Err("Only GitHub repositories can be added, for example https://github.com/owner/repo.".into());
    }
    let parts: Vec<&str> = rest.split(['?', '#']).next().unwrap_or("").split('/').collect();
    if parts.len() < 2 {
        return Err("Enter a GitHub repository, for example https://github.com/owner/repo.".into());
    }
    let owner = parts[0].to_string();
    let name = parts[1].trim_end_matches(".git").to_string();
    if !part_ok(&owner) || !part_ok(&name) {
        return Err("That is not a valid GitHub owner/repository name.".into());
    }
    let (branch, sub) = match parts.get(2) {
        Some(&"tree") if parts.len() >= 4 => (Some(parts[3].to_string()), parts[4..].join("/")),
        None => (None, String::new()),
        _ => return Err("Use the repository link, or a link to a folder in it (…/tree/<branch>/<folder>).".into()),
    };
    if branch.as_deref().is_some_and(|b| !part_ok(b)) || !sub.split('/').filter(|s| !s.is_empty()).all(part_ok) {
        return Err("The branch or folder in that link has characters LocalWORK does not accept.".into());
    }
    Ok(Repo { owner, name, branch, sub })
}

fn client() -> Result<reqwest::blocking::Client, String> {
    if setup::OFFLINE.load(Ordering::Relaxed) {
        return Err("Offline mode is on. Turn it off in Settings to browse or install plugins.".into());
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::blocking::Client::builder()
        .user_agent(concat!("LocalWORK/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            let ok = a.url().scheme() == "https"
                && matches!(a.url().host_str(), Some("github.com" | "api.github.com" | "codeload.github.com" | "raw.githubusercontent.com" | "objects.githubusercontent.com"));
            if ok && a.previous().len() < 5 { a.follow() } else { a.stop() }
        }))
        .build()
        .map_err(|e| e.to_string())
}

fn get(c: &reqwest::blocking::Client, url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let r = c.get(url).header("Accept", "application/vnd.github+json").send().map_err(|e| format!("Could not reach GitHub: {e}"))?;
    let code = r.status().as_u16();
    if code == 404 {
        return Err("GitHub says that repository or file does not exist (or is private).".into());
    }
    if code == 403 || code == 429 {
        return Err("GitHub is rate-limiting requests from this PC. Try again in a while.".into());
    }
    if code != 200 {
        return Err(format!("GitHub answered HTTP {code}."));
    }
    let mut buf = Vec::new();
    r.take(limit + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > limit {
        return Err("The download is larger than LocalWORK accepts.".into());
    }
    Ok(buf)
}

fn get_json(c: &reqwest::blocking::Client, url: &str) -> Result<Value, String> {
    serde_json::from_slice(&get(c, url, 16 * 1024 * 1024)?).map_err(|e| format!("GitHub sent something that is not JSON: {e}"))
}

// ------------------------------------------------------------------------------------------ sources

pub fn sources() -> Vec<String> {
    let saved = std::fs::read_to_string(paths::data_dir().join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("pluginSources").and_then(Value::as_array).cloned());
    match saved {
        Some(list) => list.iter().filter_map(Value::as_str).map(String::from).collect(),
        None => vec![OFFICIAL.to_string()],
    }
}

pub fn set_sources(list: Vec<String>) -> Result<Vec<String>, String> {
    let mut clean: Vec<String> = Vec::new();
    for s in list {
        let r = parse_repo(&s)?;
        let mut u = r.url();
        if let Some(b) = &r.branch {
            u = format!("{u}/tree/{b}");
            if !r.sub.is_empty() {
                u = format!("{u}/{}", r.sub);
            }
        }
        if !clean.iter().any(|c| c.eq_ignore_ascii_case(&u)) {
            clean.push(u);
        }
    }
    setup::write_setting_value("pluginSources", json!(clean))?;
    Ok(clean)
}

// ------------------------------------------------------------------------------------------- browse

fn branch_of(c: &reqwest::blocking::Client, r: &Repo) -> Result<String, String> {
    if let Some(b) = &r.branch {
        return Ok(b.clone());
    }
    let info = get_json(c, &format!("https://api.github.com/repos/{}/{}", r.owner, r.name))?;
    Ok(info.get("default_branch").and_then(Value::as_str).unwrap_or("main").to_string())
}

/// Folders in the repo tree that hold a plugin.json, under the link's folder, at most three levels down.
pub fn plugin_dirs(tree: &Value, sub: &str) -> Vec<String> {
    let prefix = if sub.is_empty() { String::new() } else { format!("{}/", sub.trim_matches('/')) };
    let mut out: Vec<String> = tree
        .get("tree")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|e| e.get("type").and_then(Value::as_str) == Some("blob"))
                .filter_map(|e| e.get("path").and_then(Value::as_str))
                .filter_map(|p| p.strip_suffix("plugin.json"))
                .filter(|d| d.is_empty() || d.ends_with('/'))
                .map(|d| d.trim_end_matches('/').to_string())
                .filter(|d| (prefix.is_empty() || format!("{d}/").starts_with(&prefix)) && d.matches('/').count() < 3 + prefix.matches('/').count())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out.truncate(MAX_LISTED);
    out
}

/// The plugins one source offers, each marked new, installed, or update (a different installed version).
pub fn list(source: &str) -> Result<Value, String> {
    let r = parse_repo(source)?;
    let c = client()?;
    let branch = branch_of(&c, &r)?;
    let tree = get_json(&c, &format!("https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1", r.owner, r.name, branch))?;
    let installed: Vec<Value> = plugins::list_json();
    let mut items = Vec::new();
    for dir in plugin_dirs(&tree, &r.sub) {
        let file = if dir.is_empty() { "plugin.json".to_string() } else { format!("{dir}/plugin.json") };
        let raw = format!("https://raw.githubusercontent.com/{}/{}/{}/{}", r.owner, r.name, branch, file);
        let Ok(m) = get(&c, &raw, 1024 * 1024).and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string())) else { continue };
        let id = m.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let version = m.get("version").and_then(Value::as_str).unwrap_or("").to_string();
        let have = installed.iter().find(|p| p["id"] == id.as_str());
        let state = match have {
            None => "new",
            Some(p) if p["version"].as_str() == Some(version.as_str()) => "installed",
            Some(_) => "update",
        };
        let runs = m.get("contributes").and_then(|x| x.get("mcpServers")).is_some_and(|v| v.as_object().is_some_and(|o| !o.is_empty()));
        items.push(json!({
            "id": id, "dir": dir, "name": m.get("name").cloned().unwrap_or(json!(id)), "version": version,
            "description": m.get("description").cloned().unwrap_or(json!("")), "author": m.get("author").cloned().unwrap_or(Value::Null),
            "state": state, "installedVersion": have.map(|p| p["version"].clone()), "runsPrograms": runs,
        }));
    }
    Ok(json!({"source": r.url(), "branch": branch, "official": r.url().eq_ignore_ascii_case(OFFICIAL), "plugins": items}))
}

// ------------------------------------------------------------------------------------------ install

/// Download the repository once, then install the plugin folder `dir` from it like a local import.
pub fn install(source: &str, dir: &str) -> Result<Value, String> {
    let r = parse_repo(source)?;
    if !dir.split('/').filter(|s| !s.is_empty()).all(part_ok) {
        return Err("That plugin folder name is not accepted.".into());
    }
    let c = client()?;
    let branch = branch_of(&c, &r)?;
    let bytes = get(&c, &format!("https://codeload.github.com/{}/{}/zip/{}", r.owner, r.name, branch), MAX_ZIP)?;
    let n: u32 = rand::random();
    let work = std::env::temp_dir().join(format!("localwork-store-{n:08x}"));
    let result = (|| {
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let zip = work.join("repo.zip");
        std::fs::write(&zip, &bytes).map_err(|e| e.to_string())?;
        let out = work.join("x");
        plugins::unzip(&zip, &out)?;
        // GitHub wraps the repository in one top folder named <repo>-<branch>.
        let top: Vec<PathBuf> = std::fs::read_dir(&out).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        let [top] = top.as_slice() else { return Err("The repository download had an unexpected layout.".into()) };
        let src = dir.split('/').filter(|s| !s.is_empty()).fold(top.clone(), |p, s| p.join(s));
        if !src.join("plugin.json").is_file() {
            return Err(format!("No plugin.json in {dir} of that repository."));
        }
        plugins::import(&src.to_string_lossy())
    })();
    let _ = std::fs::remove_dir_all(&work);
    let mut v = result?;
    v["source"] = json!(r.url());
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_links() {
        assert_eq!(parse_repo("killianmiles27/LocalWORK-plugins").unwrap().url(), "https://github.com/killianmiles27/LocalWORK-plugins");
        let r = parse_repo("https://github.com/a/b.git/").unwrap();
        assert_eq!((r.owner.as_str(), r.name.as_str(), r.branch, r.sub.as_str()), ("a", "b", None, ""));
        let r = parse_repo("https://github.com/a/b/tree/main/plugins").unwrap();
        assert_eq!((r.branch.as_deref(), r.sub.as_str()), (Some("main"), "plugins"));
        assert!(parse_repo("https://evil.example/a/b").is_err());
        assert!(parse_repo("a").is_err());
        assert!(parse_repo("a/b/blob/main/x").is_err());
        assert!(parse_repo("a/../b").is_err());
        assert!(parse_repo("https://github.com/a/b/tree/main/../x").is_err());
    }

    #[test]
    fn finds_plugin_folders_in_a_tree() {
        let tree = json!({"tree": [
            {"type": "blob", "path": "README.md"},
            {"type": "blob", "path": "system-stats/plugin.json"},
            {"type": "blob", "path": "power-cost/plugin.json"},
            {"type": "blob", "path": "plugins/x/plugin.json"},
            {"type": "blob", "path": "a/b/c/d/plugin.json"},
            {"type": "blob", "path": "notplugin.json"},
            {"type": "tree", "path": "power-cost"}
        ]});
        assert_eq!(plugin_dirs(&tree, ""), ["plugins/x", "power-cost", "system-stats"]);
        assert_eq!(plugin_dirs(&tree, "plugins"), ["plugins/x"]);
        let root = json!({"tree": [{"type": "blob", "path": "plugin.json"}]});
        assert_eq!(plugin_dirs(&root, ""), [""]);
    }

    #[test]
    #[ignore = "Reaches GitHub; lists the official repo without installing anything"]
    fn lists_the_official_repo_live() {
        let v = list(OFFICIAL).unwrap();
        let ids: Vec<&str> = v["plugins"].as_array().unwrap().iter().filter_map(|p| p["id"].as_str()).collect();
        assert_eq!(v["official"], true);
        assert!(ids.len() >= 2, "{ids:?}");
    }
}
