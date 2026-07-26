//! Native executable discovery shared by Runtime callers.

use std::{
    env,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};
#[cfg(target_os = "windows")]
use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};

use crate::integrations::Platform;

pub(crate) fn resolve_executable(
    name: &str,
    env_path: &OsStr,
    platform: Platform,
    path_ext: &OsStr,
) -> Option<PathBuf> {
    if name.is_empty() || Path::new(name).file_name().and_then(|value| value.to_str()) != Some(name)
    {
        return None;
    }
    let candidate_names = executable_candidate_names(name, platform, path_ext);
    env::split_paths(env_path)
        .filter(|directory| !directory.as_os_str().is_empty())
        .flat_map(|directory| {
            candidate_names
                .iter()
                .map(move |candidate| directory.join(candidate))
        })
        .find(|candidate| is_executable(candidate, platform))
}

fn executable_candidate_names(name: &str, platform: Platform, path_ext: &OsStr) -> Vec<OsString> {
    if platform != Platform::Windows {
        return vec![OsString::from(name)];
    }
    let extensions = split_path_extensions(path_ext);
    if extensions.iter().any(|extension| {
        extension.to_str().is_some_and(|extension| {
            name.to_ascii_lowercase()
                .ends_with(&extension.to_ascii_lowercase())
        })
    }) {
        return vec![OsString::from(name)];
    }
    extensions
        .into_iter()
        .map(|extension| {
            let mut candidate = OsString::from(name);
            candidate.push(extension);
            candidate
        })
        .collect()
}

#[cfg(unix)]
fn split_path_extensions(value: &OsStr) -> Vec<OsString> {
    value
        .as_bytes()
        .split(|byte| *byte == b';')
        .filter(|extension| !extension.is_empty())
        .map(|extension| OsString::from_vec(extension.to_vec()))
        .collect()
}

#[cfg(target_os = "windows")]
fn split_path_extensions(value: &OsStr) -> Vec<OsString> {
    value
        .encode_wide()
        .collect::<Vec<_>>()
        .split(|character| *character == u16::from(b';'))
        .filter(|extension| !extension.is_empty())
        .map(OsString::from_wide)
        .collect()
}

fn is_executable(path: &Path, platform: Platform) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    if platform == Platform::Windows {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    false
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    #[cfg(target_os = "windows")]
    use std::fs;
    #[cfg(target_os = "macos")]
    use std::{
        ffi::OsString,
        fs,
        os::unix::{ffi::OsStringExt as _, fs::PermissionsExt as _},
    };

    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn resolves_windows_path_extensions() {
        let root = std::env::temp_dir().join(format!(
            "debrute-executable-resolution-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let executable = root.join("ffprobe.exe");
        fs::write(&executable, "fixture").expect("fixture executable should exist");

        let resolved = resolve_executable(
            "ffprobe",
            root.as_os_str(),
            crate::integrations::Platform::Windows,
            OsStr::new(".COM;.EXE"),
        )
        .expect("Windows PATHEXT should resolve ffprobe.exe");
        assert_eq!(
            fs::canonicalize(resolved).expect("resolved executable should canonicalize"),
            fs::canonicalize(&executable).expect("fixture executable should canonicalize")
        );

        fs::remove_dir_all(root).expect("fixture directory should clean up");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolves_explicit_windows_path_extension() {
        let root = std::env::temp_dir().join(format!(
            "debrute-executable-resolution-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let executable = root.join("ffprobe.exe");
        fs::write(&executable, "fixture").expect("fixture executable should exist");

        let resolved = resolve_executable(
            "ffprobe.exe",
            root.as_os_str(),
            crate::integrations::Platform::Windows,
            OsStr::new(".COM;.EXE"),
        )
        .expect("an explicit configured extension should resolve directly");
        assert_eq!(
            fs::canonicalize(resolved).expect("resolved executable should canonicalize"),
            fs::canonicalize(&executable).expect("fixture executable should canonicalize")
        );

        fs::remove_dir_all(root).expect("fixture directory should clean up");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_extensionless_windows_candidates_when_path_ext_is_empty() {
        let root = std::env::temp_dir().join(format!(
            "debrute-executable-resolution-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        fs::write(root.join("ffprobe"), "fixture").expect("extensionless fixture should exist");

        assert_eq!(
            resolve_executable(
                "ffprobe",
                root.as_os_str(),
                crate::integrations::Platform::Windows,
                OsStr::new(""),
            ),
            None
        );

        fs::remove_dir_all(root).expect("fixture directory should clean up");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn requires_executable_permissions_outside_windows() {
        let root = std::env::temp_dir().join(format!(
            "debrute-executable-resolution-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let executable = root.join("ffprobe");
        fs::write(&executable, "fixture").expect("fixture executable should exist");
        let path = std::env::join_paths([&root]).expect("fixture PATH should join");

        assert_eq!(
            resolve_executable("ffprobe", &path, Platform::MacOs, OsStr::new("")),
            None
        );
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .expect("fixture executable should become executable");
        assert_eq!(
            resolve_executable("ffprobe", &path, Platform::MacOs, OsStr::new("")),
            Some(executable)
        );

        fs::remove_dir_all(root).expect("fixture directory should clean up");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolves_after_a_non_utf8_path_entry() {
        let root = std::env::temp_dir().join(format!(
            "debrute-executable-resolution-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let executable = root.join("ffprobe");
        fs::write(&executable, "fixture").expect("fixture executable should exist");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .expect("fixture executable should become executable");
        let non_utf8 = PathBuf::from(OsString::from_vec(b"/native-\xff-path".to_vec()));
        let path =
            std::env::join_paths([&non_utf8, &root]).expect("native fixture PATH should join");

        assert_eq!(
            resolve_executable("ffprobe", &path, Platform::MacOs, OsStr::new("")),
            Some(executable)
        );

        fs::remove_dir_all(root).expect("fixture directory should clean up");
    }

    #[test]
    fn missing_path_and_non_file_candidates_do_not_resolve() {
        assert_eq!(
            resolve_executable("ffprobe", OsStr::new(""), Platform::MacOs, OsStr::new("")),
            None
        );
        let root = std::env::temp_dir().join(format!(
            "debrute-executable-resolution-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(root.join("ffprobe")).expect("directory candidate should exist");
        let path = std::env::join_paths([&root]).expect("fixture PATH should join");
        assert_eq!(
            resolve_executable("ffprobe", &path, Platform::MacOs, OsStr::new("")),
            None
        );
        fs::remove_dir_all(root).expect("fixture directory should clean up");
    }
}
