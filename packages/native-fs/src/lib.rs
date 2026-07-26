//! Narrow native filesystem primitives with no policy or transaction state.

use std::{fs::File, io, path::Path};

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

#[cfg(target_os = "windows")]
fn windows_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt as _;

    let mut encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows path contains NUL",
        ));
    }
    encoded.push(0);
    Ok(encoded)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn rename_no_replace_preserves_an_existing_destination() {
        let root = std::env::temp_dir().join(format!("debrute-native-fs-{}", std::process::id()));
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
}
