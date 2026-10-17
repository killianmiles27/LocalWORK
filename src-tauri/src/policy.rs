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
    let path = PathBuf::from(s);
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                match clean.file_name() {
                    Some(name) if name != ".." => { clean.pop(); }
                    Some(_) | None if !path.is_absolute() => clean.push(".."),
                    _ => {}
                }
            }
            other => clean.push(other.as_os_str()),
        }
    }
    clean
}

fn inside(path: &Path, root: &Path) -> bool {
    let a = path.to_string_lossy().to_lowercase();
    let b = root.to_string_lossy().trim_end_matches('\\').to_lowercase();
    a == b || a.starts_with(&format!("{b}\\"))
}

fn arg_path(args: &Value, workspace: &Path) -> Option<PathBuf> {
    for k in ["file_path", "path", "filePath", "output", "file"] {
        if let Some(s) = args.get(k).and_then(|v| v.as_str()) {
            let p = PathBuf::from(s.replace('/', "\\"));
            return Some(if p.is_absolute() { norm(s) } else { norm(&workspace.join(p).to_string_lossy()) });
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
        if PROTECTED.iter().any(|x| l == *x || l.starts_with(&format!("{x}\\")))
            || l.contains("\\appdata\\local\\workbench\\")
            || l.ends_with("\\appdata\\local\\workbench")
        {
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
        // Automatic mode includes routine shell commands in the workspace.
        // A shell wrapper alone does not make an otherwise ordinary command consequential.
        let risky = Regex::new(
            r#"(?i)(\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|start-process|start|pip|npm|npx|winget|choco|scoop|sc|net|netsh|schtasks)\b|-(?:encodedcommand|enc)\b|https?://|(?:^|[\s"'=])\\\\)"#,
        )
        .unwrap();
        // Consume quoted paths as a whole: a workspace can contain spaces.
        let drive = Regex::new(r#"(?i)"([a-z]:[\\/][^"]*)"|'([a-z]:[\\/][^']*)'|([a-z]:[\\/][^\s"']*)"#).unwrap();
        let escapes = drive.captures_iter(cmd).any(|c| {
            let p = c.get(1).or_else(|| c.get(2)).or_else(|| c.get(3)).unwrap();
            !inside(&norm(p.as_str()), workspace)
        }) || cmd.contains("..\\") || cmd.contains("../");
        if !risky.is_match(cmd) && !escapes {
            return Decision::Allow;
        }
    }
    Decision::Ask { class: Class::Exec, reason: "Run a command on your computer".into(), can_remember: false }
}

fn mcp_decision(tool: &str, args: &Value, auto_edit: bool, remembered: bool, outside: bool) -> Decision {
    let t = tool.to_lowercase();
    let read_verbs = ["view", "get", "query", "list", "validate", "verify", "info", "help", "inspect", "read", "page_count"];
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
    if crate::setup::WEB_OFF.load(std::sync::atomic::Ordering::SeqCst) && (t.contains("browser") || t.contains("web_search") || t.contains("web_fetch")) {
        return Decision::Deny("Web access is turned off in Settings".into());
    }
    if t.contains("browser") {
        return browser_decision(args, auto_edit);
    }
    if t.contains("ssh_exec") {
        return crate::sshpolicy::decide(args);
    }
    if t.ends_with("assemble_document") || (t.ends_with("show_document") && !outside) {
        return Decision::Allow;
    }
    if t.contains("workspace_info") || t.contains("load_skill") || t.contains("read_attachment") || t.contains("show_chart") || t.contains("show_table") || t.contains("show_diagram") || t.contains("publish_artifact") || t.contains("update_plan") || t.contains("web_search") || t.contains("memory_") || t.contains("web_fetch") || read_verbs.iter().any(|v| first == *v) {
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
fn browser_decision(args: &Value, auto_edit: bool) -> Decision {
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
    let sensitive = Regex::new(r"(?i)(password|passwd|\b(card|cvv|cvc|iban|ssn|routing)\b|security[\s_-]*code|account[\s_-]*number)").unwrap();
    let consequential = Regex::new(r"(?i)\b(submit|requestsubmit|buy|purchase|pay|order|checkout|delete|remove|send|confirm|post|publish|sign ?in|log ?in|transfer)\b").unwrap();
    let form_action = (rest.contains("form") || rest.contains("[type=submit]"))
        && Regex::new(r"(?i)\.\s*(click|dispatchevent)\s*\(").unwrap().is_match(&rest);
    match cmd.split_whitespace().next().unwrap_or("") {
        "upload" => ask(Class::Write, "Upload a file from your computer to a website"),
        "fill" | "type" if sensitive.is_match(&full) => ask(Class::Exec, "Enter a password or payment detail on a website"),
        "click" | "dblclick" | "press" if consequential.is_match(&full) => ask(Class::Exec, "Click a button that submits or changes something online"),
        "eval" if sensitive.is_match(&rest) => ask(Class::Exec, "Run a script that may access password or payment details"),
        "eval" if consequential.is_match(&rest) || form_action => ask(Class::Exec, "Run a script that may submit or change something online"),
        "eval" if !auto_edit => ask(Class::Exec, "Run a script inside a web page"),
        _ => Decision::Allow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn automatic_commands_accept_quoted_workspace_paths_with_spaces() {
        let ws = Path::new(r"C:\Random\Working Folder\LocalWORK\draft");
        for path in [r"C:\Random\Working Folder\LocalWORK\draft\figure.png", r"C:\\Random\\Working Folder\\LocalWORK\\draft\\figure.png"] {
            let cmd = format!("Add-Type -AssemblyName System.Drawing; $p = \"{path}\"; [System.Drawing.Image]::FromFile($p)");
            assert!(matches!(decide("ExecCommand", "exec", &json!({"cmd":cmd}), ws, true, &[]), Decision::Allow));
        }
        for cmd in [r#"[System.IO.File]::ReadAllText("C:\Random\Working Folder\Other\secret.txt")"#, r#"[System.IO.File]::ReadAllText("\\server\share\secret.txt")"#, "Remove-Item figure.png"] {
            assert!(matches!(decide("ExecCommand", "exec", &json!({"cmd":cmd}), ws, true, &[]), Decision::Ask { .. }));
        }
        assert!(matches!(decide("ExecCommand", "exec", &json!({"cmd":"Add-Type -AssemblyName System.Drawing"}), ws, false, &[]), Decision::Ask { .. }));
    }

    #[test]
    fn automatic_mode_allows_routine_shell_wrappers_and_keeps_consequential_checks() {
        let ws = Path::new(r"C:\work");
        for cmd in [r#"pwsh -Command "('one two' -split '\s+').Count""#, r#"powershell -NoProfile -Command "Get-FileHash figure.png""#, "cmd /c echo ready"] {
            assert!(matches!(decide("ExecCommand", "exec", &json!({"cmd":cmd}), ws, true, &[]), Decision::Allow));
            assert!(matches!(decide("ExecCommand", "exec", &json!({"cmd":cmd}), ws, false, &[]), Decision::Ask { .. }));
        }
        for cmd in ["pwsh -Command Remove-Item figure.png", "cmd /c curl https://example.com", "powershell -enc AAAA", "pwsh -Command npm install package"] {
            assert!(matches!(decide("ExecCommand", "exec", &json!({"cmd":cmd}), ws, true, &[]), Decision::Ask { .. }));
        }
    }

    #[test]
    fn automatic_mode_allows_routine_browser_eval_but_guards_submissions_and_credentials() {
        let ws = Path::new(r"C:\work");
        assert!(matches!(decide("browser", "tool", &json!({"command":"eval", "args":"document.title"}), ws, true, &[]), Decision::Allow));
        // Eval labels describe intent, not a clicked control or executed code.
        assert!(matches!(decide("browser", "tool", &json!({"command":"eval", "args":["() => document.querySelectorAll('.vzb-bc-bubbles circle').length"], "label":"Confirm Korea trail labels"}), ws, true, &[]), Decision::Allow));
        for script in ["() => document.forms[0].requestSubmit()", "() => document.querySelector('form button').click()"] {
            assert!(matches!(decide("browser", "tool", &json!({"command":"eval", "args":[script]}), ws, true, &[]), Decision::Ask { .. }));
        }
        assert!(matches!(decide("browser", "tool", &json!({"command":"eval", "args":["() => document.querySelector('.vzb-play').click()"]}), ws, true, &[]), Decision::Allow));
        assert!(matches!(decide("browser", "tool", &json!({"command":"eval", "args":["() => Array.from(document.querySelectorAll('[class*=time]')).map(e => e.className)"]}), ws, true, &[]), Decision::Allow));
        assert!(matches!(decide("browser", "tool", &json!({"command":"fill", "label":"SSN"}), ws, true, &[]), Decision::Ask { .. }));
        assert!(matches!(decide("browser", "tool", &json!({"command":"eval", "args":"document.title"}), ws, false, &[]), Decision::Ask { .. }));
        assert!(matches!(decide("browser", "tool", &json!({"command":"eval", "args":"document.querySelector('form').submit()"}), ws, true, &[]), Decision::Ask { .. }));
        assert!(matches!(decide("browser", "tool", &json!({"command":"fill", "label":"password"}), ws, true, &[]), Decision::Ask { .. }));
        assert!(matches!(decide("browser", "tool", &json!({"command":"press", "args":"Enter", "label":"Submit order"}), ws, true, &[]), Decision::Ask { .. }));
        assert!(matches!(decide("browser", "tool", &json!({"command":"press", "args":"Enter", "label":"Next chart"}), ws, true, &[]), Decision::Allow));
        assert!(matches!(decide("browser", "tool", &json!({"command":"upload"}), ws, true, &[]), Decision::Ask { .. }));
    }

    #[test]
    fn protected_paths_use_component_boundaries_and_resolve_parent_segments() {
        let ws = Path::new(r"C:\work");
        let exact = decide("write_file", "edit", &json!({"path":r"C:\Windows\System32\note.txt"}), ws, true, &[]);
        assert!(matches!(exact, Decision::Deny(_)));
        let boundary_neighbor = decide("write_file", "edit", &json!({"path":r"C:\Windows-old\note.txt"}), ws, true, &[]);
        assert!(matches!(boundary_neighbor, Decision::Ask { .. }));
        let workbench = decide("write_file", "edit", &json!({"path":r"C:\Users\User\AppData\Local\Workbench\profile.json"}), ws, true, &[]);
        assert!(matches!(workbench, Decision::Deny(_)));
        let workbench_neighbor = decide("write_file", "edit", &json!({"path":r"C:\Users\User\AppData\Local\Workbench-old\file.txt"}), ws, true, &[]);
        assert!(matches!(workbench_neighbor, Decision::Ask { .. }));
        let traversal = decide("write_file", "edit", &json!({"path":r"C:\work\..\Windows\System32\note.txt"}), ws, true, &[]);
        assert!(matches!(traversal, Decision::Deny(_)));
        let relative_traversal = decide("write_file", "edit", &json!({"path":r"..\outside.txt"}), ws, true, &[]);
        assert!(matches!(relative_traversal, Decision::Ask { .. }));
        let double_traversal = decide("write_file", "edit", &json!({"path":r"..\..\Windows\System32\note.txt"}), ws, true, &[]);
        assert!(matches!(double_traversal, Decision::Deny(_)));
    }
}
