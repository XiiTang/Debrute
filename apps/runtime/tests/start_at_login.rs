use std::{fs, path::PathBuf};

use debrute_runtime::{
    control::ActivationIntent,
    login::{MacOsLoginItem, login_activation_intent, windows_run_value},
};
use uuid::Uuid;

#[test]
fn login_activation_can_only_ensure_runtime() {
    assert_eq!(login_activation_intent(), ActivationIntent::EnsureRuntime);
}

#[test]
fn macos_login_item_is_atomic_and_never_restores_a_frontend() {
    let home = temporary_home();
    let runtime = PathBuf::from("/Users/cq/.debrute/bin/debrute-runtime");
    let item = MacOsLoginItem::new(&home, &runtime);
    assert!(!item.is_enabled().expect("missing item should be disabled"));

    item.set_enabled(true).expect("login item should enable");
    assert!(item.is_enabled().expect("written item should be enabled"));
    let plist = fs::read_to_string(item.path()).expect("launch agent should be readable");
    assert!(plist.contains(runtime.to_str().expect("runtime path should be UTF-8")));
    assert!(plist.contains("<key>RunAtLoad</key>"));
    assert!(!plist.contains("open_desktop"));
    assert!(!plist.contains("open_browser"));
    assert!(!plist.contains("project"));

    item.set_enabled(false).expect("login item should disable");
    assert!(!item.path().exists());
    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn windows_run_value_invokes_only_the_stable_runtime_entrypoint() {
    assert_eq!(
        windows_run_value(
            PathBuf::from(r"C:\Users\cq\Debrute Runtime\debrute-runtime.exe").as_path()
        )
        .expect("Windows path should serialize"),
        r#""C:\Users\cq\Debrute Runtime\debrute-runtime.exe""#
    );
}

fn temporary_home() -> PathBuf {
    let path = std::env::temp_dir().join(format!("debrute-runtime-login-{}", Uuid::new_v4()));
    fs::create_dir_all(&path).expect("temporary home should be created");
    path
}
