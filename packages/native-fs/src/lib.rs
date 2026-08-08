//! Narrow native filesystem primitives with no policy or transaction state.

use std::{fs::File, io, path::Path};

#[derive(Debug)]
pub enum ReplaceFileWithBackupError {
    Operation(io::Error),
    DestinationRestore {
        replacement: io::Error,
        restore: io::Error,
    },
}

impl std::fmt::Display for ReplaceFileWithBackupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Operation(error) => error.fmt(formatter),
            Self::DestinationRestore {
                replacement,
                restore,
            } => write!(
                formatter,
                "{replacement}; failed to restore the displaced destination: {restore}"
            ),
        }
    }
}

impl std::error::Error for ReplaceFileWithBackupError {}

impl From<io::Error> for ReplaceFileWithBackupError {
    fn from(error: io::Error) -> Self {
        Self::Operation(error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathIdentity {
    pub volume: u64,
    pub file: u64,
}

/// Returns the stable filesystem identity of an already-open file handle.
///
/// # Errors
/// Returns an operating-system error when the handle cannot be inspected.
#[cfg(target_os = "macos")]
pub fn file_identity(file: &File) -> io::Result<PathIdentity> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = file.metadata()?;
    Ok(PathIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

/// Returns the stable filesystem identity of an already-open file handle.
///
/// # Errors
/// Returns an operating-system error when the handle cannot be inspected.
#[cfg(target_os = "windows")]
pub fn file_identity(file: &File) -> io::Result<PathIdentity> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle},
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a live handle and `information` is the exact writable
    // output structure required by GetFileInformationByHandle.
    let result = unsafe {
        GetFileInformationByHandle(
            file.as_raw_handle().cast::<core::ffi::c_void>() as HANDLE,
            &raw mut information,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(PathIdentity {
        volume: u64::from(information.dwVolumeSerialNumber),
        file: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

/// Returns the stable filesystem identity of an existing path without following policy.
///
/// # Errors
/// Returns an operating-system error when the path cannot be inspected.
#[cfg(target_os = "macos")]
pub fn path_identity(path: &Path) -> io::Result<PathIdentity> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = std::fs::symlink_metadata(path)?;
    Ok(PathIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

/// Returns the stable filesystem identity of an existing path without following policy.
///
/// # Errors
/// Returns an operating-system error when the path cannot be inspected.
#[cfg(target_os = "windows")]
pub fn path_identity(path: &Path) -> io::Result<PathIdentity> {
    use std::{
        fs::OpenOptions,
        os::windows::{fs::OpenOptionsExt as _, io::AsRawHandle as _},
    };

    use windows_sys::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_READ_ATTRIBUTES, GetFileInformationByHandle,
        },
    };

    let handle = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(7)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `handle` owns a live handle and `information` is the exact writable
    // output structure required by GetFileInformationByHandle.
    let result = unsafe {
        GetFileInformationByHandle(
            handle.as_raw_handle().cast::<core::ffi::c_void>() as HANDLE,
            &raw mut information,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(PathIdentity {
        volume: u64::from(information.dwVolumeSerialNumber),
        file: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

/// Atomically renames `source` to `destination` only when the destination is absent.
///
/// # Errors
/// Returns `AlreadyExists` for a destination collision and preserves both paths.
#[cfg(target_os = "macos")]
pub fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt as _};

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "source path contains NUL"))?;
    let destination = CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination path contains NUL")
    })?;
    // SAFETY: both C strings are live and NUL-terminated for the call. `RENAME_EXCL`
    // asks the kernel to perform the destination absence check in the rename operation.
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Atomically replaces `destination` with `source` and consumes `source`.
///
/// # Errors
/// Returns an operating-system error when the same-volume replacement cannot
/// be completed. A returned error leaves `source` available to the caller.
#[cfg(not(target_os = "windows"))]
pub fn replace_file_atomic(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::rename(source, destination)
}

/// Atomically replaces `destination` with `source` while preserving the
/// complete replaced file at the absent `backup` path.
///
/// # Errors
/// Returns an operating-system error when the backup cannot be created or the
/// same-volume replacement cannot complete.
#[cfg(target_os = "macos")]
pub fn replace_file_atomic_with_backup(
    source: &Path,
    destination: &Path,
    backup: &Path,
) -> Result<(), ReplaceFileWithBackupError> {
    use std::os::fd::AsRawFd as _;

    let original = File::open(destination)?;
    let backup_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(backup)?;
    let copied = unsafe {
        // SAFETY: both descriptors are live regular files owned by these File
        // values. fcopyfile copies data, stat, ACL, and extended attributes to
        // the exclusively-created backup.
        libc::fcopyfile(
            original.as_raw_fd(),
            backup_file.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_DATA | libc::COPYFILE_METADATA,
        )
    };
    if copied != 0 {
        return Err(error_after_owned_backup_cleanup(io::Error::last_os_error(), backup).into());
    }
    if let Err(error) = backup_file.sync_all() {
        return Err(error_after_owned_backup_cleanup(error, backup).into());
    }
    if let Err(error) = std::fs::rename(source, destination) {
        return Err(error_after_owned_backup_cleanup(error, backup).into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn error_after_owned_backup_cleanup(error: io::Error, backup: &Path) -> io::Error {
    match std::fs::remove_file(backup) {
        Ok(()) => error,
        Err(cleanup_error) => io::Error::other(format!(
            "{error}; backup cleanup failed for {}: {cleanup_error}",
            backup.display()
        )),
    }
}

/// Projects a native filesystem identity path into syntax accepted by ordinary
/// external Windows processes. Runtime identity and containment must continue
/// using the original canonical path.
#[must_use]
#[cfg(target_os = "windows")]
pub fn external_process_path(path: &Path) -> std::path::PathBuf {
    let simplified = dunce::simplified(path);
    if simplified != path && safe_projected_legacy_path(simplified) {
        return simplified.to_path_buf();
    }
    simplified_verbatim_unc(path).unwrap_or_else(|| path.to_path_buf())
}

#[cfg(target_os = "windows")]
fn safe_projected_legacy_path(path: &Path) -> bool {
    use std::path::Component;

    path.components().all(|component| match component {
        Component::Prefix(_) | Component::RootDir => true,
        Component::Normal(component) => component.to_str().is_some_and(safe_legacy_component),
        Component::CurDir | Component::ParentDir => false,
    })
}

#[cfg(target_os = "windows")]
fn simplified_verbatim_unc(path: &Path) -> Option<std::path::PathBuf> {
    const PREFIX: &str = r"\\?\UNC\";

    let path = path.to_str()?;
    let prefix = path.get(..PREFIX.len())?;
    let rest = path.get(PREFIX.len()..)?;
    if !prefix.eq_ignore_ascii_case(PREFIX) {
        return None;
    }
    let components = rest.strip_suffix('\\').unwrap_or(rest).split('\\');
    if components.clone().count() < 2 || !components.clone().all(safe_legacy_component) {
        return None;
    }
    let projected = format!(r"\\{rest}");
    (projected.encode_utf16().count() <= 260).then(|| projected.into())
}

#[cfg(target_os = "windows")]
fn safe_legacy_component(component: &str) -> bool {
    if component.is_empty()
        || component.encode_utf16().count() > 255
        || component.ends_with('.')
        || component.ends_with(' ')
        || component
            .chars()
            .any(|character| character <= '\u{1f}' || "<>:\"/\\|?*".contains(character))
    {
        return false;
    }
    let stem = component
        .split_once('.')
        .map_or(component, |(stem, _)| stem)
        .trim_end_matches(['.', ' '])
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|number| {
                (number.len() == 1 && matches!(number.as_bytes()[0], b'1'..=b'9'))
                    || matches!(number, "¹" | "²" | "³")
            });
    !reserved
}

/// Opens one directory through the native Windows Shell.
///
/// # Errors
/// Returns an operating-system error when the path cannot be converted to a
/// Shell item or the Shell refuses to open it.
#[cfg(target_os = "windows")]
pub fn open_directory_in_shell(path: &Path) -> io::Result<()> {
    let _com = ComApartment::initialize()?;
    let item = shell_item(path)?;
    let result = unsafe {
        // SAFETY: `item` owns a live absolute PIDL for the duration of the call.
        windows_sys::Win32::UI::Shell::SHOpenFolderAndSelectItems(
            item.as_ptr(),
            0,
            std::ptr::null(),
            0,
        )
    };
    hresult(result, "open directory in Windows Shell")
}

/// Opens a file's parent directory and selects that file through the native
/// Windows Shell.
///
/// # Errors
/// Returns an operating-system error when either path cannot be converted to a
/// Shell item or the Shell refuses the selection.
#[cfg(target_os = "windows")]
pub fn reveal_file_in_shell(path: &Path) -> io::Result<()> {
    let _com = ComApartment::initialize()?;
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "file path has no parent directory",
        )
    })?;
    let directory = shell_item(parent)?;
    let file = shell_item(path)?;
    let child = unsafe {
        // SAFETY: `file` owns one live absolute PIDL. ILFindLastID returns a
        // borrowed pointer to its final child item, which remains live here.
        windows_sys::Win32::UI::Shell::ILFindLastID(file.as_ptr())
    };
    if child.is_null() {
        return Err(io::Error::other(
            "Windows Shell returned no child item for an accepted file path",
        ));
    }
    let selected = [child.cast_const()];
    let result = unsafe {
        // SAFETY: both owned PIDLs and the one-element pointer array remain live
        // for the duration of the synchronous Shell call.
        windows_sys::Win32::UI::Shell::SHOpenFolderAndSelectItems(
            directory.as_ptr(),
            1,
            selected.as_ptr(),
            0,
        )
    };
    hresult(result, "reveal file in Windows Shell")
}

#[cfg(target_os = "windows")]
struct ComApartment;

#[cfg(target_os = "windows")]
impl ComApartment {
    fn initialize() -> io::Result<Self> {
        let result = unsafe {
            // SAFETY: the null reserved pointer and documented apartment flag
            // form the complete CoInitializeEx contract for the current thread.
            windows_sys::Win32::System::Com::CoInitializeEx(
                std::ptr::null(),
                windows_sys::Win32::System::Com::COINIT_APARTMENTTHREADED.cast_unsigned(),
            )
        };
        hresult(result, "initialize COM for Windows Shell")?;
        Ok(Self)
    }
}

#[cfg(target_os = "windows")]
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe {
            // SAFETY: this guard exists only after one successful CoInitializeEx
            // call on the same thread and balances it exactly once.
            windows_sys::Win32::System::Com::CoUninitialize();
        }
    }
}

#[cfg(target_os = "windows")]
struct ShellItem(*mut windows_sys::Win32::UI::Shell::Common::ITEMIDLIST);

#[cfg(target_os = "windows")]
impl ShellItem {
    fn as_ptr(&self) -> *const windows_sys::Win32::UI::Shell::Common::ITEMIDLIST {
        self.0
    }
}

#[cfg(target_os = "windows")]
impl Drop for ShellItem {
    fn drop(&mut self) {
        unsafe {
            // SAFETY: SHParseDisplayName allocates successful PIDLs with the COM
            // task allocator, and this owner frees each allocation exactly once.
            windows_sys::Win32::System::Com::CoTaskMemFree(self.0.cast());
        }
    }
}

#[cfg(target_os = "windows")]
fn shell_item(path: &Path) -> io::Result<ShellItem> {
    use std::os::windows::ffi::OsStrExt as _;

    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows Shell path must be absolute",
        ));
    }
    let shell_path = external_process_path(path);
    let mut encoded = shell_path.as_os_str().encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows Shell path contains NUL",
        ));
    }
    encoded.push(0);
    let mut item = std::ptr::null_mut();
    let result = unsafe {
        // SAFETY: `encoded` is a live NUL-terminated UTF-16 path and `item` is
        // the exact writable PIDL output slot required by SHParseDisplayName.
        windows_sys::Win32::UI::Shell::SHParseDisplayName(
            encoded.as_ptr(),
            std::ptr::null_mut(),
            &raw mut item,
            0,
            std::ptr::null_mut(),
        )
    };
    hresult(result, "parse Windows Shell path")?;
    if item.is_null() {
        return Err(io::Error::other(
            "Windows Shell returned an empty item for an accepted path",
        ));
    }
    Ok(ShellItem(item))
}

#[cfg(target_os = "windows")]
fn hresult(result: windows_sys::core::HRESULT, operation: &str) -> io::Result<()> {
    if result >= 0 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{operation} failed with HRESULT 0x{:08X}",
            result.cast_unsigned()
        )))
    }
}

/// Native paths already use external-process syntax outside Windows.
#[must_use]
#[cfg(not(target_os = "windows"))]
pub fn external_process_path(path: &Path) -> std::path::PathBuf {
    path.to_path_buf()
}

/// Moves one absolute file or directory to the operating system trash.
///
/// # Errors
/// Returns an invalid-input error for a non-absolute path and otherwise
/// preserves the native trash failure as an I/O diagnostic.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn trash_path(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "trash path must be absolute",
        ));
    }
    trash::delete(path).map_err(|error| io::Error::other(error.to_string()))
}

/// Atomically renames `source` to `destination` only when the destination is absent.
///
/// # Errors
/// Returns `AlreadyExists` for a destination collision and preserves both paths.
#[cfg(target_os = "windows")]
pub fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};

    let source = windows_path(source)?;
    let destination = windows_path(destination)?;
    // SAFETY: both vectors are live, NUL-terminated UTF-16 paths. Omitting
    // MOVEFILE_REPLACE_EXISTING makes destination creation collision-safe.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Atomically replaces `destination` with `source`, consumes `source`, and
/// requests write-through durability.
///
/// # Errors
/// Returns an operating-system error when Windows cannot perform the
/// same-volume replacement. A returned error leaves `source` available to the
/// caller.
#[cfg(target_os = "windows")]
pub fn replace_file_atomic(source: &Path, destination: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source = windows_path(source)?;
    let destination = windows_path(destination)?;
    // SAFETY: both vectors are live, NUL-terminated UTF-16 paths. The flags
    // request one same-volume replacement operation and write-through.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Atomically replaces `destination` with `source` and asks Windows to retain
/// the complete replaced file at the absent `backup` path.
///
/// # Errors
/// Returns an operating-system error when Windows cannot perform the
/// same-volume replacement and backup operation.
#[cfg(target_os = "windows")]
pub fn replace_file_atomic_with_backup(
    source: &Path,
    destination: &Path,
    backup: &Path,
) -> Result<(), ReplaceFileWithBackupError> {
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let source_encoded = windows_path(source)?;
    let destination_encoded = windows_path(destination)?;
    let backup_encoded = windows_path(backup)?;
    let result = unsafe {
        // SAFETY: all vectors are live, NUL-terminated UTF-16 paths.
        // ReplaceFileW performs the replacement and complete backup as one
        // native operation. Zero flags retain metadata merge failures instead
        // of weakening the replacement contract.
        ReplaceFileW(
            destination_encoded.as_ptr(),
            source_encoded.as_ptr(),
            backup_encoded.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    restore_replace_file_partial_failure(error, backup, destination)
}

#[cfg(target_os = "windows")]
fn restore_replace_file_partial_failure(
    error: io::Error,
    backup: &Path,
    destination: &Path,
) -> Result<(), ReplaceFileWithBackupError> {
    use windows_sys::Win32::Foundation::ERROR_UNABLE_TO_MOVE_REPLACEMENT_2;

    if error.raw_os_error() != Some(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2.cast_signed()) {
        return Err(ReplaceFileWithBackupError::Operation(error));
    }
    match rename_no_replace(backup, destination) {
        Ok(()) => Err(ReplaceFileWithBackupError::Operation(error)),
        Err(restore) => Err(ReplaceFileWithBackupError::DestinationRestore {
            replacement: error,
            restore,
        }),
    }
}

#[cfg(target_os = "windows")]
fn windows_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt as _;

    let absolute = std::path::absolute(path)?;
    let encoded = absolute.as_os_str().encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows path contains NUL",
        ));
    }
    let mut verbatim = if encoded.starts_with(&['\\' as u16, '\\' as u16, '?' as u16, '\\' as u16])
        || encoded.starts_with(&['\\' as u16, '\\' as u16, '.' as u16, '\\' as u16])
    {
        encoded
    } else if encoded.starts_with(&['\\' as u16, '\\' as u16]) {
        "\\\\?\\UNC\\"
            .encode_utf16()
            .chain(encoded.into_iter().skip(2))
            .collect()
    } else {
        "\\\\?\\".encode_utf16().chain(encoded).collect()
    };
    verbatim.push(0);
    Ok(verbatim)
}

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn rename_no_replace_preserves_an_existing_destination() {
        let root = std::env::temp_dir().join(format!(
            "debrute-native-fs-collision-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture root should exist");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::write(&source, "source").expect("source should exist");
        fs::write(&destination, "destination").expect("destination should exist");
        let error = rename_no_replace(&source, &destination)
            .expect_err("destination collision must fail atomically");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read_to_string(&source).expect("source should remain"),
            "source"
        );
        assert_eq!(
            fs::read_to_string(&destination).expect("destination should remain"),
            "destination"
        );
        let source_directory = root.join("source-directory");
        let destination_directory = root.join("destination-directory");
        fs::create_dir(&source_directory).expect("source directory should exist");
        fs::create_dir(&destination_directory).expect("destination directory should exist");
        rename_no_replace(&source_directory, &destination_directory)
            .expect_err("directory collision must fail atomically");
        assert!(source_directory.is_dir());
        assert!(destination_directory.is_dir());
        fs::remove_dir_all(root).expect("fixture should clean up");
    }

    #[test]
    fn file_replacement_is_atomic_and_consumes_the_source() {
        let root =
            std::env::temp_dir().join(format!("debrute-native-fs-replace-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture root should exist");
        let source = root.join("source.json");
        let destination = root.join("destination.json");
        fs::write(&source, b"new").expect("source should exist");
        fs::write(&destination, b"old").expect("destination should exist");

        replace_file_atomic(&source, &destination).expect("replacement should succeed");

        assert_eq!(fs::read(&destination).unwrap(), b"new");
        assert!(!source.exists());

        #[cfg(target_os = "windows")]
        {
            let long_directory = root.join("long-segment-".repeat(16));
            fs::create_dir_all(&long_directory).unwrap();
            let long_source = long_directory.join("source.json");
            let long_destination = long_directory.join("destination.json");
            fs::write(&long_source, b"long-new").unwrap();
            fs::write(&long_destination, b"long-old").unwrap();
            replace_file_atomic(&long_source, &long_destination).unwrap();
            assert_eq!(fs::read(&long_destination).unwrap(), b"long-new");
            assert!(!long_source.exists());
        }
        fs::remove_dir_all(root).expect("fixture should clean up");
    }

    #[test]
    fn file_replacement_backup_preserves_the_replaced_file() {
        let root = std::env::temp_dir().join(format!(
            "debrute-native-fs-replace-backup-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.bin");
        let destination = root.join("destination.bin");
        let backup = root.join("backup.bin");
        fs::write(&source, b"new").unwrap();
        fs::write(&destination, b"old").unwrap();

        replace_file_atomic_with_backup(&source, &destination, &backup).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"new");
        assert_eq!(fs::read(&backup).unwrap(), b"old");
        assert!(!source.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn external_process_paths_remove_only_supported_verbatim_prefixes() {
        assert_eq!(
            external_process_path(Path::new(r"\\?\E:\onedrive\城启设计")),
            std::path::PathBuf::from(r"E:\onedrive\城启设计")
        );
        assert_eq!(
            external_process_path(Path::new(r"\\?\E:\")),
            std::path::PathBuf::from(r"E:\")
        );
        assert_eq!(
            external_process_path(Path::new(r"\\?\UNC\server\share\project")),
            std::path::PathBuf::from(r"\\server\share\project")
        );
        assert_eq!(
            external_process_path(Path::new(r"\\?\UNC\server\share\")),
            std::path::PathBuf::from(r"\\server\share\")
        );
        assert_eq!(
            external_process_path(Path::new(r"C:\ordinary")),
            std::path::PathBuf::from(r"C:\ordinary")
        );
        let long = format!(r"\\?\C:\{}", "long-segment".repeat(30));
        assert_eq!(external_process_path(Path::new(&long)), Path::new(&long));
        let reserved = Path::new(r"\\?\UNC\server\share\CON\file.txt");
        assert_eq!(external_process_path(reserved), reserved);
        let superscript_disk = Path::new(r"\\?\C:\COM¹\file.txt");
        assert_eq!(external_process_path(superscript_disk), superscript_disk);
        let superscript_unc = Path::new(r"\\?\UNC\server\share\LPT²\file.txt");
        assert_eq!(external_process_path(superscript_unc), superscript_unc);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn replace_file_partial_failure_restores_the_displaced_destination() {
        use windows_sys::Win32::Foundation::ERROR_UNABLE_TO_MOVE_REPLACEMENT_2;

        let root = std::env::temp_dir().join(format!(
            "debrute-native-fs-partial-replace-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let destination = root.join("destination.bin");
        let backup = root.join("backup.bin");
        fs::write(&backup, b"old").unwrap();

        let error = restore_replace_file_partial_failure(
            io::Error::from_raw_os_error(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2.cast_signed()),
            &backup,
            &destination,
        )
        .unwrap_err();

        let ReplaceFileWithBackupError::Operation(error) = error else {
            panic!("successful restoration must preserve the replacement error");
        };
        assert_eq!(error.raw_os_error(), Some(1177));
        assert_eq!(fs::read(&destination).unwrap(), b"old");
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn replace_file_partial_failure_preserves_backup_when_restore_fails() {
        use windows_sys::Win32::Foundation::ERROR_UNABLE_TO_MOVE_REPLACEMENT_2;

        let root = std::env::temp_dir().join(format!(
            "debrute-native-fs-failed-restore-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let destination = root.join("destination.bin");
        let backup = root.join("backup.bin");
        fs::write(&destination, b"blocker").unwrap();
        fs::write(&backup, b"old").unwrap();

        let error = restore_replace_file_partial_failure(
            io::Error::from_raw_os_error(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2.cast_signed()),
            &backup,
            &destination,
        )
        .unwrap_err();

        let ReplaceFileWithBackupError::DestinationRestore {
            replacement,
            restore,
        } = error
        else {
            panic!("failed restoration must retain its typed result");
        };
        assert_eq!(replacement.raw_os_error(), Some(1177));
        assert_eq!(restore.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&destination).unwrap(), b"blocker");
        assert_eq!(fs::read(&backup).unwrap(), b"old");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rename_no_replace_applies_case_only_file_and_directory_renames() {
        let root =
            std::env::temp_dir().join(format!("debrute-native-fs-case-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture root should exist");
        fs::write(root.join("note.txt"), "note").expect("file fixture should exist");
        fs::create_dir(root.join("assets")).expect("directory fixture should exist");

        rename_no_replace(&root.join("note.txt"), &root.join("Note.txt"))
            .expect("case-only file rename should succeed");
        rename_no_replace(&root.join("assets"), &root.join("Assets"))
            .expect("case-only directory rename should succeed");

        let names = fs::read_dir(&root)
            .expect("fixture root should be readable")
            .map(|entry| {
                entry
                    .expect("fixture entry should be readable")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        assert!(names.iter().any(|name| name == "Note.txt"));
        assert!(names.iter().any(|name| name == "Assets"));
        fs::remove_dir_all(root).expect("fixture should clean up");
    }
}
