//! Reusable task setup; applying never starts an agent or writes outside the saved workspace.
use crate::{store, App};
use rusqlite::Connection;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::State;

fn name(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 120 || value.chars().any(char::is_control) {
        return Err("A task template needs a name of 1–120 characters".into());
    }
    Ok(value)
}

fn inputs(workspace: &str, document: Option<&str>) -> Result<(PathBuf, Option<PathBuf>), String> {
    let mut missing = vec![];
    let root = Path::new(workspace);
    if !root.is_absolute() || !root.is_dir() {
        missing.push(format!("Working folder missing or invalid: {workspace}"));
    }
    let source = document.map(Path::new);
    if let Some(file) = source {
        if !file.is_absolute()
            || !file.is_file()
            || file.components().any(|c| {
                matches!(c,
            std::path::Component::Normal(n) if n.to_string_lossy().contains(':'))
            })
        {
            missing.push(format!(
                "Template file missing or invalid: {}",
                file.display()
            ));
        }
    }
    if !missing.is_empty() {
        return Err(missing.join("\n"));
    }
    Ok((
        root.canonicalize()
            .map_err(|e| format!("Working folder {workspace}: {e}"))?,
        source
            .map(|p| {
                p.canonicalize()
                    .map_err(|e| format!("Template file {}: {e}", p.display()))
            })
            .transpose()?,
    ))
}

fn save(
    c: &Connection,
    id: &str,
    title: &str,
    prompt: &str,
    workspace: &str,
    document: Option<&str>,
) -> Result<(), String> {
    let title = name(title)?;
    if prompt.trim().is_empty() {
        return Err("A task template needs a prompt".into());
    }
    let (root, source) = inputs(workspace, document)?;
    store::create_task_template(
        c,
        id,
        title,
        prompt,
        &crate::documents::native_path(&root),
        source
            .as_ref()
            .map(|p| crate::documents::native_path(p))
            .as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct AppliedTemplate {
    id: String,
    prompt: String,
    workspace: String,
    files: Vec<String>,
}

fn copy_attachment(root: &Path, source: &Path) -> Result<(PathBuf, String), String> {
    let dir = root.join("attachments");
    if !dir.exists() {
        fs::create_dir(&dir).map_err(|e| format!("Attachments: {e}"))?;
    }
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("Attachments: {e}"))?;
    if !dir.starts_with(root) || !dir.is_dir() {
        return Err("Attachments folder must be inside the workspace".into());
    }
    let filename = source
        .file_name()
        .ok_or("Template file has no name")?
        .to_string_lossy();
    let clean: String = filename
        .chars()
        .map(|c| {
            if c.is_control() || r#"\/:*?"<>|"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let (stem, ext) = clean
        .rsplit_once('.')
        .map(|(a, b)| (a, format!(".{b}")))
        .unwrap_or((&clean, String::new()));
    let mut input =
        fs::File::open(source).map_err(|e| format!("Template file {}: {e}", source.display()))?;
    for n in 1..10000 {
        let filename = if n == 1 {
            clean.clone()
        } else {
            format!("{stem}-{n}{ext}")
        };
        let target = dir.join(&filename);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut output) => {
                if let Err(e) = std::io::copy(&mut input, &mut output) {
                    drop(output);
                    let _ = fs::remove_file(&target);
                    return Err(format!("Could not copy template file: {e}"));
                }
                return Ok((target, format!("attachments/{filename}")));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not copy template file: {e}")),
        }
    }
    Err("Too many copies of this template file in the workspace".into())
}

fn apply(c: &Connection, template_id: &str, chat_id: &str) -> Result<AppliedTemplate, String> {
    let template = store::task_template(c, template_id)
        .map_err(|e| format!("Could not load task template: {e}"))?;
    let (root, source) = inputs(&template.workspace, template.document.as_deref())?;
    let copied = source
        .as_ref()
        .map(|p| copy_attachment(&root, p))
        .transpose()?;
    let workspace = crate::documents::native_path(&root);
    if let Err(e) = store::create_conv(c, chat_id, &workspace) {
        if let Some((file, _)) = &copied {
            let _ = fs::remove_file(file);
        }
        return Err(e.to_string());
    }
    Ok(AppliedTemplate {
        id: chat_id.into(),
        prompt: template.prompt,
        workspace,
        files: copied.into_iter().map(|(_, relative)| relative).collect(),
    })
}

#[tauri::command(async)]
pub fn task_templates_list(s: State<App>) -> Result<Vec<store::TaskTemplate>, String> {
    store::list_task_templates(&*s.db.lock().map_err(|_| "Database lock unavailable")?)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn task_template_save(
    s: State<App>,
    name: String,
    prompt: String,
    workspace: String,
    document: Option<String>,
) -> Result<(), String> {
    save(
        &*s.db.lock().map_err(|_| "Database lock unavailable")?,
        &crate::new_id(),
        &name,
        &prompt,
        &workspace,
        document.as_deref(),
    )
}

#[tauri::command(async)]
pub fn task_template_apply(s: State<App>, id: String) -> Result<AppliedTemplate, String> {
    apply(
        &*s.db.lock().map_err(|_| "Database lock unavailable")?,
        &id,
        &crate::new_id(),
    )
}

#[tauri::command(async)]
pub fn task_template_rename(s: State<App>, id: String, title: String) -> Result<(), String> {
    let title = name(&title)?;
    let changed = store::rename_task_template(
        &*s.db.lock().map_err(|_| "Database lock unavailable")?,
        &id,
        title,
    )
    .map_err(|e| e.to_string())?;
    if !changed {
        return Err("Task template no longer exists".into());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn task_template_delete(s: State<App>, id: String) -> Result<(), String> {
    store::delete_task_template(&*s.db.lock().map_err(|_| "Database lock unavailable")?, &id)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;
    use std::{fs, path::PathBuf};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "localwork-templates-{:016x}",
                rand::random::<u64>()
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn applying_copies_without_overwriting_and_creates_an_empty_chat() {
        let temp = Temp::new();
        let ws = temp.0.join("work");
        fs::create_dir(&ws).unwrap();
        let source = temp.0.join("report.docx");
        fs::write(&source, b"document fixture").unwrap();
        let c = store::open(&temp.0).unwrap();
        save(
            &c,
            "t",
            " Weekly report ",
            "Draft this week's report",
            ws.to_str().unwrap(),
            Some(source.to_str().unwrap()),
        )
        .unwrap();
        let first = apply(&c, "t", "c1").unwrap();
        assert_eq!(first.prompt, "Draft this week's report");
        assert_eq!(first.files, vec!["attachments/report.docx"]);
        assert_eq!(
            fs::read(ws.join(&first.files[0])).unwrap(),
            b"document fixture"
        );
        fs::write(ws.join(&first.files[0]), b"edited").unwrap();
        let second = apply(&c, "t", "c2").unwrap();
        assert_eq!(second.files, vec!["attachments/report-2.docx"]);
        assert_eq!(fs::read(ws.join(&first.files[0])).unwrap(), b"edited");
        assert_eq!(fs::read(source).unwrap(), b"document fixture");
        assert_eq!(store::list_convs(&c).len(), 2);
        assert!(store::messages(&c, "c1", 0).is_empty());
        assert_eq!(store::task_template(&c, "t").unwrap().name, "Weekly report");
    }

    #[test]
    fn missing_inputs_do_not_create_a_chat_or_attachment() {
        let temp = Temp::new();
        let ws = temp.0.join("work");
        fs::create_dir(&ws).unwrap();
        let source = temp.0.join("report.xlsx");
        fs::write(&source, b"fixture").unwrap();
        let c = store::open(&temp.0).unwrap();
        save(
            &c,
            "t",
            "Budget",
            "Review",
            ws.to_str().unwrap(),
            Some(source.to_str().unwrap()),
        )
        .unwrap();
        fs::remove_file(&source).unwrap();
        let error = apply(&c, "t", "c1").err().unwrap();
        assert!(error.contains("report.xlsx"), "{error}");
        assert!(!ws.join("attachments").exists());
        fs::remove_dir(&ws).unwrap();
        let error = apply(&c, "t", "c2").err().unwrap();
        assert!(
            error.contains("work") && error.contains("report.xlsx"),
            "{error}"
        );
        assert!(store::list_convs(&c).is_empty());
    }

    #[test]
    fn failed_chat_creation_removes_only_the_new_copy() {
        let temp = Temp::new();
        let ws = temp.0.join("work");
        fs::create_dir(&ws).unwrap();
        let source = temp.0.join("report.docx");
        fs::write(&source, b"fixture").unwrap();
        let c = store::open(&temp.0).unwrap();
        save(
            &c,
            "t",
            "Report",
            "Draft",
            ws.to_str().unwrap(),
            Some(source.to_str().unwrap()),
        )
        .unwrap();
        apply(&c, "t", "existing").unwrap();
        assert!(apply(&c, "t", "existing").is_err());
        assert_eq!(
            fs::read(ws.join("attachments/report.docx")).unwrap(),
            b"fixture"
        );
        assert!(!ws.join("attachments/report-2.docx").exists());
        assert_eq!(store::list_convs(&c).len(), 1);
    }

    #[test]
    fn validates_names_folders_and_optional_files() {
        let temp = Temp::new();
        let c = store::open(&temp.0).unwrap();
        let root = temp.0.to_str().unwrap();
        assert!(name(&"x".repeat(121)).is_err());
        assert!(name("Bad\nname").is_err());
        assert!(save(&c, "t", "  ", "Prompt", root, None).is_err());
        assert!(save(&c, "t", "Name", " ", root, None).is_err());
        assert!(save(&c, "t", "Name", "Prompt", "relative", None).is_err());
        assert!(save(&c, "t", "Name", "Prompt", root, Some(root)).is_err());
        save(&c, "t", "Name", "Prompt", root, None).unwrap();
        assert!(apply(&c, "t", "c1").unwrap().files.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_an_attachments_symlink_outside_the_workspace() {
        let temp = Temp::new();
        let ws = temp.0.join("work");
        let outside = temp.0.join("outside");
        fs::create_dir(&ws).unwrap();
        fs::create_dir(&outside).unwrap();
        let source = temp.0.join("report.docx");
        fs::write(&source, b"fixture").unwrap();
        std::os::unix::fs::symlink(&outside, ws.join("attachments")).unwrap();
        let c = store::open(&temp.0).unwrap();
        save(
            &c,
            "t",
            "Name",
            "Prompt",
            ws.to_str().unwrap(),
            Some(source.to_str().unwrap()),
        )
        .unwrap();
        assert!(apply(&c, "t", "c1").is_err());
        assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
        assert!(store::list_convs(&c).is_empty());
    }
}
