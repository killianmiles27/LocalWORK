//! Which Python runs the Workbench MCP server.
//! Users who run their own model server (LM Studio, Ollama, llama.cpp, vLLM) have no Strata folder,
//! so an explicit setting and the system Python matter as much as Strata's virtual environment.
use crate::{paths, supervisor};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The tools need 3.11 or newer; older interpreters are skipped rather than failing later.
pub const MIN: (u32, u32) = (3, 11);

/// Where a candidate came from. The order of this enum is the order they are tried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `workbenchPython` in settings.json, picked in Settings → Python for tools.
    Setting,
    /// The `.venv` inside the configured Strata folder.
    Strata,
    /// `python3`/`py -3`/`python` on PATH.
    System,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Setting => "chosen in Settings",
            Source::Strata => "Strata's virtual environment",
            Source::System => "system Python",
        }
    }
}

/// One way to start Python. `lead` carries the arguments that select the version, because
/// Windows' `py` launcher needs `-3` before the script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub source: Source,
    pub program: PathBuf,
    pub lead: Vec<String>,
}

impl Candidate {
    fn new(source: Source, program: impl Into<PathBuf>, lead: &[&str]) -> Self {
        Candidate { source, program: program.into(), lead: lead.iter().map(|a| a.to_string()).collect() }
    }
}

/// An interpreter that ran, described by where it is and what it is, not by how it was started
/// (`py -3` and a symlink both resolve to the executable Python reports for itself).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub source: Source,
    pub path: PathBuf,
    pub version: (u32, u32),
}

impl Found {
    pub fn version_text(&self) -> String {
        format!("{}.{}", self.version.0, self.version.1)
    }
}

/// Candidates in the order they must be tried: an explicit setting, Strata's venv, then the system
/// Python. A blank setting or blank Strata folder is skipped instead of becoming a relative path.
pub fn candidates(setting: Option<&str>, strata_root: Option<&Path>) -> Vec<Candidate> {
    let mut list = Vec::new();
    if let Some(path) = setting.map(str::trim).filter(|p| !p.is_empty()) {
        list.push(Candidate::new(Source::Setting, path, &[]));
    }
    if let Some(root) = strata_root.filter(|r| !r.as_os_str().is_empty()) {
        list.push(Candidate::new(Source::Strata, paths::venv_python(root), &[]));
    }
    list.extend(system());
    list
}

fn system() -> Vec<Candidate> {
    #[cfg(windows)]
    {
        vec![
            // The official installer's launcher: pick 3 explicitly, and let the probe report the real path.
            Candidate::new(Source::System, "py", &["-3"]),
            Candidate::new(Source::System, "python", &[]),
            Candidate::new(Source::System, "python3", &[]),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![Candidate::new(Source::System, "python3", &[]), Candidate::new(Source::System, "python", &[])]
    }
}

/// Printed by `-c` so one process answers both questions: which version, and which executable it
/// really is. One value per line keeps paths with spaces intact.
const PROBE: &str = "import sys;print(sys.version_info[0]);print(sys.version_info[1]);print(sys.executable)";

fn parse_probe(stdout: &str) -> Option<((u32, u32), PathBuf)> {
    let mut lines = stdout.lines().map(str::trim);
    let major: u32 = lines.next()?.parse().ok()?;
    let minor: u32 = lines.next()?.parse().ok()?;
    let exe = lines.next()?;
    if exe.is_empty() { return None; }
    Some(((major, minor), PathBuf::from(exe)))
}

/// Run a candidate once. None when it does not start or does not answer as Python.
fn probe(c: &Candidate) -> Option<((u32, u32), PathBuf)> {
    let mut cmd = Command::new(&c.program);
    cmd.args(&c.lead).args(["-c", PROBE])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    supervisor::hidden(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() { return None; }
    parse_probe(&String::from_utf8_lossy(&out.stdout))
}

/// The first candidate that runs a supported Python, skipping older versions. The probe is a
/// parameter so the selection order can be tested without starting a process.
pub fn select(candidates: &[Candidate], mut probe: impl FnMut(&Candidate) -> Option<((u32, u32), PathBuf)>) -> Option<Found> {
    candidates.iter().find_map(|c| {
        let (version, path) = probe(c)?;
        (version >= MIN).then_some(Found { source: c.source, path, version })
    })
}

/// The interpreter for the Workbench MCP server: explicit setting, Strata's venv, system Python.
pub fn find(setting: Option<&str>, strata_root: Option<&Path>) -> Option<Found> {
    select(&candidates(setting, strata_root), probe)
}

/// Validate a path picked in Settings, so a wrong choice fails there instead of on the next chat.
pub fn check(path: &Path) -> Result<Found, String> {
    let candidate = Candidate::new(Source::Setting, path, &[]);
    let Some((version, real)) = probe(&candidate) else {
        return Err(format!("{} did not answer as Python. Choose the interpreter itself (python3 on Linux, python.exe on Windows).", path.display()));
    };
    let found = Found { source: Source::Setting, path: real, version };
    if version < MIN {
        return Err(format!("{} is Python {}, but the Workbench tools need 3.11 or newer.", path.display(), found.version_text()));
    }
    Ok(found)
}

/// What to install when nothing usable was found. Strata users are also offered its virtual
/// environment; users who run their own model server are never told to go and get a Strata folder.
pub fn missing_message(external: bool, strata_root: Option<&Path>) -> String {
    let install = if cfg!(windows) {
        "Install Python 3.11 or newer from python.org and tick \"Add python.exe to PATH\""
    } else {
        "Install Python 3.11 or newer with your package manager (for example sudo apt install python3 or sudo pacman -S python)"
    };
    if external {
        return format!("{install}, then choose the interpreter in Settings → Python for tools.");
    }
    let hint = match strata_root {
        Some(root) => format!("{} was not found or is older than 3.11", paths::venv_python(root).display()),
        None => "no Strata folder is saved".to_string(),
    };
    format!("{install}, or choose a Strata folder in Settings whose .venv provides it ({hint}). You can also pick the interpreter under Settings → Python for tools.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found_for(list: &[Candidate]) -> Option<Found> {
        select(list, |c| Some(((3, 12), c.program.clone())))
    }

    #[test]
    fn an_explicit_setting_wins_over_strata_and_the_system() {
        let list = candidates(Some("/opt/py/bin/python3"), Some(Path::new("/models/strata")));
        let found = found_for(&list).unwrap();
        assert_eq!(found.source, Source::Setting);
        assert_eq!(found.path, PathBuf::from("/opt/py/bin/python3"));
        assert_eq!(found.version_text(), "3.12");
    }

    #[test]
    fn strata_venv_comes_before_the_system_python() {
        let list = candidates(None, Some(Path::new("/models/strata")));
        let found = found_for(&list).unwrap();
        assert_eq!(found.source, Source::Strata);
        assert_eq!(found.path, paths::venv_python(Path::new("/models/strata")));
        assert_eq!(list.iter().filter(|c| c.source == Source::System).count(), system().len());
    }

    #[test]
    fn the_system_python_is_used_without_strata() {
        // An external model server user: no Strata folder saved, and a blank setting left behind.
        for (setting, root) in [(None, None), (Some("  "), Some(Path::new("")))] {
            let list = candidates(setting, root);
            assert!(list.iter().all(|c| c.source == Source::System), "nothing else to try");
            let found = found_for(&list).unwrap();
            assert_eq!(found.source, Source::System);
            assert_eq!(found.path, list[0].program);
        }
    }

    #[test]
    fn versions_older_than_3_11_are_skipped() {
        let list = candidates(None, Some(Path::new("/models/strata")));
        assert!(select(&list, |c| Some(((3, 10), c.program.clone()))).is_none(), "an old Python must never be handed to the tools");
        // Only Python 2 answers on PATH, and `py -3` on Windows would have to be unusable.
        assert!(select(&list, |c| Some(((2, 7), c.program.clone()))).is_none());

        // An old venv is skipped in favour of a usable system Python later in the list.
        let venv = paths::venv_python(Path::new("/models/strata"));
        let found = select(&list, |c| {
            let version = if c.source == Source::Strata { (3, 10) } else { (3, 11) };
            Some((version, c.program.clone()))
        }).unwrap();
        assert_eq!(found.source, Source::System);
        assert_eq!(found.version, (3, 11));
        assert_ne!(found.path, venv);
    }

    #[test]
    fn a_candidate_that_does_not_start_is_skipped() {
        let list = candidates(Some("/missing/python"), Some(Path::new("/models/strata")));
        let venv = paths::venv_python(Path::new("/models/strata"));
        let found = select(&list, |c| (c.program != PathBuf::from("/missing/python")).then(|| ((3, 12), c.program.clone()))).unwrap();
        assert_eq!(found.source, Source::Strata);
        assert_eq!(found.path, venv);
    }

    #[test]
    fn system_candidates_match_the_platform() {
        let list = system();
        assert_eq!(list[0].source, Source::System);
        #[cfg(windows)]
        {
            assert_eq!(list[0].program, PathBuf::from("py"));
            assert_eq!(list[0].lead, vec!["-3".to_string()]);
            assert!(list.iter().any(|c| c.program == PathBuf::from("python")));
        }
        #[cfg(not(windows))]
        {
            assert_eq!(list[0].program, PathBuf::from("python3"));
            assert!(list[0].lead.is_empty());
        }
    }

    #[test]
    fn probe_output_is_read_line_by_line() {
        assert_eq!(parse_probe("3\n12\n/usr/bin/python3\n"), Some(((3, 12), PathBuf::from("/usr/bin/python3"))));
        assert_eq!(parse_probe("3\n13\nC:\\Program Files\\Python313\\python.exe\n"), Some(((3, 13), PathBuf::from("C:\\Program Files\\Python313\\python.exe"))));
        assert_eq!(parse_probe("3\n12\n\n"), None, "an interpreter must name itself");
        assert_eq!(parse_probe("three\n12\n/x\n"), None);
        assert_eq!(parse_probe(""), None);
    }

    #[test]
    fn the_missing_message_fits_the_setup() {
        let external = missing_message(true, None);
        assert!(!external.to_lowercase().contains("strata"), "external-server users must not be sent to Strata: {external}");
        assert!(external.contains("3.11"));
        assert!(external.contains("Python for tools"));

        let strata = missing_message(false, Some(Path::new("/models/strata")));
        assert!(strata.contains("Strata folder"));
        assert!(strata.contains(".venv"), "a Strata user is told where it looked: {strata}");
        assert!(missing_message(false, None).contains("no Strata folder is saved"));
    }

    /// Opt in with `cargo test -- --ignored`: needs a Python on this machine.
    #[test]
    #[ignore = "needs a Python 3.11+ on this machine"]
    fn finds_the_python_on_this_machine() {
        let found = find(None, None).expect("a system Python 3.11+");
        assert_eq!(found.source, Source::System);
        assert!(found.version >= MIN);
        assert!(found.path.is_file(), "{} should exist", found.path.display());

        // A real venv beside a real system Python wins, and a blank setting stays blank.
        #[cfg(unix)]
        {
            let root = std::env::temp_dir().join(format!("lw-python-{:016x}", rand::random::<u64>()));
            std::fs::create_dir_all(root.join(".venv").join("bin")).unwrap();
            std::os::unix::fs::symlink(&found.path, root.join(".venv").join("bin").join("python")).unwrap();
            let from_venv = find(Some("  "), Some(&root)).expect("the venv Python");
            assert_eq!(from_venv.source, Source::Strata);
            assert_eq!(from_venv.version, found.version);
            std::fs::remove_dir_all(&root).unwrap();
        }
    }
}
