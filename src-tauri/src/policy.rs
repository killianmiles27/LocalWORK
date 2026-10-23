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

#[derive(Debug)]
pub enum Decision {
    Allow,
    Ask { class: Class, reason: String, can_remember: bool },
    Deny(String),
}

/// Path separator used by the string comparisons below.
const SEP: char = if cfg!(windows) { '\\' } else { '/' };

fn norm(p: &str) -> PathBuf {
    let mut s = if cfg!(windows) { p.replace('/', "\\") } else { p.replace('\\', "/") };
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
    // Linux paths are case-sensitive, so only Windows folds case.
    let fold = |s: &str| if cfg!(windows) { s.to_lowercase() } else { s.to_string() };
    let a = fold(&path.to_string_lossy());
    let b = fold(&root.to_string_lossy());
    let b = if b.len() > 1 { b.trim_end_matches(SEP) } else { b.as_str() };
    a == b || a.starts_with(&format!("{b}{SEP}"))
}

fn resolve_arg_path(s: &str, workspace: &Path) -> PathBuf {
    let p = PathBuf::from(if cfg!(windows) { s.replace('/', "\\") } else { s.replace('\\', "/") });
    if p.is_absolute() { norm(s) } else { norm(&workspace.join(p).to_string_lossy()) }
}

fn officecli_paths(args: &Value, workspace: &Path) -> (Vec<PathBuf>, bool) {
    let Some(argv) = args.get("args").and_then(Value::as_array) else { return (Vec::new(), false) };
    let verb = argv.first().and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    if matches!(verb.as_str(), "help" | "config" | "version" | "--help" | "--version" | "-h" | "-v")
        || argv.iter().any(|a| matches!(a.as_str(), Some("--help" | "-h" | "--version" | "-v")))
    { return (Vec::new(), false); }
    let mut paths = Vec::new();
    let mut uncertain_path_option = false;
    let mut i = 1;
    while i < argv.len() {
        let Some(s) = argv[i].as_str() else { i += 1; continue };
        let lower = s.to_ascii_lowercase();
        if matches!(lower.as_str(), "-o" | "--out" | "--output" | "--input" | "--input-file" | "--output-file" | "--output-path" | "--output-dir") {
            if let Some(value) = argv.get(i + 1).and_then(Value::as_str) {
                paths.push(resolve_arg_path(value, workspace));
                i += 2;
                continue;
            }
            uncertain_path_option = true;
        } else if ["--out=", "--output=", "--input=", "--input-file=", "--output-file=", "--output-path=", "--output-dir="]
            .iter().any(|prefix| lower.starts_with(prefix))
        {
            if let Some((_, value)) = s.split_once('=') { paths.push(resolve_arg_path(value, workspace)); }
        } else if s.starts_with('-') && ["out", "output", "input", "file", "path"].iter().any(|part| lower.contains(part)) {
            uncertain_path_option = true;
        } else if !s.starts_with('-') && ((i == 1) || (verb == "merge" && i == 2) || (verb == "import" && i == 3)) {
            paths.push(resolve_arg_path(s, workspace));
        }
        i += 1;
    }
    (paths, uncertain_path_option)
}

fn arg_paths(tool: &str, args: &Value, workspace: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for k in ["file_path", "path", "filePath", "output", "file", "target", "source", "dataset", "dataset_path", "actual_path"] {
        if let Some(s) = args.get(k).and_then(|v| v.as_str()) {
            paths.push(resolve_arg_path(s, workspace));
            if !tool.to_ascii_lowercase().contains("officecli") {
                return paths;
            }
        }
    }
    if tool.to_ascii_lowercase().contains("officecli") {
        paths.extend(officecli_paths(args, workspace).0);
    }
    paths
}

fn officecli_uncertain_path_option(tool: &str, args: &Value) -> bool {
    tool.to_ascii_lowercase().contains("officecli") && officecli_paths(args, Path::new(".")).1
}

fn officecli_writes_output(tool: &str, args: &Value) -> bool {
    if !tool.to_ascii_lowercase().contains("officecli") { return false; }
    let Some(argv) = args.get("args").and_then(Value::as_array) else { return false };
    let verb = argv.first().and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    verb == "merge" || (verb == "view" && argv.iter().filter_map(Value::as_str).any(|s| {
        matches!(s.to_ascii_lowercase().as_str(), "-o" | "--out" | "--output") || ["--out=", "--output="].iter().any(|p| s.to_ascii_lowercase().starts_with(p))
    }))
}

#[cfg(windows)]
const PROTECTED: &[&str] = &["c:\\windows", "c:\\program files", "c:\\programdata"];
#[cfg(not(windows))]
const PROTECTED: &[&str] = &["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/boot", "/var", "/opt", "/root", "/sys", "/proc", "/dev"];

/// The app's own data folder outside Windows (on Windows it is matched by name below).
fn data_dir_lower() -> Option<String> {
    if cfg!(windows) { return None; }
    Some(norm(&crate::paths::data_dir().to_string_lossy()).to_string_lossy().to_lowercase())
}

// Consequential actions that ask even in Automatic mode: they reach past this computer or set up code
// that runs later on its own. The segment and wrapper handling follows Eigent's permission policy
// (Apache-2.0, eigent-ai/eigent); this is a separate Windows-aware implementation.
const PUBLISH: &str = "Publish or push something online";
const SEND: &str = "Send data to another computer";
const PRIVILEGE: &str = "Run a command as administrator";
const AUTORUN: &str = "Change a file or setting that runs code automatically";
const HIDDEN: &str = "Run an encoded command that cannot be checked";
const ALWAYS_ASK: &[&str] = &[PUBLISH, SEND, PRIVILEGE, AUTORUN, HIDDEN];
const RUN_COMMAND: &str = "Run a command on your computer";

/// Automatic mode runs without prompts. It still stops for things that cannot be taken back:
/// destructive shell commands, publishing or sending data elsewhere, admin rights, code set to run
/// automatically, entering a password or payment detail on a website, and online purchases.
/// Protected locations (Windows, Program Files, the app's own data) stay denied in every mode.
pub fn decide(tool: &str, category: &str, args: &Value, workspace: &Path, auto_edit: bool, remembered: &[String]) -> Decision {
    match guarded(tool, category, args, workspace, auto_edit, remembered) {
        Decision::Ask { class, reason, can_remember } if !auto_edit || class == Class::Destructive || ALWAYS_ASK.contains(&reason.as_str()) || reason.contains("password or payment") || reason.contains("purchase") => {
            Decision::Ask { class, reason, can_remember }
        }
        Decision::Ask { .. } => Decision::Allow,
        d => d,
    }
}

/// The step-by-step policy that Ask mode shows to the user.
fn guarded(tool: &str, category: &str, args: &Value, workspace: &Path, auto_edit: bool, remembered: &[String]) -> Decision {
    if tool == "Spawn" {
        return Decision::Deny("Sub-agents are disabled in this app".into());
    }
    let workspace = &norm(&workspace.to_string_lossy());
    let paths = arg_paths(tool, args, workspace);
    let data = data_dir_lower();
    for p in &paths {
        let l = p.to_string_lossy().to_lowercase();
        if PROTECTED.iter().any(|x| l == *x || l.starts_with(&format!("{x}{SEP}")))
            || l.contains("\\appdata\\local\\workbench\\")
            || l.ends_with("\\appdata\\local\\workbench")
            || data.as_ref().is_some_and(|d| l == *d || l.starts_with(&format!("{d}{SEP}")))
        {
            return Decision::Deny(format!("{} is a protected location", p.display()));
        }
    }
    let outside = paths.iter().any(|p| !inside(p, workspace));
    let remembered_hit = remembered.iter().any(|t| t == tool);
    if category == "edit" && paths.iter().any(|p| autorun_path(&p.to_string_lossy())) {
        return Decision::Ask { class: Class::Write, reason: AUTORUN.into(), can_remember: false };
    }
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
        "exec" => exec_decision(args, workspace, auto_edit, remembered),
        _ => mcp_decision(tool, args, auto_edit, remembered_hit, outside, !paths.is_empty()),
    }
}

fn command_arg(args: &Value) -> &str {
    args.get("command").or_else(|| args.get("cmd")).and_then(|v| v.as_str()).unwrap_or("")
}

/// What "Allow for this chat" remembers: the exact command (whitespace collapsed) for shell commands,
/// so approving one command never approves a different one; the tool name for file and document edits.
pub fn remember_key(tool: &str, category: &str, args: &Value) -> String {
    if category == "exec" {
        format!("exec:{}", command_arg(args).split_whitespace().collect::<Vec<_>>().join(" "))
    } else {
        tool.to_string()
    }
}

fn autorun_path(path: &str) -> bool {
    let p = path.replace('/', "\\").to_lowercase();
    p.contains("\\.git\\hooks\\") || p.ends_with("\\.git\\hooks") || p.ends_with("\\.git\\config")
        || p.ends_with("\\.vscode\\tasks.json")
        || p.contains("\\start menu\\programs\\startup")
        || p.ends_with("profile.ps1")
        // Linux: shell start-up files, desktop autostart entries and user systemd units.
        || p.contains("\\.config\\autostart\\") || p.contains("\\.config\\systemd\\")
        || [".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zprofile", ".zshenv", ".xprofile"]
            .iter().any(|f| p.ends_with(&format!("\\{f}")))
}

/// Split a command line into simple commands on unquoted `;`, `|`, `||`, `&`, `&&` and newlines.
/// A redirection like `2>&1` is not a separator.
fn segments(cmd: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut quote, mut start, mut prev) = (None, 0, ' ');
    let mut chars = cmd.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '`') => { chars.next(); }
            (None, '&') if prev == '>' => {}
            (None, ';' | '|' | '&' | '\n' | '\r') => {
                out.push(&cmd[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
        prev = c;
    }
    out.push(&cmd[start..]);
    out.into_iter().map(str::trim).filter(|s| !s.is_empty()).collect()
}

/// Quote-aware words with their byte offsets, so a wrapper's remainder can be taken verbatim.
fn words(seg: &str) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let mut cur: Option<(String, usize)> = None;
    let mut quote = None;
    for (i, c) in seg.char_indices() {
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (Some(_), _) => cur.get_or_insert((String::new(), i)).0.push(c),
            (None, '"' | '\'') => { quote = Some(c); cur.get_or_insert((String::new(), i)); }
            (None, c) if c.is_whitespace() => { if let Some(w) = cur.take() { out.push(w); } }
            (None, c) => cur.get_or_insert((String::new(), i)).0.push(c),
        }
    }
    out.extend(cur);
    out
}

fn program(word: &str) -> String {
    let base = word.rsplit(['\\', '/']).next().unwrap_or(word).to_lowercase();
    base.strip_suffix(".exe").map(str::to_string).unwrap_or(base)
}

/// The text a wrapper runs (`cmd /c`, `powershell -Command`, `sh -c`, `env`, `start`, `call`, `&`), if this is one.
fn unwrap<'a>(seg: &'a str, w: &[(String, usize)]) -> Option<std::borrow::Cow<'a, str>> {
    let rest_from = |i: usize| -> Option<std::borrow::Cow<'a, str>> {
        let (word, at) = w.get(i)?;
        // A single quoted remainder is the inner command itself.
        Some(if i + 1 == w.len() { word.clone().into() } else { seg[*at..].into() })
    };
    let flag = |i: usize| w[i].0.to_lowercase();
    match program(&w[0].0).as_str() {
        "cmd" => (1..w.len()).find(|&i| matches!(flag(i).as_str(), "/c" | "/k" | "/r")).and_then(|i| rest_from(i + 1)),
        "powershell" | "pwsh" => {
            let mut i = 1;
            while i < w.len() {
                let f = flag(i);
                if !f.starts_with('-') { return rest_from(i); }
                if f == "-c" || (f.len() > 2 && "-command".starts_with(&f)) { return rest_from(i + 1); }
                // -File runs a script; -EncodedCommand is opaque. Both are judged as the powershell command itself.
                if f == "-f" || (f.len() > 2 && "-file".starts_with(&f)) || f == "-e" || f == "-ec" || (f.len() > 2 && "-encodedcommand".starts_with(&f)) { return None; }
                // Options with a value: -ExecutionPolicy, -WindowStyle, -WorkingDirectory, -Version...
                i += if ["-executionpolicy", "-ex", "-ep", "-windowstyle", "-w", "-workingdirectory", "-wd", "-version", "-v", "-configurationname", "-outputformat", "-of", "-inputformat", "-if", "-psconsolefile"].contains(&f.as_str()) { 2 } else { 1 };
            }
            None
        }
        // `-c`, or combined short flags such as `-lc` and `-ec`.
        "sh" | "bash" | "wsl" | "zsh" | "dash" | "ksh" | "fish" => (1..w.len())
            .find(|&i| { let f = flag(i); f == "-c" || (f.starts_with('-') && !f.starts_with("--") && f.contains('c')) })
            .and_then(|i| w.get(i + 1).map(|x| x.0.clone().into())),
        "env" => (1..w.len()).find(|&i| !w[i].0.contains('=') && !w[i].0.starts_with('-')).and_then(rest_from),
        "start" => (1..w.len()).find(|&i| !w[i].0.starts_with('/') && !w[i].0.is_empty()).and_then(rest_from),
        "call" | "&" | "nohup" | "exec" | "time" | "setsid" | "nice" | "xargs" => rest_from(1),
        _ => None,
    }
}

/// Why a shell command must ask even in Automatic mode, if it must. Each simple command is checked
/// after unwrapping shell wrappers, so `cmd /c "git push"` and `a && git push` are seen as `git push`.
fn consequential(cmd: &str) -> Option<&'static str> {
    consequential_at(cmd, 0)
}

fn consequential_at(cmd: &str, depth: usize) -> Option<&'static str> {
    if depth > 6 { return Some(HIDDEN); }
    for seg in segments(cmd) {
        let w = words(seg);
        if w.is_empty() { continue; }
        if let Some(inner) = unwrap(seg, &w) {
            if let Some(r) = consequential_at(&inner, depth + 1) { return Some(r); }
            continue;
        }
        if let Some(r) = simple_consequential(seg, &w) { return Some(r); }
    }
    None
}

fn simple_consequential(seg: &str, w: &[(String, usize)]) -> Option<&'static str> {
    let prog = program(&w[0].0);
    let args: Vec<String> = w[1..].iter().map(|(s, _)| s.to_lowercase()).collect();
    let has = |names: &[&str]| args.iter().any(|a| names.contains(&a.as_str()));
    let sub = args.iter().find(|a| !a.starts_with('-')).map(String::as_str).unwrap_or("");
    let pwsh_param = |a: &str, full: &str| a.len() > 2 && full.starts_with(a);
    let lower = seg.to_lowercase();
    match prog.as_str() {
        "powershell" | "pwsh" if args.iter().any(|a| a == "-e" || a == "-ec" || pwsh_param(a, "-encodedcommand")) => return Some(HIDDEN),
        "runas" | "sudo" | "gsudo" | "doas" | "pkexec" | "su" | "run0" => return Some(PRIVILEGE),
        "start-process" | "saps" if args.iter().zip(args.iter().skip(1)).any(|(a, v)| pwsh_param(a, "-verb") && v == "runas") => return Some(PRIVILEGE),
        "git" => {
            let mut i = 0;
            while i < args.len() && args[i].starts_with('-') {
                if (args[i] == "-c" && args.get(i + 1).is_some_and(|kv| git_runs_code(kv))) || git_runs_code(&args[i]) { return Some(AUTORUN); }
                i += if args[i] == "-c" { 2 } else { 1 }; // `-c k=v` and (lowered) `-C dir` both take a value
            }
            let rest = &args[i.min(args.len())..];
            match rest.first().map(String::as_str) {
                Some("push") => return Some(PUBLISH),
                Some("send-email") => return Some(SEND),
                Some("config") if rest.iter().any(|a| git_runs_code(a))
                    && !rest.iter().any(|a| matches!(a.as_str(), "--get" | "--get-all" | "--get-regexp" | "--list" | "-l")) => return Some(AUTORUN),
                _ => {}
            }
            return None; // `git add .git/hooks` style paths are data to git, not something it runs.
        }
        "npm" | "pnpm" | "yarn" | "bun" if has(&["publish", "unpublish", "deprecate"]) || (has(&["dist-tag"]) && has(&["add", "rm"])) => return Some(PUBLISH),
        "cargo" if matches!(sub, "publish" | "yank" | "owner") => return Some(PUBLISH),
        "twine" if matches!(sub, "upload" | "register") => return Some(PUBLISH),
        "poetry" | "uv" | "flit" | "hatch" | "pdm" if sub == "publish" => return Some(PUBLISH),
        "dotnet" | "nuget" if has(&["push"]) => return Some(PUBLISH),
        "docker" | "podman" if sub == "push" => return Some(PUBLISH),
        "gh" => {
            let action = args.iter().filter(|a| !a.starts_with('-')).nth(1).map(String::as_str).unwrap_or("");
            let writes_api = sub == "api" && (args.iter().any(|a| matches!(a.as_str(), "-f" | "-F" | "--field" | "--raw-field" | "--input") || a.starts_with("--field=") || a.starts_with("--raw-field="))
                || args.iter().zip(args.iter().skip(1)).any(|(a, v)| matches!(a.as_str(), "-x" | "--method") && v != "get"));
            let reads = ["", "list", "view", "status", "diff", "checks", "download", "watch", "browse"];
            if writes_api || (["release", "pr", "repo", "issue", "gist", "workflow", "secret", "variable", "label", "run"].contains(&sub) && !reads.contains(&action)) {
                return Some(PUBLISH);
            }
            return None;
        }
        "ssh" | "scp" | "sftp" | "ftp" | "tftp" | "rsync" | "send-mailmessage" => return Some(SEND),
        // curl flags are case-sensitive (-F form vs -f fail, -X method vs -x proxy), so read them unlowered.
        "curl" if {
            let raw: Vec<&str> = w[1..].iter().map(|(s, _)| s.as_str()).collect();
            raw.iter().any(|a| {
                ["-d", "-F", "-T", "--json", "--upload-file"].contains(a) || a.starts_with("--data") || a.starts_with("--form")
                    || (a.starts_with("-d") || a.starts_with("-F") || a.starts_with("-T")) && !a.starts_with("--")
                    || a.starts_with("-X") && a.len() > 2 && !["GET", "HEAD"].contains(&a[2..].to_uppercase().as_str())
            }) || raw.iter().zip(raw.iter().skip(1)).any(|(a, v)| matches!(*a, "-X" | "--request") && !["GET", "HEAD"].contains(&v.to_uppercase().as_str()))
        } => return Some(SEND),
        "invoke-webrequest" | "iwr" | "invoke-restmethod" | "irm" | "wget" | "curl"
            if args.iter().any(|a| pwsh_param(a, "-body") || pwsh_param(a, "-infile") || pwsh_param(a, "-form") || a.starts_with("--post-") || a.starts_with("--body-") || (a.starts_with("--method=") && !matches!(&a[9..], "get" | "head")))
                || args.iter().zip(args.iter().skip(1)).any(|(a, v)| (a.len() > 3 && "-method".starts_with(a.as_str())) && v != "get" && v != "head") => return Some(SEND),
        "schtasks" if has(&["/create", "/change"]) => return Some(AUTORUN),
        "register-scheduledtask" | "new-service" => return Some(AUTORUN),
        "sc" if matches!(sub, "create" | "config") => return Some(AUTORUN),
        "crontab" if !has(&["-l"]) => return Some(AUTORUN),
        "systemctl" if matches!(sub, "enable" | "link" | "edit" | "set-property" | "preset") => return Some(AUTORUN),
        "at" | "batch" => return Some(AUTORUN),
        _ => {}
    }
    let reader = ["cat", "type", "get-content", "gc", "more", "dir", "ls", "get-childitem", "gci", "select-string", "sls", "findstr", "test-path", "get-item", "gi", "get-itemproperty", "gp"].contains(&prog.as_str())
        || (prog == "reg" && sub == "query");
    let writes_here = !reader || seg.contains('>');
    let autorun_text = Regex::new(r"(?i)\.git[\\/]+hooks\b|\.git[\\/]+config\b|\.vscode[\\/]+tasks\.json|start menu[\\/]+programs[\\/]+startup|shell:startup|\$profile\b|profile\.ps1\b|currentversion[\\/]+run(once)?\b|[\\/]winlogon\b|\.(bashrc|bash_profile|bash_login|zshrc|zprofile|zshenv|xprofile)\b|[\\/~]\.profile\b|\.config[\\/]+(autostart|systemd)\b").unwrap();
    if writes_here && autorun_text.is_match(&lower) {
        return Some(AUTORUN);
    }
    None
}

/// Git settings whose value is a program git runs later (hooks, editors, helpers, aliases, filters).
fn git_runs_code(kv: &str) -> bool {
    let k = kv.to_lowercase();
    ["core.hookspath", "core.fsmonitor", "core.sshcommand", "core.editor", "core.pager", "core.askpass", "credential.helper", "alias.", "include.path", "includeif.", "filter.", "diff.external", "sequence.editor", "gpg.program", "ssh.program"]
        .iter().any(|key| k.starts_with(key))
}

fn exec_decision(args: &Value, workspace: &Path, auto_edit: bool, remembered: &[String]) -> Decision {
    if args.get("shell").and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty()) {
        return Decision::Ask { class: Class::Exec, reason: "Run a command with an explicitly selected shell".into(), can_remember: false };
    }
    let cmd = command_arg(args);
    let destructive = Regex::new(
        r"(?i)(\brm\s+-[a-z]*[rf]|\bdel\b.*(/s|/q)|\brmdir\b|remove-item|\bformat\b\s+[a-z]:|\bshutdown\b|reg\s+delete|git\s+(push\s+.*--force|reset\s+--hard|clean\s+-[a-z]*f)|\bdiskpart\b|\bcipher\s+/w|\|\s*(sh|bash|iex)\b|invoke-expression|\bmkfs\b|\btaskkill\b)",
    )
    .unwrap();
    if destructive.is_match(cmd) {
        return Decision::Ask { class: Class::Destructive, reason: "This command can delete or overwrite data".into(), can_remember: false };
    }
    if let Some(reason) = consequential(cmd) {
        return Decision::Ask { class: Class::Exec, reason: reason.into(), can_remember: false };
    }
    let readonly = Regex::new(
        r"(?i)^\s*(dir|ls|type|cat|echo|where|whoami|hostname|pwd|get-childitem|get-content|get-item|get-location|select-string|test-path|python\s+--version|node\s+--version)\b[^|&;<>]*$",
    )
    .unwrap();
    // Do not parse shell programs here: only literal single commands use this fast path.
    let shell_syntax = Regex::new(r#"(?s)[\r\n;&|<>`$%(){}\[\]]"#).unwrap();
    let unsafe_git_diff_output = Regex::new(r"(?i)^\s*git\s+diff\b.*(?:--output(?:=|\s)|(?:^|\s)-o(?:\s|$))").unwrap();
    let safe_git_branch = Regex::new(r"(?i)^\s*git\s+branch\s*(?:(?:--all|-a|--remotes|-r|--list)\s*)*$").unwrap();
    let safe_git_log = Regex::new(r"(?i)^\s*git\s+log\s*$").unwrap();
    let safe_git_diff = Regex::new(r"(?i)^\s*git\s+diff\s*$").unwrap();
    let safe_git_status = Regex::new(r"(?i)^\s*git\s+status(?:\s+(?:--short|-s|--branch|--porcelain(?:=v[12])?))*\s*$").unwrap();
    if (readonly.is_match(cmd) || safe_git_branch.is_match(cmd) || safe_git_log.is_match(cmd) || safe_git_diff.is_match(cmd) || safe_git_status.is_match(cmd)) && !shell_syntax.is_match(cmd) && !unsafe_git_diff_output.is_match(cmd) && !unix_path_escapes(cmd, workspace) {
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
        }) || unix_path_escapes(cmd, workspace) || cmd.contains("..\\") || cmd.contains("../");
        if !risky.is_match(cmd) && !unix_risky(cmd) && !escapes {
            return Decision::Allow;
        }
    }
    if remembered.contains(&remember_key("", "exec", args)) {
        return Decision::Allow;
    }
    Decision::Ask { class: Class::Exec, reason: RUN_COMMAND.into(), can_remember: true }
}

/// Linux programs that install software, change the system or reach other computers.
fn unix_risky(cmd: &str) -> bool {
    !cfg!(windows)
        && Regex::new(r"(?i)\b(sudo|doas|pkexec|su|ssh|scp|rsync|apt|apt-get|dpkg|pacman|yay|paru|makepkg|dnf|yum|zypper|rpm|flatpak|snap|systemctl|crontab|pip3|pipx)\b")
            .unwrap()
            .is_match(cmd)
}

/// Absolute (`/x`) and home (`~/x`) paths in a Linux command line that point outside the workspace.
fn unix_path_escapes(cmd: &str, workspace: &Path) -> bool {
    if cfg!(windows) { return false; }
    let re = Regex::new(r#"(?:^|[\s"'=(:])((?:/|~/|~$)[^\s"';|&)<>]*)"#).unwrap();
    let home = std::env::var("HOME").unwrap_or_default();
    let escapes = re.captures_iter(cmd).any(|c| {
        let raw = c.get(1).unwrap().as_str();
        let p = match raw.strip_prefix('~') { Some(rest) => format!("{home}{rest}"), None => raw.to_string() };
        !matches!(p.as_str(), "/dev/null" | "/dev/stdout" | "/dev/stderr") && !inside(&norm(&p), workspace)
    });
    escapes
}

fn mcp_decision(tool: &str, args: &Value, auto_edit: bool, remembered: bool, outside: bool, has_path: bool) -> Decision {
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
    if t.ends_with("tabular") && !outside {
        return Decision::Allow;
    }
    if t.contains("officecli") {
        let writes_output = officecli_writes_output(tool, args);
        let is_read = read_verbs.iter().any(|v| first == *v) && !writes_output;
        let fileless = matches!(first.as_str(), "help" | "version" | "--help" | "--version" | "-h" | "-v")
            || args.get("args").and_then(Value::as_array).is_some_and(|a| a.iter().any(|v| matches!(v.as_str(), Some("--help" | "-h" | "--version" | "-v"))));
        if outside {
            return Decision::Ask { class: if is_read { Class::Read } else { Class::Write }, reason: if is_read { "Read outside the workspace" } else { "Document change outside the workspace" }.into(), can_remember: false };
        }
        if officecli_uncertain_path_option(tool, args) {
            return Decision::Ask { class: Class::Write, reason: "OfficeCLI command uses an unrecognized path option".into(), can_remember: false };
        }
        if !fileless && !has_path {
            return Decision::Ask { class: if is_read { Class::Read } else { Class::Write }, reason: "OfficeCLI command has no validated workspace file target".into(), can_remember: false };
        }
        if is_read || fileless {
            return Decision::Allow;
        }
        return if auto_edit || remembered { Decision::Allow } else { Decision::Ask { class: Class::Write, reason: "Create or change an Office document".into(), can_remember: true } };
    }
    if t.contains("workspace_info") || t.contains("load_skill") || t.contains("read_attachment") || t.contains("show_chart") || t.contains("show_table") || t.contains("show_diagram") || t.contains("publish_artifact") || t.contains("update_plan") || t.contains("ask_user") || t.contains("web_search") || t.contains("memory_") || t.contains("web_fetch") || read_verbs.iter().any(|v| first == *v) {
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
    let purchase = Regex::new(r"(?i)\b(buy|purchase|pay|checkout|place ?order)\b").unwrap();
    let form_action = (rest.contains("form") || rest.contains("[type=submit]"))
        && Regex::new(r"(?i)\.\s*(click|dispatchevent)\s*\(").unwrap().is_match(&rest);
    match cmd.split_whitespace().next().unwrap_or("") {
        "upload" => ask(Class::Write, "Upload a file from your computer to a website"),
        "fill" | "type" if sensitive.is_match(&full) => ask(Class::Exec, "Enter a password or payment detail on a website"),
        "click" | "dblclick" | "press" | "eval" if purchase.is_match(&full) => ask(Class::Exec, "Make a purchase or payment online"),
        "click" | "dblclick" | "press" if consequential.is_match(&full) => ask(Class::Exec, "Click a button that submits or changes something online"),
        "eval" if sensitive.is_match(&rest) => ask(Class::Exec, "Run a script that may access password or payment details"),
        "eval" if consequential.is_match(&rest) || form_action => ask(Class::Exec, "Run a script that may submit or change something online"),
        "eval" if !auto_edit => ask(Class::Exec, "Run a script inside a web page"),
        _ => Decision::Allow,
    }
}

#[cfg(all(test, not(windows)))]
mod unix_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn linux_paths_stay_in_the_workspace() {
        let ws = Path::new("/home/me/projects/draft");
        assert!(inside(&norm("/home/me/projects/draft/a.md"), ws));
        assert!(!inside(&norm("/home/me/projects/draft/../secret.txt"), ws));
        assert!(!inside(&norm("/home/me/projects/drafty/a.md"), ws));
        assert!(!inside(&norm("/home/me/projects/Draft/a.md"), ws));
        assert!(matches!(guarded("Write", "edit", &json!({"file_path": "/etc/passwd"}), ws, true, &[]), Decision::Deny(_)));
    }

    #[test]
    fn linux_consequential_commands() {
        assert_eq!(consequential("bash -lc 'git push'"), Some(PUBLISH));
        assert_eq!(consequential("sudo pacman -S foo"), Some(PRIVILEGE));
        assert_eq!(consequential("crontab job.txt"), Some(AUTORUN));
        assert_eq!(consequential("crontab -l"), None);
        assert_eq!(consequential("systemctl --user enable foo.service"), Some(AUTORUN));
        assert_eq!(consequential("echo x >> ~/.bashrc"), Some(AUTORUN));
    }

    #[test]
    fn linux_commands_outside_the_workspace_ask_in_automatic_mode() {
        let ws = Path::new("/home/me/projects/draft");
        for cmd in ["cat /home/me/.ssh/id_ed25519", "cp a.md ~/out.md", "yay -S foo"] {
            assert!(matches!(decide("ExecCommand", "exec", &json!({"cmd": cmd}), ws, true, &[]), Decision::Ask { .. }), "{cmd}");
        }
        for cmd in ["python3 build.py", "grep -r todo . > /dev/null", "cat /home/me/projects/draft/a.md"] {
            assert!(matches!(decide("ExecCommand", "exec", &json!({"cmd": cmd}), ws, true, &[]), Decision::Allow), "{cmd}");
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn automatic_commands_accept_quoted_workspace_paths_with_spaces() {
        let ws = Path::new(r"C:\Users\Me\Projects\draft");
        for path in [r"C:\Users\Me\Projects\draft\figure.png", r"C:\\Users\\Me\\Projects\\draft\\figure.png"] {
            let cmd = format!("Add-Type -AssemblyName System.Drawing; $p = \"{path}\"; [System.Drawing.Image]::FromFile($p)");
            assert!(matches!(guarded("ExecCommand", "exec", &json!({"cmd":cmd}), ws, true, &[]), Decision::Allow));
        }
        for cmd in [r#"[System.IO.File]::ReadAllText("C:\Users\Me\Other\secret.txt")"#, r#"[System.IO.File]::ReadAllText("\\server\share\secret.txt")"#, "Remove-Item figure.png"] {
            assert!(matches!(guarded("ExecCommand", "exec", &json!({"cmd":cmd}), ws, true, &[]), Decision::Ask { .. }));
        }
        assert!(matches!(guarded("ExecCommand", "exec", &json!({"cmd":"Add-Type -AssemblyName System.Drawing"}), ws, false, &[]), Decision::Ask { .. }));
    }

    #[test]
    fn readonly_fast_paths_fail_closed_for_shell_programs_and_mutating_flags() {
        let ws = Path::new(r"C:\work");
        for cmd in [r"echo $([IO.File]::WriteAllText('outside.txt','changed'))", "echo (Set-Content outside.txt changed)", "echo %COMSPEC%", "echo ready; Remove-Item x", "echo ready\nRemove-Item x", "git branch -D main", "git branch --delete main", "git branch feature", "git diff --output=outside.txt", "git diff -o outside.txt", "git log --output=outside.txt"] {
            assert!(matches!(guarded("ExecCommand", "exec", &json!({"cmd":cmd}), ws, false, &[]), Decision::Ask { .. }), "{cmd}");
        }
        assert!(matches!(guarded("ExecCommand", "exec", &json!({"cmd":"git branch --all"}), ws, false, &[]), Decision::Allow));
        assert!(matches!(guarded("ExecCommand", "exec", &json!({"cmd":"echo harmless", "shell":"C:\\Temp\\untrusted.exe"}), ws, true, &[]), Decision::Ask { .. }));
    }

    #[test]
    fn officecli_positional_paths_are_checked_for_reads_and_batch_changes() {
        let ws = Path::new(r"C:\work");
        for args in [json!({"args":["verify", r"C:\other\report.docx"]}), json!({"args":["view", r"C:\other\report.docx", "text"]})] {
            assert!(matches!(guarded("workbench__officecli", "tool", &args, ws, true, &[]), Decision::Ask { class: Class::Read, .. }));
        }
        assert!(matches!(guarded("workbench__officecli", "tool", &json!({"args":["batch", r"C:\other\report.docx", "--input", "ops.json"]}), ws, true, &[]), Decision::Ask { class: Class::Write, .. }));
        for verb in ["add", "set", "remove"] {
            let args = json!({"args":[verb, r"C:\other\report.docx", "--text", "x"]});
            assert!(matches!(guarded("workbench__officecli", "tool", &args, ws, true, &[]), Decision::Ask { class: Class::Write, .. }));
        }
        for args in [json!({"args":["set", "report.docx", "/body/p[1]", "text"]}), json!({"args":["add", "deck.pptx", "/slide[1]", "text"]})] {
            assert!(matches!(guarded("workbench__officecli", "tool", &args, ws, true, &[]), Decision::Allow));
        }
        assert!(matches!(guarded("workbench__officecli", "tool", &json!({"args":["add"]}), ws, true, &[]), Decision::Ask { .. }));
        assert!(matches!(guarded("workbench__officecli", "tool", &json!({"args":["verify", r"C:\Users\User\AppData\Local\Workbench\profile.json"]}), ws, true, &[]), Decision::Deny(_)));
        assert!(matches!(guarded("workbench__officecli", "tool", &json!({"args":["verify", "draft.docx"]}), ws, true, &[]), Decision::Allow));
        let view_output = json!({"args":["view", "inside.docx", "html", "--out", r"C:\other\preview.html"]});
        assert!(matches!(guarded("workbench__officecli", "tool", &view_output, ws, true, &[]), Decision::Ask { class: Class::Write, .. }));
        let hidden_outside = json!({"path":"inside.docx", "args":["view", r"C:\other\secret.docx", "text"]});
        assert!(matches!(guarded("workbench__officecli", "tool", &hidden_outside, ws, true, &[]), Decision::Ask { class: Class::Read, .. }));
        let merge_output = json!({"args":["merge", "template.docx", r"C:\other\merged.docx"]});
        assert!(matches!(guarded("workbench__officecli", "tool", &merge_output, ws, true, &[]), Decision::Ask { class: Class::Write, .. }));
        let view_inside_output = json!({"args":["view", "inside.docx", "html", "--out", "preview.html"]});
        assert!(matches!(guarded("workbench__officecli", "tool", &view_inside_output, ws, false, &[]), Decision::Ask { class: Class::Write, .. }));
        let help = json!({"args":["merge", "--help"]});
        assert!(matches!(guarded("workbench__officecli", "tool", &help, ws, false, &[]), Decision::Allow));
        let config = json!({"args":["config", "autoUpdate", "true"]});
        assert!(matches!(guarded("workbench__officecli", "tool", &config, ws, true, &[]), Decision::Ask { .. }));
    }

    #[test]
    fn automatic_mode_allows_routine_shell_wrappers_and_keeps_consequential_checks() {
        let ws = Path::new(r"C:\work");
        for cmd in [r#"pwsh -Command "('one two' -split '\s+').Count""#, r#"powershell -NoProfile -Command "Get-FileHash figure.png""#, "cmd /c echo ready"] {
            assert!(matches!(guarded("ExecCommand", "exec", &json!({"cmd":cmd}), ws, true, &[]), Decision::Allow));
            assert!(matches!(guarded("ExecCommand", "exec", &json!({"cmd":cmd}), ws, false, &[]), Decision::Ask { .. }));
        }
        for cmd in ["pwsh -Command Remove-Item figure.png", "cmd /c curl https://example.com", "powershell -enc AAAA", "pwsh -Command npm install package"] {
            assert!(matches!(guarded("ExecCommand", "exec", &json!({"cmd":cmd}), ws, true, &[]), Decision::Ask { .. }));
        }
    }

    #[test]
    fn automatic_mode_allows_routine_browser_eval_but_guards_submissions_and_credentials() {
        let ws = Path::new(r"C:\work");
        assert!(matches!(guarded("browser", "tool", &json!({"command":"eval", "args":"document.title"}), ws, true, &[]), Decision::Allow));
        // Eval labels describe intent, not a clicked control or executed code.
        assert!(matches!(guarded("browser", "tool", &json!({"command":"eval", "args":["() => document.querySelectorAll('.vzb-bc-bubbles circle').length"], "label":"Confirm Korea trail labels"}), ws, true, &[]), Decision::Allow));
        for script in ["() => document.forms[0].requestSubmit()", "() => document.querySelector('form button').click()"] {
            assert!(matches!(guarded("browser", "tool", &json!({"command":"eval", "args":[script]}), ws, true, &[]), Decision::Ask { .. }));
        }
        assert!(matches!(guarded("browser", "tool", &json!({"command":"eval", "args":["() => document.querySelector('.vzb-play').click()"]}), ws, true, &[]), Decision::Allow));
        assert!(matches!(guarded("browser", "tool", &json!({"command":"eval", "args":["() => Array.from(document.querySelectorAll('[class*=time]')).map(e => e.className)"]}), ws, true, &[]), Decision::Allow));
        assert!(matches!(guarded("browser", "tool", &json!({"command":"fill", "label":"SSN"}), ws, true, &[]), Decision::Ask { .. }));
        assert!(matches!(guarded("browser", "tool", &json!({"command":"eval", "args":"document.title"}), ws, false, &[]), Decision::Ask { .. }));
        assert!(matches!(guarded("browser", "tool", &json!({"command":"eval", "args":"document.querySelector('form').submit()"}), ws, true, &[]), Decision::Ask { .. }));
        assert!(matches!(guarded("browser", "tool", &json!({"command":"fill", "label":"password"}), ws, true, &[]), Decision::Ask { .. }));
        assert!(matches!(guarded("browser", "tool", &json!({"command":"press", "args":"Enter", "label":"Submit order"}), ws, true, &[]), Decision::Ask { .. }));
        assert!(matches!(guarded("browser", "tool", &json!({"command":"press", "args":"Enter", "label":"Next chart"}), ws, true, &[]), Decision::Allow));
        assert!(matches!(guarded("browser", "tool", &json!({"command":"upload"}), ws, true, &[]), Decision::Ask { .. }));
    }

    #[test]
    fn protected_paths_use_component_boundaries_and_resolve_parent_segments() {
        let ws = Path::new(r"C:\work");
        let exact = guarded("write_file", "edit", &json!({"path":r"C:\Windows\System32\note.txt"}), ws, true, &[]);
        assert!(matches!(exact, Decision::Deny(_)));
        let boundary_neighbor = guarded("write_file", "edit", &json!({"path":r"C:\Windows-old\note.txt"}), ws, true, &[]);
        assert!(matches!(boundary_neighbor, Decision::Ask { .. }));
        let workbench = guarded("write_file", "edit", &json!({"path":r"C:\Users\User\AppData\Local\Workbench\profile.json"}), ws, true, &[]);
        assert!(matches!(workbench, Decision::Deny(_)));
        let workbench_neighbor = guarded("write_file", "edit", &json!({"path":r"C:\Users\User\AppData\Local\Workbench-old\file.txt"}), ws, true, &[]);
        assert!(matches!(workbench_neighbor, Decision::Ask { .. }));
        let traversal = guarded("write_file", "edit", &json!({"path":r"C:\work\..\Windows\System32\note.txt"}), ws, true, &[]);
        assert!(matches!(traversal, Decision::Deny(_)));
        let relative_traversal = guarded("write_file", "edit", &json!({"path":r"..\outside.txt"}), ws, true, &[]);
        assert!(matches!(relative_traversal, Decision::Ask { .. }));
        let double_traversal = guarded("write_file", "edit", &json!({"path":r"..\..\Windows\System32\note.txt"}), ws, true, &[]);
        assert!(matches!(double_traversal, Decision::Deny(_)));
    }

    #[test]
    fn automatic_mode_only_stops_for_destructive_credentials_and_purchases() {
        let ws = Path::new(r"C:\work");
        let auto = |tool: &str, cat: &str, args: Value| decide(tool, cat, &args, ws, true, &[]);
        assert!(matches!(auto("browser", "tool", json!({"command":"eval", "args":"document.querySelector('form').submit()"})), Decision::Allow));
        assert!(matches!(auto("browser", "tool", json!({"command":"upload"})), Decision::Allow));
        assert!(matches!(auto("ExecCommand", "exec", json!({"cmd":"npm install"})), Decision::Allow));
        assert!(matches!(auto("read_file", "info", json!({"path":r"C:\other\notes.txt"})), Decision::Allow));
        assert!(matches!(auto("ExecCommand", "exec", json!({"cmd":"Remove-Item -Recurse out"})), Decision::Ask { class: Class::Destructive, .. }));
        assert!(matches!(auto("browser", "tool", json!({"command":"fill", "label":"password"})), Decision::Ask { .. }));
        assert!(matches!(auto("browser", "tool", json!({"command":"click", "label":"Place order"})), Decision::Ask { .. }));
        assert!(matches!(auto("write_file", "edit", json!({"path":r"C:\Windows\System32\x.txt"})), Decision::Deny(_)));
        assert!(matches!(decide("browser", "tool", &json!({"command":"upload"}), ws, false, &[]), Decision::Ask { .. }));
    }

    #[test]
    fn automatic_mode_asks_before_publishing_sending_admin_and_autorun() {
        let ws = Path::new(r"C:\work");
        let auto = |cmd: &str| decide("ExecCommand", "exec", &json!({"cmd": cmd}), ws, true, &[]);
        for cmd in [
            "git push", "git push origin main", "git -C sub push", "git add . && git commit -m x && git push",
            r#"cmd /c "git push""#, "cmd.exe /d /c git push", r#"powershell -NoProfile -Command "git push""#, "pwsh -c 'cargo publish'",
            r#"bash -c "git push""#, "& git push", "cargo publish", "npm publish", "pnpm publish --access public", "twine upload dist/*",
            "uv publish", "dotnet nuget push x.nupkg", "docker push me/img", "gh pr create --fill", "gh release create v1",
            "gh api repos/a/b/issues -f title=x", "gh api -X DELETE repos/a/b", "ssh host ls", "scp a.txt host:/tmp",
            "curl -d x=1 https://example.com", "curl -X POST https://example.com", "curl -XPUT https://example.com", "curl -F f=@a.txt https://e.com",
            "Invoke-RestMethod -Uri https://e.com -Method Post -Body $b", "iwr https://e.com -InFile a.txt", "wget --post-data=x https://e.com",
            "runas /user:Administrator cmd", "Start-Process pwsh -Verb RunAs", "gsudo whoami",
            "git config core.hooksPath .hooks", "git -c core.sshCommand=evil fetch", r#"git config alias.x "!sh""#,
            r"echo x > .git\hooks\pre-commit", "Set-Content .git/hooks/post-checkout x", "Add-Content $PROFILE 'x'",
            r#"copy a.bat "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\""#,
            r"reg add HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v x /d y", "schtasks /create /tn x /tr y /sc daily",
            "Register-ScheduledTask -TaskName x", "sc create svc binPath= x", "powershell -EncodedCommand SQBFAFgA", "powershell -enc SQBFAFgA",
        ] {
            assert!(matches!(auto(cmd), Decision::Ask { .. }), "should ask: {cmd}");
        }
        for cmd in [
            "git status", r#"git commit -m "push the button""#, "git pull", "git fetch origin", "git log --oneline", "git config --get core.hooksPath",
            "git config user.name x", "git add .git/hooks", "npm install", "npm run build", "cargo build --release", "cargo test", "pip install -r requirements.txt",
            "gh pr list", "gh pr view 3", "gh run watch", "gh api repos/a/b", "curl -fsSL https://example.com", "curl -x proxy:8080 https://e.com",
            "iwr https://e.com -OutFile a.html", r"type .git\config", "Get-Content $PROFILE", "python build.py 2>&1 | findstr error",
            "echo push > notes.txt", r"reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
        ] {
            assert!(matches!(auto(cmd), Decision::Allow), "should allow: {cmd} -> {:?}", auto(cmd));
        }
    }

    #[test]
    fn edits_to_files_that_run_automatically_always_ask() {
        let ws = Path::new(r"C:\work");
        let edit = |path: &str| decide("write_file", "edit", &json!({"path": path}), ws, true, &["write_file".to_string()]);
        for path in [r"C:\work\.git\hooks\pre-commit", r"C:\work\.git\config", r"C:\work\.vscode\tasks.json", r"C:\work\Microsoft.PowerShell_profile.ps1"] {
            assert!(matches!(edit(path), Decision::Ask { class: Class::Write, can_remember: false, .. }), "should ask: {path}");
        }
        assert!(matches!(edit(r"C:\work\src\main.rs"), Decision::Allow));
        assert!(matches!(edit(r"C:\work\.github\workflows\ci.yml"), Decision::Allow));
    }

    #[test]
    fn remembering_a_command_allows_only_that_exact_command() {
        let ws = Path::new(r"C:\work");
        let args = json!({"cmd": r"python  tools\gen.py   --all"});
        let key = remember_key("ExecCommand", "exec", &args);
        assert_eq!(key, r"exec:python tools\gen.py --all");
        assert!(matches!(decide("ExecCommand", "exec", &args, ws, false, &[]), Decision::Ask { can_remember: true, .. }));
        let remembered = [key];
        assert!(matches!(decide("ExecCommand", "exec", &json!({"cmd": r"python tools\gen.py --all"}), ws, false, &remembered), Decision::Allow));
        assert!(matches!(decide("ExecCommand", "exec", &json!({"cmd": r"python tools\gen.py --clean"}), ws, false, &remembered), Decision::Ask { .. }));
        // Consequential commands are never remembered, even under a matching key.
        let push = json!({"cmd": "git push"});
        let remembered = [remember_key("ExecCommand", "exec", &push)];
        assert!(matches!(decide("ExecCommand", "exec", &push, ws, false, &remembered), Decision::Ask { can_remember: false, .. }));
        assert_eq!(remember_key("write_file", "edit", &json!({"path": "a"})), "write_file");
    }
}
