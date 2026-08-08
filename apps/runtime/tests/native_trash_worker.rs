#![cfg(any(target_os = "macos", target_os = "windows"))]

use std::{fs, process::Command};

use uuid::Uuid;

#[test]
fn native_trash_worker_rejects_a_changed_identity_before_starting_runtime() {
    let root = std::env::temp_dir().join(format!("debrute-trash-process-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).expect("trash worker fixture directory should exist");
    let root = root
        .canonicalize()
        .expect("trash worker fixture root should be canonical");
    let path = root.join("空 格 'worker'.txt");
    fs::write(&path, "fixture").expect("trash worker fixture should be written");

    let output = Command::new(env!("CARGO_BIN_EXE_debrute-runtime"))
        .args([
            "__native-trash",
            "--project-root",
            root.to_str().expect("fixture root should be UTF-8"),
            "--project-relative-path",
            "空 格 'worker'.txt",
            "--expected-volume",
            "0",
            "--expected-file",
            "0",
            "--expected-kind",
            "file",
        ])
        .output()
        .expect("native trash worker should start");

    let failed = !output.status.success();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let preserved = path.exists();
    fs::remove_dir_all(root).expect("trash worker fixture should be removed");

    assert!(failed);
    assert!(
        stderr.contains("Native trash path changed before execution"),
        "worker should report its closed identity failure: {stderr:?}"
    );
    assert!(preserved, "rejected worker must leave the path unchanged");
}

#[test]
#[ignore = "moves temporary fixtures through the real operating-system trash"]
fn native_trash_worker_process_moves_unicode_file_and_directory_to_trash() {
    let root = std::env::temp_dir().join(format!("debrute-trash-process-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).expect("trash worker fixture directory should exist");
    let root = root
        .canonicalize()
        .expect("trash worker fixture root should be canonical");
    let file = root.join("空 格 'worker'.txt");
    fs::write(&file, "fixture").expect("trash worker file fixture should be written");
    let directory = root.join("空 格 worker directory");
    fs::create_dir(&directory).expect("trash worker directory fixture should exist");
    fs::write(directory.join("child.txt"), "fixture")
        .expect("trash worker child fixture should be written");

    for (path, kind) in [(&file, "file"), (&directory, "directory")] {
        let identity = debrute_native_fs::path_identity(path)
            .expect("trash worker fixture identity should be readable");
        let output = Command::new(env!("CARGO_BIN_EXE_debrute-runtime"))
            .args([
                "__native-trash",
                "--project-root",
                root.to_str().expect("fixture root should be UTF-8"),
                "--project-relative-path",
                path.file_name()
                    .and_then(|name| name.to_str())
                    .expect("fixture relative path should be UTF-8"),
                "--expected-volume",
                &identity.volume.to_string(),
                "--expected-file",
                &identity.file.to_string(),
                "--expected-kind",
                kind,
            ])
            .output()
            .expect("native trash worker should start");
        assert!(
            output.status.success(),
            "worker should move the fixture to trash: {:?}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    assert!(!file.exists());
    assert!(!directory.exists());
    fs::remove_dir(root).expect("empty trash worker fixture root should be removed");
}
