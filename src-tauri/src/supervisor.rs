//! Process containment: one Job Object (KILL_ON_JOB_CLOSE) holds the host and everything it spawns,
//! every child is started with CREATE_NO_WINDOW, and pids.json lets the next start clean up after a crash.
//! On Linux each child leads its own process group, so kill_tree takes the whole group; the app's exit
//! handler stops children, and pids.json covers a crashed host on the next start.
use crate::sync::LockExt;
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
#[cfg(windows)]
use windows::core::PWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::CloseHandle;
#[cfg(windows)]
use windows::Win32::System::JobObjects::*;
#[cfg(windows)]
use windows::Win32::System::Threading::*;

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
static PIDS_LOCK: Mutex<()> = Mutex::new(());

/// Put the host process itself in a kill-on-close job; children inherit membership with no spawn race.
/// When the host dies for any reason the last handle closes and Windows kills the whole tree.
#[cfg(windows)]
pub fn init_job() -> Result<(), String> {
    unsafe {
        let job = CreateJobObjectW(None, None).map_err(|e| e.to_string())?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|e| e.to_string())?;
        AssignProcessToJobObject(job, GetCurrentProcess()).map_err(|e| e.to_string())?;
        // Deliberately leak the handle: it must stay open for the life of the host.
        let _ = job; // handle intentionally leaked: closing it would kill us
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn init_job() -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub fn hidden(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(unix)]
pub fn hidden(cmd: &mut Command) -> &mut Command {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PidRec {
    pub pid: u32,
    pub exe: String,
    pub role: String,
}

#[cfg(windows)]
pub fn image_path(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_FORMAT(0), PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        ok.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

#[cfg(unix)]
pub fn image_path(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(windows)]
pub fn kill_tree(pid: u32) {
    let mut c = Command::new("taskkill");
    c.args(["/PID", &pid.to_string(), "/T", "/F"]);
    hidden(&mut c);
    let _ = c.output();
}

/// Children started through `hidden` lead their own process group, so the group id is the pid.
#[cfg(unix)]
pub fn kill_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    let _ = Command::new("kill").args(["-KILL", "--", &format!("-{pid}")]).output();
    let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).output();
}

fn read_pids(path: &Path) -> Vec<PidRec> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_pids(path: &Path, v: &[PidRec]) {
    let _ = std::fs::write(path, serde_json::to_string_pretty(v).unwrap_or_else(|_| "[]".into()));
}

pub fn record(data: &Path, rec: PidRec) {
    let _g = PIDS_LOCK.guard();
    let p = data.join("pids.json");
    let mut v = read_pids(&p);
    v.retain(|r| r.pid != rec.pid);
    v.push(rec);
    write_pids(&p, &v);
}

pub fn forget(data: &Path, pid: u32) {
    let _g = PIDS_LOCK.guard();
    let p = data.join("pids.json");
    let mut v = read_pids(&p);
    v.retain(|r| r.pid != pid);
    write_pids(&p, &v);
}

/// Kill anything a previous run left behind. A pid is only killed if its image still matches what we recorded
/// (pids get reused), so an unrelated process is never touched.
pub fn cleanup_stale(data: &Path) -> usize {
    let _g = PIDS_LOCK.guard();
    let p = data.join("pids.json");
    let mut killed = 0;
    for r in read_pids(&p) {
        if let Some(img) = image_path(r.pid) {
            if same_image(&img, &r.exe) {
                kill_tree(r.pid);
                killed += 1;
            }
        }
    }
    write_pids(&p, &[]);
    killed
}

/// Linux resolves symlinks in /proc/<pid>/exe (a venv python points at the system one), so compare resolved paths.
pub fn same_image(actual: &str, recorded: &str) -> bool {
    if cfg!(windows) {
        return actual.eq_ignore_ascii_case(recorded);
    }
    let resolved = std::fs::canonicalize(recorded).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| recorded.to_string());
    actual == recorded || actual == resolved
}
