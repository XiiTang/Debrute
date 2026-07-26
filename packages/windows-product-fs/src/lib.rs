//! Narrow Windows filesystem primitives for Debrute product commits.
//!
//! This crate contains the only unsafe Windows API boundary. It owns no
//! network, release selection, signature verification, product policy, or
//! update transaction state.

#[cfg(target_os = "windows")]
mod windows {
    use std::{
        fs::{self, File, OpenOptions},
        io,
        mem::size_of,
        os::windows::{ffi::OsStrExt as _, fs::OpenOptionsExt as _, io::AsRawHandle as _},
        path::{Path, PathBuf},
        ptr,
    };

    use windows_sys::Win32::{
        Foundation::{GENERIC_WRITE, HANDLE},
        Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FlushFileBuffers, GetFileInformationByHandle, MOVEFILE_REPLACE_EXISTING,
            MOVEFILE_WRITE_THROUGH, MoveFileExW,
        },
        System::{
            IO::DeviceIoControl, Ioctl::FSCTL_SET_REPARSE_POINT,
            SystemServices::IO_REPARSE_TAG_MOUNT_POINT,
        },
    };

    const SHARE_READ_WRITE_DELETE: u32 = 7;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct FileIdentity {
        volume_serial_number: u32,
        file_index: u64,
    }

    /// Creates and durably flushes a junction at `pointer` targeting `target`.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when junction creation or the
    /// durability flush fails. A failed creation is cleaned up before return.
    pub fn create_junction(target: &Path, pointer: &Path) -> io::Result<()> {
        if let Err(error) = junction::create(target, pointer) {
            let _cleanup_result = fs::remove_dir(pointer);
            return Err(error);
        }
        if let Err(error) = flush_reparse_point(pointer) {
            let _cleanup_result = fs::remove_dir(pointer);
            return Err(error);
        }
        Ok(())
    }

    /// Reads the target stored in an existing junction.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when `pointer` is not a readable
    /// junction or its target cannot be decoded.
    pub fn junction_target(pointer: &Path) -> io::Result<PathBuf> {
        junction::get_target(pointer)
    }

    /// Reads the stable filesystem identity of the junction itself.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when the reparse point cannot be
    /// opened or queried.
    pub fn junction_identity(pointer: &Path) -> io::Result<FileIdentity> {
        let file = open_directory(pointer, true)?;
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: `file` is live for the call and `information` is a valid,
        // writable output structure of the exact API-required type.
        let success = unsafe {
            GetFileInformationByHandle(
                file.as_raw_handle().cast::<core::ffi::c_void>() as HANDLE,
                &raw mut information,
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(FileIdentity {
            volume_serial_number: information.dwVolumeSerialNumber,
            file_index: (u64::from(information.nFileIndexHigh) << 32)
                | u64::from(information.nFileIndexLow),
        })
    }

    /// Retargets an existing junction in place and durably flushes the result.
    ///
    /// # Errors
    ///
    /// Returns an error when the target cannot be made absolute, its encoded
    /// reparse data is too large, or Windows cannot open, retarget, or flush the
    /// junction.
    pub fn retarget_junction(pointer: &Path, target: &Path) -> io::Result<()> {
        let absolute_target = std::path::absolute(target)?;
        let mut target_wide = absolute_target
            .as_os_str()
            .encode_wide()
            .collect::<Vec<_>>();
        let verbatim_prefix = b"\\\\?\\".map(u16::from);
        if target_wide.starts_with(&verbatim_prefix) {
            target_wide.drain(..verbatim_prefix.len());
        }
        let nt_prefix = b"\\??\\".map(u16::from);
        let substitute = nt_prefix.into_iter().chain(target_wide).collect::<Vec<_>>();
        let substitute_bytes = substitute
            .len()
            .checked_mul(size_of::<u16>())
            .and_then(|length| u16::try_from(length).ok())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "junction target is too long")
            })?;
        let mut buffer = vec![0_u8; substitute.len() * size_of::<u16>() + 20];
        let reparse_data_length = substitute_bytes.checked_add(12).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "junction target is too long")
        })?;
        let print_name_offset = substitute_bytes.checked_add(2).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "junction target is too long")
        })?;
        let buffer_length = u32::from(reparse_data_length) + 8;
        write_u32(&mut buffer, 0, IO_REPARSE_TAG_MOUNT_POINT);
        write_u16(&mut buffer, 4, reparse_data_length);
        write_u16(&mut buffer, 10, substitute_bytes);
        write_u16(&mut buffer, 12, print_name_offset);
        for (index, unit) in substitute.into_iter().enumerate() {
            write_u16(&mut buffer, 16 + index * size_of::<u16>(), unit);
        }

        let file = open_directory(pointer, true)?;
        let mut returned = 0_u32;
        // SAFETY: `file` is a live reparse-point handle; `buffer` remains
        // allocated for the call and its byte length exactly matches the input
        // length. No output or overlapped pointer is supplied.
        let success = unsafe {
            DeviceIoControl(
                file.as_raw_handle().cast::<core::ffi::c_void>() as HANDLE,
                FSCTL_SET_REPARSE_POINT,
                buffer.as_ptr().cast::<core::ffi::c_void>(),
                buffer_length,
                ptr::null_mut(),
                0,
                &raw mut returned,
                ptr::null_mut(),
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        flush_file(&file)
    }

    /// Durably flushes directory metadata.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when the directory cannot be opened
    /// or flushed.
    pub fn sync_directory(path: &Path) -> io::Result<()> {
        let file = open_directory(path, false)?;
        flush_file(&file)
    }

    /// Atomically replaces `destination` with `source` and requests write-through.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when Windows cannot perform the
    /// same-volume replacement and durability operation.
    pub fn replace_file_atomic(source: &Path, destination: &Path) -> io::Result<()> {
        let source = wide_path(source);
        let destination = wide_path(destination);
        // SAFETY: both vectors are live, NUL-terminated UTF-16 path buffers for
        // the duration of the call. Flags request same-volume replacement and
        // write-through; Windows reports all validation failures via GetLastError.
        let success = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if success == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn flush_reparse_point(path: &Path) -> io::Result<()> {
        let file = open_directory(path, true)?;
        flush_file(&file)
    }

    fn open_directory(path: &Path, reparse_point: bool) -> io::Result<File> {
        let flags = FILE_FLAG_BACKUP_SEMANTICS
            | if reparse_point {
                FILE_FLAG_OPEN_REPARSE_POINT
            } else {
                0
            };
        OpenOptions::new()
            .access_mode(GENERIC_WRITE)
            .share_mode(SHARE_READ_WRITE_DELETE)
            .custom_flags(flags)
            .open(path)
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain([0]).collect()
    }

    fn flush_file(file: &File) -> io::Result<()> {
        // SAFETY: the handle is owned by `file` and remains valid for the call.
        let success =
            unsafe { FlushFileBuffers(file.as_raw_handle().cast::<core::ffi::c_void>() as HANDLE) };
        if success == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn write_u16(buffer: &mut [u8], offset: usize, value: u16) {
        buffer[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn write_u32(buffer: &mut [u8], offset: usize, value: u32) {
        buffer[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
}

#[cfg(target_os = "windows")]
pub use windows::{
    FileIdentity, create_junction, junction_identity, junction_target, replace_file_atomic,
    retarget_junction, sync_directory,
};

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use std::{fs, process, time::SystemTime};

    fn temporary_root(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "debrute-windows-product-fs-{label}-{}-{nonce}",
            process::id()
        ))
    }

    #[test]
    fn junction_is_retargeted_in_place_and_flushed() {
        let root = temporary_root("junction");
        let first = root.join("first");
        let second = root.join("second");
        let current = root.join("current");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();

        super::create_junction(&first, &current).unwrap();
        let pointer_identity = super::junction_identity(&current).unwrap();
        assert_eq!(
            fs::canonicalize(super::junction_target(&current).unwrap()).unwrap(),
            fs::canonicalize(&first).unwrap()
        );

        super::retarget_junction(&current, &second).unwrap();
        super::sync_directory(&root).unwrap();

        assert_eq!(
            super::junction_identity(&current).unwrap(),
            pointer_identity
        );
        assert_eq!(
            fs::canonicalize(super::junction_target(&current).unwrap()).unwrap(),
            fs::canonicalize(&second).unwrap()
        );
        fs::remove_dir(&current).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_replacement_is_atomic_and_consumes_the_source() {
        let root = temporary_root("replace");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.json");
        let destination = root.join("destination.json");
        fs::write(&source, b"new").unwrap();
        fs::write(&destination, b"old").unwrap();

        super::replace_file_atomic(&source, &destination).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"new");
        assert!(!source.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
