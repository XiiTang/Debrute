use std::{
    error::Error,
    fmt, fs, io,
    path::{Path, PathBuf},
    process::Command,
};

use uuid::Uuid;

use super::layout::OFFICIAL_SKILL_PREFIX;

const SKILL_PROJECTION_TRANSACTION_PREFIX: &str = ".debrute-projection-";
#[cfg(target_os = "macos")]
const SHELL_WRITE_TRANSACTION_PREFIX: &str = ".debrute-shell-";
#[cfg(target_os = "macos")]
const PATH_BLOCK_START: &str = "# >>> Debrute managed PATH >>>";
#[cfg(target_os = "macos")]
const PATH_BLOCK_END: &str = "# <<< Debrute managed PATH <<<";

/// Publishes and removes Product-owned surfaces outside the version directory.
pub struct ProductProjectionManager;

impl ProductProjectionManager {
    /// Exposes the stable CLI directory to new commands for the current user.
    ///
    /// # Errors
    ///
    /// Returns [`ProductProjectionError`] when the platform command environment
    /// cannot be updated without crossing its exact owned boundary.
    pub(crate) fn configure_command_path(
        layout: &super::InstalledProductLayout,
    ) -> Result<(), ProductProjectionError> {
        #[cfg(target_os = "macos")]
        {
            let shell = Self::current_login_shell()?;
            remove_all_macos_command_paths(layout.user_home())?;
            Self::configure_macos_command_path(&shell, layout.user_home(), layout.bin_directory())
        }
        #[cfg(target_os = "windows")]
        {
            configure_windows_command_path(layout.bin_directory(), true)
        }
    }

    /// Removes only the current user's Debrute command exposure.
    ///
    /// # Errors
    ///
    /// Returns [`ProductProjectionError`] when the exact platform environment
    /// cannot be read or written safely.
    pub(crate) fn remove_command_path(
        layout: &super::InstalledProductLayout,
    ) -> Result<(), ProductProjectionError> {
        #[cfg(target_os = "macos")]
        {
            remove_all_macos_command_paths(layout.user_home())
        }
        #[cfg(target_os = "windows")]
        {
            configure_windows_command_path(layout.bin_directory(), false)
        }
    }

    /// Verifies that a fresh current-user command environment resolves the
    /// managed `debrute` command to this exact Product.
    ///
    /// # Errors
    ///
    /// Returns [`ProductProjectionError`] when the platform environment cannot
    /// be started or resolves another command.
    pub fn verify_command_resolution(
        layout: &super::InstalledProductLayout,
    ) -> Result<(), ProductProjectionError> {
        #[cfg(target_os = "macos")]
        {
            let shell = Self::current_login_shell()?;
            Self::verify_macos_command_resolution(&shell, layout.user_home(), &layout.cli_path())
        }
        #[cfg(target_os = "windows")]
        {
            verify_windows_command_resolution(layout)
        }
    }

    /// Resolves the current macOS account's configured login shell without
    /// depending on the environment inherited by a Finder-launched Product Setup.
    #[cfg(target_os = "macos")]
    pub(crate) fn current_login_shell() -> Result<PathBuf, ProductProjectionError> {
        use nix::unistd::{Uid, User};

        User::from_uid(Uid::current())
            .map_err(|error| io::Error::from_raw_os_error(error as i32))?
            .map(|user| user.shell)
            .ok_or(ProductProjectionError::LoginUserMissing)
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn verify_macos_command_resolution(
        shell: &Path,
        user_home: &Path,
        expected_command: &Path,
    ) -> Result<(), ProductProjectionError> {
        let shell_name = shell.file_name().and_then(|name| name.to_str());
        let flags = match shell_name {
            Some("zsh" | "bash") => "-lic",
            Some("fish") => "-lc",
            _ => return Err(ProductProjectionError::UnsupportedShell(shell.to_owned())),
        };
        let output = Command::new(shell)
            .arg(flags)
            .arg("command -v debrute")
            .env("HOME", user_home)
            .output()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if output.status.success()
            && stdout
                .lines()
                .any(|line| Path::new(line.trim()) == expected_command)
        {
            return Ok(());
        }
        Err(ProductProjectionError::CommandResolutionMismatch {
            expected: expected_command.to_owned(),
            actual: stdout.trim().to_owned(),
        })
    }

    /// Adds the stable CLI directory to every startup file used by the current
    /// macOS login shell.
    ///
    /// # Errors
    ///
    /// Returns [`ProductProjectionError`] without writing any file when a bounded
    /// Debrute block is malformed or the shell/path cannot be represented safely.
    #[cfg(target_os = "macos")]
    pub(crate) fn configure_macos_command_path(
        shell: &Path,
        user_home: &Path,
        bin_directory: &Path,
    ) -> Result<(), ProductProjectionError> {
        let bin = bin_directory
            .to_str()
            .ok_or_else(|| ProductProjectionError::InvalidCommandPath(bin_directory.to_owned()))?;
        let assignment = match shell.file_name().and_then(|name| name.to_str()) {
            Some("zsh" | "bash") => {
                let escaped = bin.replace('\'', "'\\''");
                format!(
                    "case :\"$PATH\": in\n  *:'{escaped}':*) ;;\n  *) export PATH='{escaped}':\"$PATH\" ;;\nesac"
                )
            }
            Some("fish") => {
                let escaped = bin.replace('\\', "\\\\").replace('\'', "\\'");
                format!("set -gx PATH '{escaped}' $PATH")
            }
            _ => return Err(ProductProjectionError::UnsupportedShell(shell.to_owned())),
        };
        let block = format!("{PATH_BLOCK_START}\n{assignment}\n{PATH_BLOCK_END}\n");
        rewrite_macos_shell_files(shell, user_home, Some(&block))
    }

    /// Removes only complete Debrute-delimited PATH blocks.
    ///
    /// # Errors
    ///
    /// Returns [`ProductProjectionError`] without writing any file when an existing
    /// Debrute marker is incomplete or duplicated.
    #[cfg(all(target_os = "macos", test))]
    pub(crate) fn remove_macos_command_path(
        shell: &Path,
        user_home: &Path,
    ) -> Result<(), ProductProjectionError> {
        rewrite_macos_shell_files(shell, user_home, None)
    }

    /// Atomically replaces the complete direct-child `debrute-*` Skill namespace.
    ///
    /// # Errors
    ///
    /// Returns [`ProductProjectionError`] before mutation when the source is not a
    /// closed official Skill inventory, or after restoring the prior inventory when
    /// publication fails.
    pub(crate) fn publish_official_skills(
        source: &Path,
        destination: &Path,
    ) -> Result<(), ProductProjectionError> {
        let inventory = validate_skill_inventory(source)?;
        fs::create_dir_all(destination)?;
        remove_canonical_uuid_transactions(destination, SKILL_PROJECTION_TRANSACTION_PREFIX)?;
        let transaction = destination.join(format!(
            "{SKILL_PROJECTION_TRANSACTION_PREFIX}{}",
            Uuid::new_v4()
        ));
        let staged = transaction.join("staged");
        let retired = transaction.join("retired");
        fs::create_dir_all(&staged)?;
        fs::create_dir_all(&retired)?;
        for name in &inventory {
            copy_plain_tree(&source.join(name), &staged.join(name))?;
        }

        let existing = reserved_entries(destination)?;
        let mut retired_names = Vec::new();
        for name in existing {
            if let Err(error) = fs::rename(destination.join(&name), retired.join(&name)) {
                restore_names(destination, &retired, &retired_names)?;
                let _ = fs::remove_dir_all(&transaction);
                return Err(error.into());
            }
            retired_names.push(name);
        }

        let mut published_names = Vec::new();
        for name in &inventory {
            if let Err(error) = fs::rename(staged.join(name), destination.join(name)) {
                for published in &published_names {
                    remove_entry(&destination.join(published))?;
                }
                restore_names(destination, &retired, &retired_names)?;
                let _ = fs::remove_dir_all(&transaction);
                return Err(error.into());
            }
            published_names.push(name.clone());
        }
        fs::remove_dir_all(transaction)?;
        Ok(())
    }

    /// Removes every direct child in the reserved official Skill namespace.
    ///
    /// # Errors
    ///
    /// Returns [`ProductProjectionError`] when the directory cannot be enumerated or
    /// a reserved entry cannot be removed.
    pub(crate) fn remove_official_skills(destination: &Path) -> Result<(), ProductProjectionError> {
        if !destination.exists() {
            return Ok(());
        }
        for name in reserved_entries(destination)? {
            remove_entry(&destination.join(name))?;
        }
        remove_canonical_uuid_transactions(destination, SKILL_PROJECTION_TRANSACTION_PREFIX)?;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn configure_windows_command_path(
    bin_directory: &Path,
    enabled: bool,
) -> Result<(), ProductProjectionError> {
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE},
    };

    let bin = bin_directory
        .to_str()
        .ok_or_else(|| ProductProjectionError::InvalidCommandPath(bin_directory.to_owned()))?;
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let environment = if enabled {
        current_user.create_subkey("Environment")?.0
    } else {
        match current_user.open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE) {
            Ok(environment) => environment,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        }
    };
    let current = match environment.get_raw_value("Path") {
        Ok(value) => Some(value),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let updated = rewrite_windows_path_registry_value(current, bin, enabled)?;
    match updated {
        Some(updated) => environment.set_raw_value("Path", &updated)?,
        None => match environment.delete_value("Path") {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        },
    }
    debrute_windows_product_fs::broadcast_environment_change();
    Ok(())
}

#[cfg(target_os = "windows")]
fn rewrite_windows_path_registry_value(
    current: Option<winreg::RegValue>,
    bin: &str,
    enabled: bool,
) -> Result<Option<winreg::RegValue>, ProductProjectionError> {
    use winreg::{
        enums::{REG_EXPAND_SZ, REG_SZ},
        types::{FromRegValue as _, ToRegValue as _},
    };

    let (current, value_type, value_existed) = match current {
        Some(value) if matches!(value.vtype, REG_SZ | REG_EXPAND_SZ) => {
            let value_type = value.vtype.clone();
            (String::from_reg_value(&value)?, value_type, true)
        }
        Some(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Current-user Path must be REG_SZ or REG_EXPAND_SZ",
            )
            .into());
        }
        None => (String::new(), REG_EXPAND_SZ, false),
    };
    let expected = normalize_windows_path_entry(bin);
    let mut entries = if value_existed {
        current
            .split(';')
            .filter(|entry| normalize_windows_path_entry(entry) != expected)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    if enabled {
        entries.push(bin.to_owned());
    }
    if entries.is_empty() {
        return Ok(None);
    }
    let mut updated = entries.join(";").to_reg_value();
    updated.vtype = value_type;
    Ok(Some(updated))
}

#[cfg(target_os = "windows")]
fn normalize_windows_path_entry(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

#[cfg(target_os = "windows")]
fn verify_windows_command_resolution(
    layout: &super::InstalledProductLayout,
) -> Result<(), ProductProjectionError> {
    use std::ffi::OsStr;
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let environment = current_user.open_subkey("Environment")?;
    let user_path = environment.get_value::<String, _>("Path")?;
    let expanded_user_path =
        debrute_windows_product_fs::expand_environment_strings(OsStr::new(&user_path))?;
    let mut fresh_path = expanded_user_path;
    fresh_path.push(";");
    fresh_path.push(std::env::var_os("PATH").unwrap_or_default());
    let output = Command::new("where.exe")
        .arg("debrute")
        .env("PATH", fresh_path)
        .output()?;
    let cli_path = layout.cli_path();
    let expected = normalize_windows_path_entry(&cli_path.to_string_lossy());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let actual = stdout.lines().find(|line| !line.trim().is_empty());
    if output.status.success()
        && actual.is_some_and(|line| normalize_windows_path_entry(line) == expected)
    {
        return Ok(());
    }
    Err(ProductProjectionError::CommandResolutionMismatch {
        expected: cli_path,
        actual: stdout.trim().to_owned(),
    })
}

#[cfg(target_os = "macos")]
fn rewrite_macos_shell_files(
    shell: &Path,
    user_home: &Path,
    replacement: Option<&str>,
) -> Result<(), ProductProjectionError> {
    let paths = applicable_macos_shell_files(shell, user_home)?;
    rewrite_macos_shell_file_set(paths, replacement)
}

#[cfg(target_os = "macos")]
fn rewrite_macos_shell_file_set(
    paths: impl IntoIterator<Item = PathBuf>,
    replacement: Option<&str>,
) -> Result<(), ProductProjectionError> {
    let mut writes = Vec::new();
    for path in paths {
        remove_shell_write_transactions_for_destination(&path)?;
        let original = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.into()),
        };
        let rewritten = replace_command_path_block(&original, replacement)?;
        if rewritten != original && (replacement.is_some() || path.exists()) {
            writes.push((path, rewritten));
        }
    }
    for (path, contents) in writes {
        write_text_file_preserving_metadata(&path, contents.as_bytes())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn remove_all_macos_command_paths(user_home: &Path) -> Result<(), ProductProjectionError> {
    rewrite_macos_shell_file_set(
        [
            user_home.join(".zprofile"),
            user_home.join(".zshrc"),
            user_home.join(".bash_profile"),
            user_home.join(".bash_login"),
            user_home.join(".profile"),
            user_home.join(".bashrc"),
            user_home.join(".config/fish/config.fish"),
        ],
        None,
    )
}

#[cfg(target_os = "macos")]
fn applicable_macos_shell_files(
    shell: &Path,
    user_home: &Path,
) -> Result<Vec<PathBuf>, ProductProjectionError> {
    match shell.file_name().and_then(|name| name.to_str()) {
        Some("zsh") => Ok(vec![user_home.join(".zprofile"), user_home.join(".zshrc")]),
        Some("bash") => {
            let login = if user_home.join(".bash_profile").exists() {
                user_home.join(".bash_profile")
            } else if user_home.join(".bash_login").exists() {
                user_home.join(".bash_login")
            } else {
                user_home.join(".profile")
            };
            Ok(vec![login, user_home.join(".bashrc")])
        }
        Some("fish") => Ok(vec![user_home.join(".config/fish/config.fish")]),
        _ => Err(ProductProjectionError::UnsupportedShell(shell.to_owned())),
    }
}

#[cfg(target_os = "macos")]
fn replace_command_path_block(
    original: &str,
    replacement: Option<&str>,
) -> Result<String, ProductProjectionError> {
    let starts = original.match_indices(PATH_BLOCK_START).collect::<Vec<_>>();
    let ends = original.match_indices(PATH_BLOCK_END).collect::<Vec<_>>();
    let base = match (starts.as_slice(), ends.as_slice()) {
        ([], []) => original.to_owned(),
        ([(start, _)], [(end, _)]) if start < end => {
            let before_block = if *start > 0 && original.as_bytes()[*start - 1] == b'\n' {
                *start - 1
            } else {
                *start
            };
            let after_marker = end + PATH_BLOCK_END.len();
            let after_block = if original.as_bytes().get(after_marker) == Some(&b'\r')
                && original.as_bytes().get(after_marker + 1) == Some(&b'\n')
            {
                after_marker + 2
            } else if original.as_bytes().get(after_marker) == Some(&b'\n') {
                after_marker + 1
            } else {
                after_marker
            };
            format!("{}{}", &original[..before_block], &original[after_block..])
        }
        _ => return Err(ProductProjectionError::MalformedCommandPathBlock),
    };
    let Some(replacement) = replacement else {
        return Ok(base);
    };
    let mut result = base;
    result.push('\n');
    result.push_str(replacement);
    Ok(result)
}

#[cfg(target_os = "macos")]
fn write_text_file_preserving_metadata(
    destination: &Path,
    bytes: &[u8],
) -> Result<(), ProductProjectionError> {
    let resolved = resolve_shell_file_destination(destination)?;
    let previous_permissions = fs::metadata(&resolved)
        .ok()
        .map(|metadata| metadata.permissions());
    let parent = resolved
        .parent()
        .ok_or_else(|| ProductProjectionError::InvalidCommandPath(resolved.clone()))?;
    fs::create_dir_all(parent)?;
    remove_canonical_uuid_transactions(parent, SHELL_WRITE_TRANSACTION_PREFIX)?;
    let temporary = parent.join(format!(
        "{SHELL_WRITE_TRANSACTION_PREFIX}{}",
        Uuid::new_v4()
    ));
    let result = (|| {
        fs::write(&temporary, bytes)?;
        if let Some(permissions) = previous_permissions {
            fs::set_permissions(&temporary, permissions)?;
        }
        debrute_native_fs::replace_file_atomic(&temporary, &resolved)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = remove_entry(&temporary);
    }
    result
}

#[cfg(target_os = "macos")]
fn resolve_shell_file_destination(destination: &Path) -> Result<PathBuf, ProductProjectionError> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_symlink() => Ok(fs::canonicalize(destination)?),
        Ok(_) => Ok(destination.to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(destination.to_owned()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "macos")]
fn remove_shell_write_transactions_for_destination(
    destination: &Path,
) -> Result<(), ProductProjectionError> {
    let resolved = resolve_shell_file_destination(destination)?;
    let parent = resolved
        .parent()
        .ok_or_else(|| ProductProjectionError::InvalidCommandPath(resolved.clone()))?;
    remove_canonical_uuid_transactions(parent, SHELL_WRITE_TRANSACTION_PREFIX)
}

fn remove_canonical_uuid_transactions(
    parent: &Path,
    prefix: &str,
) -> Result<(), ProductProjectionError> {
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(transaction_id_text) = name.to_str().and_then(|name| name.strip_prefix(prefix))
        else {
            continue;
        };
        let Ok(transaction_id) = Uuid::parse_str(transaction_id_text) else {
            continue;
        };
        if transaction_id.to_string() == transaction_id_text {
            remove_entry(&entry.path())?;
        }
    }
    Ok(())
}

fn validate_skill_inventory(source: &Path) -> Result<Vec<PathBuf>, ProductProjectionError> {
    require_plain_directory(source)?;
    let mut inventory = Vec::new();
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = PathBuf::from(entry.file_name());
        let Some(name_text) = name.to_str() else {
            return Err(ProductProjectionError::InvalidSkillsPayload(entry.path()));
        };
        if !name_text.starts_with(OFFICIAL_SKILL_PREFIX) {
            return Err(ProductProjectionError::InvalidSkillsPayload(entry.path()));
        }
        require_plain_directory(&entry.path())?;
        let skill_file = entry.path().join("SKILL.md");
        let metadata = fs::symlink_metadata(&skill_file)
            .map_err(|_| ProductProjectionError::InvalidSkillsPayload(skill_file.clone()))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(ProductProjectionError::InvalidSkillsPayload(skill_file));
        }
        inventory.push(name);
    }
    inventory.sort();
    if inventory.is_empty() {
        return Err(ProductProjectionError::InvalidSkillsPayload(
            source.to_owned(),
        ));
    }
    Ok(inventory)
}

fn reserved_entries(destination: &Path) -> Result<Vec<PathBuf>, ProductProjectionError> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(destination)? {
        let entry = entry?;
        let name = PathBuf::from(entry.file_name());
        if name
            .to_str()
            .is_some_and(|name| name.starts_with(OFFICIAL_SKILL_PREFIX))
        {
            entries.push(name);
        }
    }
    entries.sort();
    Ok(entries)
}

fn restore_names(
    destination: &Path,
    retired: &Path,
    names: &[PathBuf],
) -> Result<(), ProductProjectionError> {
    for name in names.iter().rev() {
        fs::rename(retired.join(name), destination.join(name))?;
    }
    Ok(())
}

fn remove_entry(path: &Path) -> Result<(), ProductProjectionError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn copy_plain_tree(source: &Path, destination: &Path) -> Result<(), ProductProjectionError> {
    require_plain_directory(source)?;
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() && !file_type.is_symlink() {
            copy_plain_tree(&entry.path(), &target)?;
        } else if file_type.is_file() && !file_type.is_symlink() {
            fs::copy(entry.path(), target)?;
        } else {
            return Err(ProductProjectionError::InvalidSkillsPayload(entry.path()));
        }
    }
    Ok(())
}

fn require_plain_directory(path: &Path) -> Result<(), ProductProjectionError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| ProductProjectionError::InvalidSkillsPayload(path.to_owned()))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(ProductProjectionError::InvalidSkillsPayload(
            path.to_owned(),
        ));
    }
    Ok(())
}

#[derive(Debug)]
pub enum ProductProjectionError {
    Io(io::Error),
    InvalidSkillsPayload(PathBuf),
    InvalidCommandPath(PathBuf),
    UnsupportedShell(PathBuf),
    LoginUserMissing,
    MalformedCommandPathBlock,
    CommandResolutionMismatch { expected: PathBuf, actual: String },
}

impl fmt::Display for ProductProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Product projection failed: {self:?}")
    }
}

impl Error for ProductProjectionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::InvalidSkillsPayload(_)
            | Self::InvalidCommandPath(_)
            | Self::UnsupportedShell(_)
            | Self::LoginUserMissing
            | Self::MalformedCommandPathBlock
            | Self::CommandResolutionMismatch { .. } => None,
        }
    }
}

impl From<io::Error> for ProductProjectionError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use winreg::{
        RegValue,
        enums::REG_EXPAND_SZ,
        types::{FromRegValue as _, ToRegValue as _},
    };

    use super::rewrite_windows_path_registry_value;

    #[test]
    fn path_rewrite_preserves_expandable_type_and_unrelated_entries() {
        let mut current = "%USERPROFILE%\\tools;C:\\other".to_reg_value();
        current.vtype = REG_EXPAND_SZ;

        let updated = rewrite_windows_path_registry_value(
            Some(current),
            r"C:\Users\person\.debrute\bin",
            true,
        )
        .unwrap()
        .unwrap();

        assert_eq!(updated.vtype, REG_EXPAND_SZ);
        assert_eq!(
            String::from_reg_value(&RegValue {
                bytes: updated.bytes,
                vtype: updated.vtype,
            })
            .unwrap(),
            r"%USERPROFILE%\tools;C:\other;C:\Users\person\.debrute\bin"
        );
    }

    #[test]
    fn removing_the_only_managed_entry_deletes_the_product_created_value() {
        let current = Some(r"C:\Users\person\.debrute\bin".to_reg_value());
        assert!(
            rewrite_windows_path_registry_value(current, r"C:\Users\person\.debrute\bin", false,)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn path_rewrite_round_trips_empty_and_expandable_unrelated_entries() {
        let bin = r"C:\Users\person\.debrute\bin";
        let original = r";%USERPROFILE%\tools;; ;C:\other;";
        let mut current = original.to_reg_value();
        current.vtype = REG_EXPAND_SZ;

        let installed = rewrite_windows_path_registry_value(Some(current), bin, true)
            .unwrap()
            .unwrap();
        assert_eq!(
            String::from_reg_value(&installed).unwrap(),
            format!("{original};{bin}")
        );

        let removed = rewrite_windows_path_registry_value(Some(installed), bin, false)
            .unwrap()
            .unwrap();
        assert_eq!(removed.vtype, REG_EXPAND_SZ);
        assert_eq!(String::from_reg_value(&removed).unwrap(), original);
    }
}
