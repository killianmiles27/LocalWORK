#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    open_external_url(&url)
}

pub fn open_external_url(input: &str) -> Result<(), String> {
    let url = validate_external_url(input)?;

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let operation: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = std::ffi::OsStr::new(url.as_str())
            .encode_wide()
            .chain(Some(0))
            .collect();
        let result = unsafe {
            ShellExecuteW(
                HWND(std::ptr::null_mut()),
                PCWSTR(operation.as_ptr()),
                PCWSTR(target.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            return Err(format!(
                "Windows could not open the link (error {})",
                result.0 as isize
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Opening external links is only supported on Windows".into())
    }
}

pub fn reveal_folder(path: &str) -> Result<(), String> {
    let folder = std::path::Path::new(path);
    if !folder.is_dir() {
        return Err("Chat folder no longer exists".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let target: Vec<u16> = folder.as_os_str().encode_wide().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                HWND(std::ptr::null_mut()),
                PCWSTR::null(),
                PCWSTR(target.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            return Err(format!(
                "Windows could not show the chat folder (error {})",
                result.0 as isize
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Showing folders is only supported on Windows".into())
    }
}

fn validate_external_url(input: &str) -> Result<tauri::Url, String> {
    if !(input
        .get(..7)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("http://"))
        || input
            .get(..8)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://")))
    {
        return Err("Only absolute web links can be opened externally".into());
    }
    let url = tauri::Url::parse(input).map_err(|_| "Invalid link".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only web links can be opened externally".into());
    }
    Ok(url)
}

pub fn is_app_navigation(url: &tauri::Url) -> bool {
    if url.scheme() != "http" {
        return false;
    }
    match url.host_str() {
        Some("tauri.localhost") => true,
        Some("localhost" | "127.0.0.1") => url.port_or_known_default() == Some(1420),
        _ => false,
    }
}

pub fn existing_workspace(path: &str) -> Result<String, String> {
    let path = std::path::Path::new(path);
    if !path.is_dir() {
        return Err("Workspace folder does not exist".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_absolute_http_links_are_accepted() {
        assert!(validate_external_url("https://example.com/a?q=1").is_ok());
        assert!(validate_external_url("http://localhost:3000").is_ok());
        for value in [
            "file:///C:/secret.txt",
            "javascript:alert(1)",
            "https:example.com",
            "not a link",
        ] {
            assert!(
                validate_external_url(value).is_err(),
                "unexpected acceptance: {value}"
            );
        }
        assert!(is_app_navigation(
            &tauri::Url::parse("http://localhost:1420/").unwrap()
        ));
        assert!(is_app_navigation(
            &tauri::Url::parse("http://tauri.localhost/").unwrap()
        ));
        assert!(!is_app_navigation(
            &tauri::Url::parse("https://example.com/").unwrap()
        ));
        assert!(!is_app_navigation(
            &tauri::Url::parse("http://localhost:3000/").unwrap()
        ));
    }

    #[test]
    fn workspace_must_already_exist() {
        let temp =
            std::env::temp_dir().join(format!("localwork-workspace-{}", crate::store::now()));
        std::fs::create_dir_all(&temp).unwrap();
        assert_eq!(
            existing_workspace(temp.to_str().unwrap()).unwrap(),
            temp.to_string_lossy()
        );
        assert!(existing_workspace(temp.join("missing").to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir(&temp);
    }
}
