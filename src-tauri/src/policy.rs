//! Approval policy. Classes: read, write, exec, destructive (+ escalation outside the workspace).
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    Read,
    Write,
    Exec,
    Destructive,
}

pub enum Decision {
    Allow,
    Ask { class: Class, reason: String, can_remember: bool },
    Deny(String),
}

fn norm(p: &str) -> PathBuf {
    let mut s = p.replace('/', "\\");
    if s.starts_with("\\\\?\\") {
        s = s[4..].to_string();
    }
    PathBuf::from(s)
}

fn inside(path: &Path, root: &Path) -> bool {
    let a = path.to_string_lossy().to_lowercase();
    let b = root.to_string_lossy().trim_end_matches('\\').to_lowercase();
    a == b || a.starts_with(&format!("{b}\\"))
}

fn arg_path(args: &Value, workspace: &Path) -> Option<PathBuf> {
    for k in ["file_path", "path", "filePath", "output", "file"] {
        if let Some(s) = args.get(k).and_then(|v| v.as_str()) {
            let p = norm(s);
            return Some(if p.is_absolute() { p } else { workspace.join(p) });
        }
    }
    None
}

const PROTECTED: &[&str] = &["c:\\windows", "c:\\program files", "c:\\programdata"];

pub fn decide(tool: &str, category: &str, args: &Value, workspace: &Path, auto_edit: bool, remembered: &[String]) -> Decision {
    if tool == "Spawn" {
        return Decision::Deny("Sub-agents are disabled in this app".into());
    }
    let workspace = &norm(&workspace.to_string_lossy());
    let path = arg_path(args, workspace);
    if let Some(p) = &path {
        let l = p.to_string_lossy().to_lowercase();
        if PROTECTED.iter().any(|x| l.starts_with(x)) || l.contains("\\appdata\\local\\workbench") {
            return Decision::Deny(format!("{} is a protected location", p.display()));
        }
    }
    let outside = path.as_ref().map(|p| !inside(p, workspace)).unwrap_or(false);
    let remembered_hit = remembered.iter().any(|t| t == tool);
    match category {
        "info" => {
            if outside {
                Decision::Ask { class: Class::Read, reason: "Read outside the workspace".into(), can_remember: false }
            } else {
                Decision::Allow
            }
        }
        "edit" => {
            if outside {
                Decision::Ask { class: Class::Write, reason: "Write outside the workspace".into(), can_remember: false }
            } else if auto_edit || remembered_hit {
                Decision::Allow
            } else {
                Decision::Ask { class: Class::Write, reason: "Change a file in the workspace".into(), can_remember: true }
            }
        }
        "exec" => exec_decision(args, workspace, auto_edit),
        _ => mcp_decision(tool, args, auto_edit, remembered_hit, outside),
    }
}

fn exec_decision(args: &Value, workspace: &Path, auto_edit: bool) -> Decision {
    let cmd = args.get("command").or_else(|| args.get("cmd")).and_then(|v| v.as_str()).unwrap_or("");
    let destructive = Regex::new(
        r"(?i)(\brm\s+-[a-z]*[rf]|\bdel\b.*(/s|/q)|\brmdir\b|remove-item|\bformat\b\s+[a-z]:|\bshutdown\b|reg\s+delete|git\s+(push\s+.*--force|reset\s+--hard|clean\s+-[a-z]*f)|\bdiskpart\b|\bcipher\s+/w|\|\s*(sh|bash|iex)\b|invoke-expression|\bmkfs\b|\btaskkill\b)",
    )
    .unwrap();
    if destructive.is_match(cmd) {
        return Decision::Ask { class: Class::Destructive, reason: "This command can delete or overwrite data".into(), can_remember: false };
    }
    let readonly = Regex::new(
        r"(?i)^\s*(dir|ls|type|cat|echo|where|whoami|hostname|pwd|get-childitem|get-content|get-item|get-location|select-string|test-path|git\s+(status|log|diff|branch)|python\s+--version|node\s+--version)\b[^|&;<>]*$",
    )
    .unwrap();
    if readonly.is_match(cmd) {
        return Decision::Allow;
    }
    if auto_edit && !cmd.trim().is_empty() {
        // "Edits allowed in folder": ordinary commands that stay inside the workspace, with no network,
        // installs or process launching, run without asking.
        let risky = Regex::new(
            r"(?i)(\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|start-process|start|pip|npm|npx|winget|choco|scoop|sc|net|netsh|schtasks|powershell|pwsh|cmd)\b|https?://|\\\\)",
        )
        .unwrap();
        let drive = Regex::new(r#"(?i)\b[a-z]:[\\/][^\s"']*"#).unwrap();
        let escapes = drive.find_iter(cmd).any(|m| !inside(&norm(m.as_str()), workspace)) || cmd.contains("..\\") || cmd.contains("../");
        if !risky.is_match(cmd) && !escapes {
            return Decision::Allow;
        }
    }
    Decision::Ask { class: Class::Exec, reason: "Run a command on your computer".into(), can_remember: false }
}

fn mcp_decision(tool: &str, args: &Value, auto_edit: bool, remembered: bool, outside: bool) -> Decision {
    let t = tool.to_lowercase();
    let read_verbs = ["view", "get", "query", "list", "validate", "info", "help", "inspect", "read", "page_count"];
    let first = args
        .get("args")
        .and_then(|a| {
            a.as_array()
                .and_then(|v| v.first().and_then(|x| x.as_str()))
                .or_else(|| a.as_str().and_then(|s| s.split_whitespace().next()))
        })
        .or_else(|| args.get("command").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_lowercase();
    if t.contains("browser") {
        return browser_decision(args);
    }
    if t.contains("ssh_exec") {
        return crate::sshpolicy::decide(args);
    }
    if t.contains("workspace_info") || t.contains("load_skill") || t.contains("read_attachment") || t.contains("web_search") || t.contains("memory_") || t.contains("web_fetch") || read_verbs.iter().any(|v| first == *v) {
        return Decision::Allow;
    }
    if outside {
        return Decision::Ask { class: Class::Write, reason: "Document change outside the workspace".into(), can_remember: false };
    }
    if auto_edit || remembered {
        Decision::Allow
    } else {
        Decision::Ask { class: Class::Write, reason: "Create or change an Office document".into(), can_remember: true }
    }
}

/// Browser tool: looking is free; typing into sensitive fields, uploads and consequential clicks ask.
fn browser_decision(args: &Value) -> Decision {
    let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
    let rest = match args.get("args") {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" "),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
    .to_lowercase();
    let label = args.get("label").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
    let full = format!("{cmd} {rest} {label}");
    let ask = |class, reason: &str| Decision::Ask { class, reason: reason.into(), can_remember: false };
    let sensitive = Regex::new(r"(?i)(password|passwd|card|cvv|cvc|iban|ssn|security code|account number|routing)").unwrap();
    let consequential = Regex::new(r"(?i)b(submit|buy|purchase|pay|order|checkout|delete|remove|send|confirm|post|publish|sign ?in|log ?in|transfer)b").unwrap();
    match cmd.split_whitespace().next().unwrap_or("") {
        "upload" => ask(Class::Write, "Upload a file from your computer to a website"),
        "fill" | "type" if sensitive.is_match(&full) => ask(Class::Exec, "Enter a password or payment detail on a website"),
        "click" | "dblclick" | "press" if consequential.is_match(&full) => ask(Class::Exec, "Click a button that submits or changes something online"),
        "eval" => ask(Class::Exec, "Run a script inside a web page"),
        _ => Decision::Allow,
    }
}
