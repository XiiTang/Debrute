use std::path::PathBuf;

#[cfg(target_os = "macos")]
use debrute_runtime::login::MacOsLoginItem;
use debrute_runtime::login::{require_stable_runtime_entrypoint, windows_run_value};
#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use uuid::Uuid;

#[test]
fn stable_runtime_entrypoint_must_be_absolute() {
    assert_eq!(
        require_stable_runtime_entrypoint(PathBuf::from("/stable/debrute-runtime"))
            .expect("absolute stable entrypoint should be accepted"),
        PathBuf::from("/stable/debrute-runtime")
    );
    assert!(require_stable_runtime_entrypoint(PathBuf::from("debrute-runtime")).is_err());
}

#[test]
#[cfg(target_os = "macos")]
fn macos_login_item_roundtrips_the_exact_stable_runtime() {
    let home = temporary_home();
    let runtime = PathBuf::from("/Users/cq/.debrute/bin/debrute-runtime");
    let item = MacOsLoginItem::new(&home, &runtime);
    assert!(!item.is_enabled().expect("missing item should be disabled"));

    item.set_enabled(true).expect("login item should enable");
    assert!(item.is_enabled().expect("written item should be enabled"));
    let plist = fs::read_to_string(item.path()).expect("launch agent should be readable");
    assert!(plist.contains(runtime.to_str().expect("runtime path should be UTF-8")));
    assert!(plist.contains("<key>RunAtLoad</key>"));
    assert!(plist.contains(&format!(
        "<key>ProgramArguments</key>\n<array><string>{}</string></array>",
        runtime.display()
    )));

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
        r#""C:\Users\cq\Debrute Runtime\debrute-runtime.exe" --stable-runtime-entrypoint "C:\Users\cq\Debrute Runtime\debrute-runtime.exe""#
    );
    assert_eq!(
        windows_run_value(PathBuf::from(r"C:\Users\%name%\debrute-runtime.exe").as_path())
            .expect("legal Windows path characters should remain literal"),
        r#""C:\Users\%name%\debrute-runtime.exe" --stable-runtime-entrypoint "C:\Users\%name%\debrute-runtime.exe""#
    );
}

#[cfg(target_os = "macos")]
fn temporary_home() -> PathBuf {
    let path = std::env::temp_dir().join(format!("debrute-runtime-login-{}", Uuid::new_v4()));
    fs::create_dir_all(&path).expect("temporary home should be created");
    path
}
