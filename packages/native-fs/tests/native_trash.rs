#![cfg(any(target_os = "macos", target_os = "windows"))]

use std::{fs, path::PathBuf};

#[cfg(target_os = "windows")]
use std::path::Path;

use uuid::Uuid;

#[cfg(target_os = "windows")]
use trash::{TrashItem, os_limited};

#[cfg(target_os = "windows")]
struct NativeTrashFixture {
    root: PathBuf,
    target: PathBuf,
    trashed_item: Option<TrashItem>,
}

#[cfg(target_os = "windows")]
impl NativeTrashFixture {
    fn new() -> Self {
        let identity = Uuid::new_v4();
        let root = std::env::temp_dir().join(format!("debrute-native-trash-{identity}"));
        fs::create_dir(&root).expect("isolated native Trash fixture root should be created");
        let target = root.join(format!("recycle fixture {identity}.txt"));
        fs::write(&target, format!("debrute-native-trash-sentinel:{identity}"))
            .expect("isolated native Trash fixture should be written");
        Self {
            root,
            target,
            trashed_item: None,
        }
    }

    fn matching_items(&self) -> Vec<TrashItem> {
        os_limited::list()
            .expect("Windows Recycle Bin should be readable")
            .into_iter()
            .filter(|item| same_windows_path(&item.original_path(), &self.target))
            .collect()
    }
}

#[cfg(target_os = "windows")]
impl Drop for NativeTrashFixture {
    fn drop(&mut self) {
        if !self.target.exists() {
            let restoration = self
                .trashed_item
                .take()
                .into_iter()
                .chain(
                    os_limited::list()
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|item| same_windows_path(&item.original_path(), &self.target)),
                )
                .next()
                .map(|item| os_limited::restore_all([item]));
            if let Some(Err(error)) = restoration {
                eprintln!(
                    "failed to restore isolated native Trash fixture {}: {error}",
                    self.target.display()
                );
            }
        }
        if self.target.exists()
            && let Err(error) = fs::remove_dir_all(&self.root)
        {
            eprintln!(
                "failed to remove isolated native Trash fixture root {}: {error}",
                self.root.display()
            );
        }
    }
}

#[cfg(target_os = "windows")]
fn same_windows_path(left: &Path, right: &Path) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

#[test]
#[cfg(target_os = "windows")]
#[ignore = "moves one UUID fixture through the real Windows Recycle Bin"]
fn windows_native_trash_roundtrip_restores_only_its_uuid_fixture() {
    let mut fixture = NativeTrashFixture::new();
    let sentinel = fs::read(&fixture.target).expect("fixture sentinel should be readable");
    assert!(
        fixture.matching_items().is_empty(),
        "the UUID fixture must not pre-exist in the Recycle Bin"
    );

    debrute_native_fs::trash_path(&fixture.target)
        .expect("native adapter should recycle the exact fixture");
    assert!(!fixture.target.exists());

    let mut matches = fixture.matching_items();
    assert_eq!(
        matches.len(),
        1,
        "exactly one Recycle Bin item must match the UUID fixture path"
    );
    let item = matches
        .pop()
        .expect("one exact Recycle Bin item should exist");
    fixture.trashed_item = Some(item.clone());
    os_limited::restore_all([item]).expect("the exact UUID fixture should restore");
    fixture.trashed_item = None;

    assert_eq!(
        fs::read(&fixture.target).expect("restored fixture should be readable"),
        sentinel,
        "restoration must preserve the exact sentinel bytes"
    );
}

#[test]
#[cfg(target_os = "macos")]
#[ignore = "moves one UUID fixture through the real macOS Trash"]
fn macos_native_trash_roundtrip_restores_only_its_uuid_fixture() {
    struct MacOsTrashFixture {
        root: PathBuf,
        target: PathBuf,
        trashed: PathBuf,
    }

    impl MacOsTrashFixture {
        fn new() -> Self {
            let identity = Uuid::new_v4();
            let home = PathBuf::from(std::env::var_os("HOME").expect("HOME should be available"));
            assert!(
                home.is_absolute(),
                "HOME must be absolute for native Trash acceptance"
            );
            let name = format!("debrute-native-trash-{identity}.txt");
            let root = home.join(format!("debrute-native-trash-fixture-{identity}"));
            fs::create_dir(&root).expect("isolated native Trash fixture root should be created");
            let target = root.join(&name);
            let trashed = home.join(".Trash").join(name);
            assert!(
                !trashed.exists(),
                "the UUID fixture must not pre-exist in the macOS Trash"
            );
            fs::write(&target, format!("debrute-native-trash-sentinel:{identity}"))
                .expect("isolated native Trash fixture should be written");
            Self {
                root,
                target,
                trashed,
            }
        }

        fn restore(&self) {
            if !self.target.exists() && self.trashed.exists() {
                fs::rename(&self.trashed, &self.target)
                    .expect("the exact UUID Trash item should restore");
            }
        }
    }

    impl Drop for MacOsTrashFixture {
        fn drop(&mut self) {
            if !self.target.exists() && self.trashed.exists() {
                if let Err(error) = fs::rename(&self.trashed, &self.target) {
                    eprintln!(
                        "failed to restore isolated native Trash fixture {}: {error}",
                        self.target.display()
                    );
                }
            }
            if self.target.exists()
                && let Err(error) = fs::remove_dir_all(&self.root)
            {
                eprintln!(
                    "failed to remove isolated native Trash fixture root {}: {error}",
                    self.root.display()
                );
            }
        }
    }

    let fixture = MacOsTrashFixture::new();
    let sentinel = fs::read(&fixture.target).expect("fixture sentinel should be readable");
    debrute_native_fs::trash_path(&fixture.target)
        .expect("native adapter should trash the exact fixture");
    assert!(!fixture.target.exists());
    assert!(
        fixture.trashed.is_file(),
        "the exact UUID fixture should exist at its predicted Trash path"
    );

    fixture.restore();
    assert_eq!(
        fs::read(&fixture.target).expect("restored fixture should be readable"),
        sentinel,
        "restoration must preserve the exact sentinel bytes"
    );
}
