use std::path::PathBuf;

#[cfg(target_os = "macos")]
use debrute_runtime::login::MacOsLoginItem;
#[cfg(target_os = "windows")]
use debrute_runtime::login::WindowsLoginItem;
use debrute_runtime::login::{require_stable_runtime_entrypoint, windows_run_value};
#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use uuid::Uuid;

#[test]
fn stable_runtime_entrypoint_must_be_absolute() {
    let absolute = std::env::current_exe().expect("current test entrypoint should resolve");
    assert_eq!(
        require_stable_runtime_entrypoint(absolute.clone())
            .expect("absolute stable entrypoint should be accepted"),
        absolute
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

#[test]
#[cfg(target_os = "windows")]
fn windows_login_item_roundtrips_one_isolated_current_user_run_value() {
    use std::io;

    use uuid::Uuid;
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE},
    };

    struct RegistryFixture {
        subkey: String,
    }

    impl Drop for RegistryFixture {
        fn drop(&mut self) {
            let current_user = RegKey::predef(HKEY_CURRENT_USER);
            match current_user.delete_subkey_all(&self.subkey) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => eprintln!(
                    "failed to remove isolated Start at Login test key {}: {error}",
                    self.subkey
                ),
            }
        }
    }

    let identity = Uuid::new_v4();
    let subkey = format!(r"Software\Debrute Start at Login Test {identity}");
    let value_name = format!("Debrute Runtime Test {identity}");
    let _fixture = RegistryFixture {
        subkey: subkey.clone(),
    };
    let runtime = std::env::current_exe().expect("test executable path should resolve");
    let expected_value = windows_run_value(&runtime).expect("test executable should serialize");
    let item = WindowsLoginItem::new_for_test(&runtime, subkey.clone(), value_name.clone());
    let current_user = RegKey::predef(HKEY_CURRENT_USER);

    assert!(!item.is_enabled().expect("absent value should be disabled"));
    item.set_enabled(false)
        .expect("disabling an absent value should be idempotent");
    assert!(current_user.open_subkey(&subkey).is_err());

    item.set_enabled(true)
        .expect("isolated value should enable");
    assert!(item.is_enabled().expect("exact value should be enabled"));
    let run = current_user
        .open_subkey_with_flags(&subkey, KEY_READ | KEY_SET_VALUE)
        .expect("isolated Run key should exist");
    assert_eq!(
        run.get_value::<String, _>(&value_name)
            .expect("isolated Run value should be readable"),
        expected_value
    );

    run.set_value(&value_name, &"tampered command")
        .expect("isolated Run value should be mutable");
    assert!(
        !item
            .is_enabled()
            .expect("tampered value should be disabled")
    );

    item.set_enabled(false)
        .expect("tampered isolated value should disable");
    assert!(!item.is_enabled().expect("removed value should be disabled"));
    item.set_enabled(false)
        .expect("repeated disable should remain idempotent");
    assert!(run.get_value::<String, _>(&value_name).is_err());
}

#[cfg(target_os = "macos")]
fn temporary_home() -> PathBuf {
    let path = std::env::temp_dir().join(format!("debrute-runtime-login-{}", Uuid::new_v4()));
    fs::create_dir_all(&path).expect("temporary home should be created");
    path
}
