use super::*;
use std::{fs, path::PathBuf};

struct Fixture {
    base: PathBuf,
    ws: PathBuf,
    data: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base =
            std::env::temp_dir().join(format!("lw-snapshots-{:016x}", rand::random::<u64>()));
        let ws = base.join("workspace");
        let data = base.join("data");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir(&data).unwrap();
        Self { base, ws, data }
    }
    fn snapshot(&self) -> Manifest {
        create_at(&self.data, &self.ws, "chat").unwrap()
    }
    fn list(&self) -> Vec<Manifest> {
        list_at(&self.data, &self.ws, "chat").unwrap()
    }
    fn dir(&self, id: &str) -> PathBuf {
        // Discover the sole chat directory without depending on its key algorithm.
        fs::read_dir(self.data.join("workspace-snapshots"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .join(id)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn snapshot_modify_restore_preserves_new_files_unless_exact() {
    let f = Fixture::new();
    fs::create_dir(f.ws.join("sub")).unwrap();
    fs::write(f.ws.join("sub/a.txt"), "before").unwrap();
    let s = f.snapshot();
    assert_eq!(s.files[0].path, "sub/a.txt");
    assert_eq!(s.files[0].size, 6);
    assert_eq!(
        s.files[0].hash,
        "6db7d803e74f1ffa7d8f5adc0bf95b3e15bf4c8373fffadf546227cc6c6742cb"
    );
    fs::write(f.ws.join("sub/a.txt"), "after").unwrap();
    fs::write(f.ws.join("new.txt"), "new").unwrap();
    let report = restore_at(&f.data, &f.ws, "chat", &s.id, false).unwrap();
    assert_eq!(report.restored, ["sub/a.txt"]);
    assert!(report.deleted.is_empty());
    assert_eq!(
        fs::read_to_string(f.ws.join("sub/a.txt")).unwrap(),
        "before"
    );
    assert!(f.ws.join("new.txt").exists());
    let report = restore_at(&f.data, &f.ws, "chat", &s.id, true).unwrap();
    assert_eq!(report.deleted, ["new.txt"]);
    assert!(!f.ws.join("new.txt").exists());
    assert!(list_at(&f.data, &f.ws, "other-chat").unwrap().is_empty());
    assert!(restore_at(&f.data, &f.ws, "other-chat", &s.id, false).is_err());
}

#[test]
fn unchanged_files_reuse_immutable_snapshot_contents_not_workspace_inodes() {
    let f = Fixture::new();
    fs::write(f.ws.join("a.txt"), "same").unwrap();
    let a = f.snapshot();
    let b = f.snapshot();
    assert_ne!(a.id, b.id);
    assert_eq!(a.files[0].hash, b.files[0].hash);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let x = fs::metadata(f.dir(&a.id).join("files").join(&a.files[0].hash)).unwrap();
        let y = fs::metadata(f.dir(&b.id).join("files").join(&b.files[0].hash)).unwrap();
        assert_eq!(x.ino(), y.ino(), "the test filesystem supports hardlinks");
    }
    fs::write(f.ws.join("a.txt"), "evil").unwrap();
    restore_at(&f.data, &f.ws, "chat", &a.id, false).unwrap();
    assert_eq!(fs::read_to_string(f.ws.join("a.txt")).unwrap(), "same");
}

#[test]
fn excludes_build_folders_and_local_search_indexes_at_every_depth() {
    let f = Fixture::new();
    for name in [
        ".git",
        "node_modules",
        "target",
        ".localwork-index",
        ".search-index",
        "sub/node_modules",
    ] {
        fs::create_dir_all(f.ws.join(name)).unwrap();
        fs::write(f.ws.join(name).join("ignored"), "ignore").unwrap();
    }
    fs::write(f.ws.join("keep"), "keep").unwrap();
    let s = f.snapshot();
    assert_eq!(
        s.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        ["keep"]
    );
    // An app data/snapshot store physically inside the workspace is refused, not recursively copied.
    assert!(create_at(&f.ws.join("app-data"), &f.ws, "chat").is_err());
    assert!(!f.ws.join("app-data").exists());
}

#[test]
fn oversize_files_are_recorded_without_reading_their_contents() {
    let f = Fixture::new();
    fs::File::create(f.ws.join("large.bin"))
        .unwrap()
        .set_len(MAX_FILE_BYTES + 1)
        .unwrap();
    let s = f.snapshot();
    assert!(s.files.is_empty());
    assert_eq!(s.skipped[0].path, "large.bin");
    assert!(s.skipped[0].reason.contains("byte"));
    assert!(
        restore_at(&f.data, &f.ws, "chat", &s.id, true).is_err(),
        "partial snapshots cannot safely delete new files"
    );
    assert!(f.ws.join("large.bin").exists());
}

#[test]
fn file_count_cap_records_unprotected_files() {
    let f = Fixture::new();
    for n in 0..=MAX_FILES {
        fs::write(f.ws.join(format!("{n:05}")), "").unwrap();
    }
    let s = f.snapshot();
    assert_eq!(s.files.len(), MAX_FILES);
    assert_eq!(s.skipped.len(), 1);
    assert!(s.skipped[0].reason.contains("count"));
}

#[test]
fn manifest_traversal_absolute_and_portable_windows_paths_are_refused_before_any_write() {
    let f = Fixture::new();
    fs::write(f.ws.join("a.txt"), "original").unwrap();
    let mut s = f.snapshot();
    fs::write(f.ws.join("a.txt"), "changed").unwrap();
    let manifest = f.dir(&s.id).join("manifest.json");
    for path in [
        "../outside",
        "/absolute",
        "C:/outside",
        "sub/../../outside",
        "sub\\..\\outside",
        "a:stream",
        "./a.txt",
        "sub/.. /outside",
        "a.txt.",
        "a.txt ",
        "NUL",
        "con.txt",
    ] {
        s.files.push(FileRecord {
            path: path.into(),
            size: 8,
            mtime: 0,
            hash: s.files[0].hash.clone(),
        });
        fs::write(&manifest, serde_json::to_vec(&s).unwrap()).unwrap();
        assert!(
            restore_at(&f.data, &f.ws, "chat", &s.id, false).is_err(),
            "{path}"
        );
        assert_eq!(fs::read_to_string(f.ws.join("a.txt")).unwrap(), "changed");
        s.files.pop();
    }
    assert!(restore_at(&f.data, &f.ws, "chat", "../escape", false).is_err());
}

#[cfg(unix)]
#[test]
fn symlinks_are_skipped_and_restore_refuses_existing_symlink_ancestors_and_leaves() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = f.base.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), "outside").unwrap();
    symlink(&outside, f.ws.join("escape")).unwrap();
    fs::create_dir(f.ws.join("sub")).unwrap();
    fs::write(f.ws.join("sub/a"), "old").unwrap();
    let s = f.snapshot();
    assert_eq!(s.files.len(), 1);
    assert!(s.skipped.iter().any(|s| s.path == "escape"));
    fs::remove_dir_all(f.ws.join("sub")).unwrap();
    symlink(&outside, f.ws.join("sub")).unwrap();
    assert!(restore_at(&f.data, &f.ws, "chat", &s.id, false).is_err());
    assert!(!outside.join("a").exists());
    fs::remove_file(f.ws.join("sub")).unwrap();
    fs::create_dir(f.ws.join("sub")).unwrap();
    symlink(outside.join("secret"), f.ws.join("sub/a")).unwrap();
    assert!(restore_at(&f.data, &f.ws, "chat", &s.id, false).is_err());
    assert_eq!(
        fs::read_to_string(outside.join("secret")).unwrap(),
        "outside"
    );
}

#[cfg(unix)]
#[test]
fn redirected_snapshot_store_is_refused_before_writing_inside_workspace() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    symlink(&f.ws, f.data.join("workspace-snapshots")).unwrap();
    assert!(create_at(&f.data, &f.ws, "chat").is_err());
    assert_eq!(fs::read_dir(&f.ws).unwrap().count(), 0);
}

#[test]
fn total_byte_cap_records_files_even_when_individually_small_enough() {
    let f = Fixture::new();
    for n in 0..(MAX_BYTES / MAX_FILE_BYTES) {
        fs::File::create(f.ws.join(format!("a{n}")))
            .unwrap()
            .set_len(MAX_FILE_BYTES)
            .unwrap();
    }
    fs::write(f.ws.join("z-extra"), "x").unwrap();
    let s = f.snapshot();
    assert_eq!(s.files.iter().map(|r| r.size).sum::<u64>(), MAX_BYTES);
    assert!(s
        .skipped
        .iter()
        .any(|s| s.path == "z-extra" && s.reason == "total byte cap"));
}

#[test]
fn exact_restore_handles_renamed_case_without_deleting_the_restored_file() {
    let f = Fixture::new();
    fs::write(f.ws.join("A.txt"), "before").unwrap();
    let s = f.snapshot();
    fs::rename(f.ws.join("A.txt"), f.ws.join("a.txt")).unwrap();
    let report = restore_at(&f.data, &f.ws, "chat", &s.id, true).unwrap();
    assert_eq!(fs::read_to_string(f.ws.join("A.txt")).unwrap(), "before");
    if cfg!(windows) {
        assert!(report.deleted.is_empty());
    } else {
        assert_eq!(report.deleted, ["a.txt"]);
    }
}

#[test]
fn corrupt_blob_is_refused_before_any_restore_write() {
    let f = Fixture::new();
    fs::write(f.ws.join("a"), "before").unwrap();
    fs::write(f.ws.join("b"), "second").unwrap();
    let s = f.snapshot();
    fs::write(f.ws.join("a"), "changed").unwrap();
    fs::write(f.dir(&s.id).join("files").join(&s.files[1].hash), "broken").unwrap();
    assert!(restore_at(&f.data, &f.ws, "chat", &s.id, false).is_err());
    assert_eq!(fs::read_to_string(f.ws.join("a")).unwrap(), "changed");
}

#[test]
fn cleanup_removes_only_requested_chats_snapshots() {
    let f = Fixture::new();
    fs::write(f.ws.join("a"), "original").unwrap();
    f.snapshot();
    create_at(&f.data, &f.ws, "other").unwrap();
    cleanup_at(&f.data, "chat").unwrap();
    cleanup_at(&f.data, "chat").unwrap();
    assert!(f.list().is_empty());
    assert_eq!(list_at(&f.data, &f.ws, "other").unwrap().len(), 1);
    assert_eq!(fs::read_to_string(f.ws.join("a")).unwrap(), "original");
}

#[test]
fn retention_keeps_newest_and_hardlinked_contents_survive_pruning() {
    let f = Fixture::new();
    fs::write(f.ws.join("a"), "old").unwrap();
    let first = f.snapshot();
    let mut last = first.id.clone();
    for _ in 0..KEEP_SNAPSHOTS {
        last = f.snapshot().id;
    }
    let listed = f.list();
    assert_eq!(listed.len(), KEEP_SNAPSHOTS);
    assert!(listed.iter().any(|s| s.id == last));
    assert!(!f.dir(&first.id).exists());
    fs::remove_file(f.ws.join("a")).unwrap();
    restore_at(&f.data, &f.ws, "chat", &last, false).unwrap();
    assert_eq!(fs::read_to_string(f.ws.join("a")).unwrap(), "old");
}

#[test]
fn failed_snapshot_cleans_staging_and_never_publishes_a_partial_manifest() {
    let f = Fixture::new();
    fs::write(f.ws.join("a"), "one").unwrap();
    fs::write(f.ws.join("b"), "two").unwrap();
    let s = f.snapshot();
    let blob = f
        .dir(&s.id)
        .join("files")
        .join(&s.files.iter().find(|r| r.path == "b").unwrap().hash);
    fs::remove_file(&blob).unwrap();
    fs::create_dir(&blob).unwrap(); // simulate an unreadable/corrupt backing store after staging starts
    assert!(create_at(&f.data, &f.ws, "chat").is_err());
    let chat_dir = f.dir(&s.id).parent().unwrap().to_path_buf();
    assert_eq!(fs::read_dir(&chat_dir).unwrap().count(), 1);
    fs::create_dir(chat_dir.join(".partial-interrupted")).unwrap();
    assert!(f.list().iter().all(|r| !r.id.starts_with('.')));
    assert!(restore_at(&f.data, &f.ws, "chat", ".partial-interrupted", false).is_err());
    assert!(restore_at(&f.data, &f.ws, "chat", &s.id, false).is_err());
}
