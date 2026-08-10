//! Narrow Windows platform primitives for Debrute product transactions.
//!
//! This crate contains the reviewed unsafe Windows API boundary. It owns no
//! network, release selection, signature verification, product policy, or
//! update transaction state.

#[cfg(target_os = "windows")]
mod windows {
    use std::{
        ffi::{OsStr, OsString},
        fs::{self, File, OpenOptions},
        io,
        mem::size_of,
        os::windows::{
            ffi::{OsStrExt as _, OsStringExt as _},
            fs::OpenOptionsExt as _,
            io::AsRawHandle as _,
        },
        path::{Path, PathBuf},
        ptr,
    };

    use windows_sys::Win32::UI::Shell::{
        FOLDERID_LocalAppData, FOLDERID_Profile, FOLDERID_Programs, SHGetKnownFolderPath,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GENERIC_WRITE, HANDLE, WAIT_TIMEOUT},
        Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FlushFileBuffers, GetFileInformationByHandle, MOVEFILE_DELAY_UNTIL_REBOOT, MoveFileExW,
        },
        System::{
            Com::CoTaskMemFree,
            Environment::ExpandEnvironmentStringsW,
            IO::DeviceIoControl,
            Ioctl::FSCTL_SET_REPARSE_POINT,
            SystemServices::IO_REPARSE_TAG_MOUNT_POINT,
            Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
        },
        UI::WindowsAndMessaging::{
            HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
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

    /// Resolves the current Windows account profile through the Known Folder API.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when the Known Folder API cannot resolve
    /// the current account profile.
    pub fn current_user_profile_directory() -> io::Result<PathBuf> {
        known_folder_path(&FOLDERID_Profile)
    }

    /// Resolves the current Windows account Local `AppData` through the Known Folder API.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when the Known Folder API cannot resolve
    /// the current account Local `AppData` directory.
    pub fn current_user_local_app_data_directory() -> io::Result<PathBuf> {
        known_folder_path(&FOLDERID_LocalAppData)
    }

    /// Resolves the current Windows account Start Menu Programs directory.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when the Known Folder API cannot resolve
    /// the current account Start Menu Programs directory.
    pub fn current_user_programs_directory() -> io::Result<PathBuf> {
        known_folder_path(&FOLDERID_Programs)
    }

    /// Expands one Windows environment string with the current process block.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when Windows cannot size or expand the
    /// exact UTF-16 input.
    pub fn expand_environment_strings(value: &OsStr) -> io::Result<OsString> {
        let source = value.encode_wide().chain(Some(0)).collect::<Vec<_>>();
        // SAFETY: `source` is a live, NUL-terminated UTF-16 buffer. A null
        // destination with zero capacity is the documented sizing call.
        let required = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), ptr::null_mut(), 0) };
        if required == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut expanded = vec![0_u16; required as usize];
        // SAFETY: both buffers are live, `expanded` has the exact capacity
        // returned by the sizing call, and the API writes at most that count.
        let written =
            unsafe { ExpandEnvironmentStringsW(source.as_ptr(), expanded.as_mut_ptr(), required) };
        if written == 0 {
            return Err(io::Error::last_os_error());
        }
        if written > required {
            return Err(io::Error::other(
                "Windows environment changed while PATH was expanded",
            ));
        }
        expanded.truncate(written.saturating_sub(1) as usize);
        Ok(OsString::from_wide(&expanded))
    }

    /// Returns whether `process_id` still identifies a live synchronizable process.
    #[must_use]
    pub fn process_is_running(process_id: u32) -> bool {
        // SAFETY: the PID is a value, no borrowed memory crosses the call, and
        // every non-null owned handle is closed below.
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, process_id) };
        if handle.is_null() {
            return false;
        }
        // SAFETY: `handle` is non-null and remains owned until CloseHandle.
        let status = unsafe { WaitForSingleObject(handle, 0) };
        // SAFETY: this is the one close of the owned process handle.
        unsafe { CloseHandle(handle) };
        status == WAIT_TIMEOUT
    }

    /// Schedules one exact path for deletion at the next Windows reboot.
    ///
    /// # Errors
    ///
    /// Returns the operating-system error when Windows rejects the exact path.
    pub fn schedule_delete_on_reboot(path: &Path) -> io::Result<()> {
        schedule_delete_on_reboot_with(path, |source, destination, flags| {
            // SAFETY: the helper owns the live, NUL-terminated source buffer;
            // the null destination and delayed-delete flag are fixed below.
            unsafe { MoveFileExW(source, destination, flags) }
        })
    }

    pub(super) fn schedule_delete_on_reboot_with(
        path: &Path,
        move_file: impl FnOnce(*const u16, *const u16, u32) -> i32,
    ) -> io::Result<()> {
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        if move_file(wide.as_ptr(), ptr::null(), MOVEFILE_DELAY_UNTIL_REBOOT) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Broadcasts the documented per-user environment-change notification.
    pub fn broadcast_environment_change() {
        let environment = "Environment\0".encode_utf16().collect::<Vec<_>>();
        // SAFETY: the UTF-16 buffer remains live during this synchronous call;
        // the timeout bounds unresponsive top-level windows.
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                environment.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5_000,
                ptr::null_mut(),
            );
        }
    }

    fn known_folder_path(folder: &windows_sys::core::GUID) -> io::Result<PathBuf> {
        let mut raw = ptr::null_mut();
        // SAFETY: `folder` and `raw` are valid pointers for the synchronous call;
        // a null token requests the current user. A successful allocation is
        // copied and released exactly once below.
        let result = unsafe { SHGetKnownFolderPath(folder, 0, ptr::null_mut(), &raw mut raw) };
        if result < 0 {
            return Err(io::Error::other(format!(
                "SHGetKnownFolderPath failed with HRESULT {result:#x}"
            )));
        }
        if raw.is_null() {
            return Err(io::Error::other(
                "SHGetKnownFolderPath returned a null path",
            ));
        }
        // SAFETY: the API returned a live NUL-terminated UTF-16 allocation.
        let length = unsafe {
            let mut length = 0;
            while *raw.add(length) != 0 {
                length += 1;
            }
            length
        };
        // SAFETY: `length` was found within the returned NUL-terminated buffer.
        let path = PathBuf::from(OsString::from_wide(unsafe {
            std::slice::from_raw_parts(raw, length)
        }));
        // SAFETY: this is the one release of the API-owned allocation.
        unsafe { CoTaskMemFree(raw.cast()) };
        if path.as_os_str().is_empty() {
            Err(io::Error::other("Known Folder path is empty"))
        } else {
            Ok(path)
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
    FileIdentity, broadcast_environment_change, create_junction,
    current_user_local_app_data_directory, current_user_profile_directory,
    current_user_programs_directory, expand_environment_strings, junction_identity,
    junction_target, process_is_running, retarget_junction, schedule_delete_on_reboot,
    sync_directory,
};

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use std::{ffi::OsString, fs, os::windows::ffi::OsStringExt as _, process, time::SystemTime};

    use windows_sys::Win32::Storage::FileSystem::MOVEFILE_DELAY_UNTIL_REBOOT;

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
    fn reboot_deletion_uses_the_exact_path_and_delayed_delete_form() {
        let path = temporary_root("reboot-delete").join("runtime capsule");
        let mut observed = None;

        super::windows::schedule_delete_on_reboot_with(&path, |source, destination, flags| {
            assert!(destination.is_null());
            assert_eq!(flags, MOVEFILE_DELAY_UNTIL_REBOOT);
            let mut length = 0;
            // SAFETY: the scheduling helper passes its live,
            // NUL-terminated UTF-16 source buffer for this call.
            while unsafe { *source.add(length) } != 0 {
                length += 1;
            }
            // SAFETY: `length` was measured within that live buffer.
            let units = unsafe { std::slice::from_raw_parts(source, length) };
            observed = Some(OsString::from_wide(units));
            1
        })
        .unwrap();

        assert_eq!(observed.as_deref(), Some(path.as_os_str()));
    }
}
