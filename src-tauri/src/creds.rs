//! Secrets (cloud API keys, ChatGPT sign-in tokens) live in Windows Credential Manager, never in settings.json.
//! A credential blob holds at most 2560 bytes, so longer secrets are split over `name#0`, `name#1`, ...
use windows::core::{HSTRING, PWSTR};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

const CHUNK: usize = 2000;
static ACCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn target(name: &str, i: usize) -> String {
    format!("LocalWORK:{name}#{i}")
}

fn write_one(t: &str, data: &[u8]) -> Result<(), String> {
    let mut wide: Vec<u16> = t.encode_utf16().chain(Some(0)).collect();
    let mut blob = data.to_vec();
    let c = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(wide.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };
    unsafe { CredWriteW(&c, 0) }.map_err(|e| format!("Could not save to Windows Credential Manager: {e}"))
}

fn read_one(t: &str) -> Option<Vec<u8>> {
    let mut p: *mut CREDENTIALW = std::ptr::null_mut();
    unsafe {
        CredReadW(&HSTRING::from(t), CRED_TYPE_GENERIC, 0, &mut p).ok()?;
        let c = &*p;
        let v = if c.CredentialBlobSize == 0 { Vec::new() } else { std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec() };
        CredFree(p as *const _);
        Some(v)
    }
}

fn delete_one(t: &str) -> bool {
    unsafe { CredDeleteW(&HSTRING::from(t), CRED_TYPE_GENERIC, 0) }.is_ok()
}

pub fn set(name: &str, secret: &str) -> Result<(), String> {
    let _guard = ACCESS.lock().unwrap_or_else(|e| e.into_inner());
    delete_unlocked(name);
    let bytes = secret.as_bytes();
    for (i, part) in bytes.chunks(CHUNK).enumerate() {
        if let Err(e) = write_one(&target(name, i), part) {
            delete_unlocked(name);
            return Err(e);
        }
    }
    Ok(())
}

pub fn get(name: &str) -> Option<String> {
    let _guard = ACCESS.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = vec![];
    for i in 0.. {
        match read_one(&target(name, i)) {
            Some(part) => out.extend(part),
            None => break,
        }
    }
    if out.is_empty() { None } else { String::from_utf8(out).ok() }
}

pub fn delete(name: &str) {
    let _guard = ACCESS.lock().unwrap_or_else(|e| e.into_inner());
    delete_unlocked(name);
}

fn delete_unlocked(name: &str) {
    let mut i = 0;
    while delete_one(&target(name, i)) {
        i += 1;
    }
}
