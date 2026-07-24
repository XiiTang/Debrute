//! Narrow Windows primitives for Debrute's current-user Control endpoint.
//!
//! Runtime protocol, lifecycle, request authorization, and retry policy remain
//! outside this native safety capsule. This crate owns only HANDLE/SID safety.

#[cfg(target_os = "windows")]
mod windows {
    use std::{
        ffi::{OsStr, c_void},
        fs::{File, OpenOptions},
        io,
        mem::size_of,
        os::windows::{
            ffi::{OsStrExt as _, OsStringExt as _},
            io::FromRawHandle as _,
        },
        ptr, thread,
        time::{Duration, Instant},
    };

    use windows_sys::{
        Win32::{
            Foundation::{
                CloseHandle, ERROR_ALREADY_EXISTS, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND,
                ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GetLastError, HANDLE,
                INVALID_HANDLE_VALUE, LocalFree,
            },
            Security::{
                Authorization::{
                    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                    SDDL_REVISION_1,
                },
                EqualSid, GetTokenInformation, PSECURITY_DESCRIPTOR, PSID, RevertToSelf,
                SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
            },
            Storage::FileSystem::PIPE_ACCESS_DUPLEX,
            System::{
                IO::CancelIoEx,
                Pipes::{
                    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe,
                    ImpersonateNamedPipeClient, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
                    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, PeekNamedPipe, WaitNamedPipeW,
                },
                Threading::{
                    CreateMutexW, GetCurrentProcess, GetCurrentThread, OpenProcessToken,
                    OpenThreadToken,
                },
            },
        },
        core::PWSTR,
    };

    const PIPE_PREFIX: &str = r"\\.\pipe\debrute-control-";
    const MUTEX_PREFIX: &str = r"Local\DebruteRuntime-";
    const PIPE_BUFFER_BYTES: u32 = 64 * 1024;

    #[derive(Debug, Clone)]
    pub struct WindowsControlEndpoint {
        pipe_name: String,
        mutex_name: String,
        current_user_sid: Sid,
    }

    impl WindowsControlEndpoint {
        /// Resolves the current user's SID-named pipe and mutex.
        ///
        /// # Errors
        ///
        /// Returns an operating-system error when the process token or SID
        /// cannot be inspected.
        pub fn for_current_user() -> io::Result<Self> {
            let current_user_sid = process_user_sid()?;
            let sid = current_user_sid.to_string()?;
            Ok(Self {
                pipe_name: format!("{PIPE_PREFIX}{sid}"),
                mutex_name: format!("{MUTEX_PREFIX}{sid}"),
                current_user_sid,
            })
        }

        #[must_use]
        pub fn pipe_name(&self) -> &str {
            &self.pipe_name
        }

        #[must_use]
        pub fn mutex_name(&self) -> &str {
            &self.mutex_name
        }

        /// Connects to the live Runtime or atomically claims its user mutex.
        ///
        /// # Errors
        ///
        /// Returns an operating-system error when endpoint discovery, secure
        /// mutex creation, or the bounded startup wait fails.
        pub fn claim_or_connect(&self, startup_wait: Duration) -> io::Result<WindowsEndpointClaim> {
            let deadline = Instant::now().checked_add(startup_wait).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "startup wait is too large")
            })?;
            loop {
                match connect_pipe(&self.pipe_name) {
                    Ok(connection) => return Ok(WindowsEndpointClaim::Existing(connection)),
                    Err(error) if endpoint_is_starting(&error) => {}
                    Err(error) => return Err(error),
                }

                if let Some(instance_mutex) = claim_mutex(
                    &self.mutex_name,
                    &SecurityDescriptor::for_user(&self.current_user_sid)?,
                )? {
                    return Ok(WindowsEndpointClaim::Owner(WindowsControlOwner {
                        pipe_name: self.pipe_name.clone(),
                        current_user_sid: self.current_user_sid.clone(),
                        _instance_mutex: instance_mutex,
                    }));
                }

                let now = Instant::now();
                if now >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Control endpoint startup timed out",
                    ));
                }
                let remaining_ms = (deadline - now).as_millis().clamp(1, 10) as u32;
                let pipe = wide_null(&self.pipe_name);
                // SAFETY: `pipe` is a live, NUL-terminated UTF-16 name. This
                // wait neither creates nor transfers ownership of a handle.
                unsafe { WaitNamedPipeW(pipe.as_ptr(), remaining_ms) };
            }
        }

        /// Connects to an already-listening Runtime without claiming its mutex.
        ///
        /// # Errors
        /// Returns the native pipe-open error when Runtime is absent or unavailable.
        pub fn connect_existing(&self) -> io::Result<WindowsControlConnection> {
            connect_pipe(&self.pipe_name)
        }

        /// Opens a connection used only to release a blocking accept on stop.
        ///
        /// # Errors
        ///
        /// Returns an operating-system error when the pipe is not listening.
        pub fn wake_accept(&self) -> io::Result<WindowsControlConnection> {
            connect_pipe(&self.pipe_name)
        }
    }

    #[derive(Debug)]
    pub enum WindowsEndpointClaim {
        Owner(WindowsControlOwner),
        Existing(WindowsControlConnection),
    }

    #[derive(Debug)]
    pub struct WindowsControlOwner {
        pipe_name: String,
        current_user_sid: Sid,
        _instance_mutex: OwnedHandle,
    }

    impl WindowsControlOwner {
        /// Accepts one local client and authorizes its impersonation SID.
        ///
        /// # Errors
        ///
        /// Returns an operating-system error when pipe creation, connection,
        /// impersonation, or SID authorization fails.
        pub fn accept_current_user(&self) -> io::Result<WindowsControlConnection> {
            let security = SecurityDescriptor::for_user(&self.current_user_sid)?;
            let attributes = security.attributes();
            let pipe_name = wide_null(&self.pipe_name);
            // SAFETY: the name and security descriptor are valid for the call;
            // on success the returned unique server HANDLE is owned below.
            let handle = unsafe {
                CreateNamedPipeW(
                    pipe_name.as_ptr(),
                    PIPE_ACCESS_DUPLEX,
                    PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    PIPE_UNLIMITED_INSTANCES,
                    PIPE_BUFFER_BYTES,
                    PIPE_BUFFER_BYTES,
                    0,
                    &raw const attributes,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let owned = OwnedHandle(handle);
            // SAFETY: `owned` is a live server pipe. A null OVERLAPPED pointer
            // requests the synchronous connection mode used by this adapter.
            let connected = unsafe { ConnectNamedPipe(owned.0, ptr::null_mut()) };
            if connected == 0 {
                // A client may connect between CreateNamedPipeW and
                // ConnectNamedPipe; Windows reports that successful race as
                // ERROR_PIPE_CONNECTED.
                let error = unsafe { GetLastError() };
                if error != ERROR_PIPE_CONNECTED {
                    return Err(io::Error::from_raw_os_error(error.cast_signed()));
                }
            }
            authorize_pipe_client(owned.0, &self.current_user_sid)?;
            Ok(WindowsControlConnection::from_owned_handle(owned))
        }
    }

    #[derive(Debug)]
    pub struct WindowsControlConnection {
        file: File,
        read_timeout: Option<Duration>,
    }

    impl WindowsControlConnection {
        fn from_owned_handle(handle: OwnedHandle) -> Self {
            let raw = handle.into_raw();
            // SAFETY: `raw` is a uniquely owned, valid pipe HANDLE and File
            // becomes its sole owner.
            Self {
                file: unsafe { File::from_raw_handle(raw.cast::<c_void>()) },
                read_timeout: None,
            }
        }

        /// Duplicates the pipe HANDLE for ordered writes or cancellation.
        ///
        /// # Errors
        ///
        /// Returns an operating-system error when the HANDLE cannot be cloned.
        pub fn try_clone(&self) -> io::Result<Self> {
            self.file.try_clone().map(|file| Self {
                file,
                read_timeout: self.read_timeout,
            })
        }

        pub fn set_read_timeout(&mut self, timeout: Option<Duration>) {
            self.read_timeout = timeout;
        }

        pub fn shutdown(&self) {
            use std::os::windows::io::AsRawHandle as _;

            let handle = self.file.as_raw_handle().cast::<c_void>() as HANDLE;
            // SAFETY: this is a live pipe HANDLE. CancelIoEx cancels pending
            // operations and DisconnectNamedPipe tears down the shared server
            // instance; the latter is harmlessly rejected for a client handle.
            unsafe {
                CancelIoEx(handle, ptr::null());
                DisconnectNamedPipe(handle);
            }
        }
    }

    impl io::Read for WindowsControlConnection {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let Some(timeout) = self.read_timeout else {
                return io::Read::read(&mut self.file, buffer);
            };
            let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "read timeout is too large")
            })?;
            loop {
                if pipe_has_bytes(&self.file)? {
                    return io::Read::read(&mut self.file, buffer);
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Control pipe read timed out",
                    ));
                }
                thread::sleep(Duration::from_millis(2));
            }
        }
    }

    impl io::Write for WindowsControlConnection {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            io::Write::write(&mut self.file, buffer)
        }

        fn flush(&mut self) -> io::Result<()> {
            io::Write::flush(&mut self.file)
        }
    }

    fn connect_pipe(pipe_name: &str) -> io::Result<WindowsControlConnection> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(pipe_name)
            .map(|file| WindowsControlConnection {
                file,
                read_timeout: None,
            })
    }

    fn pipe_has_bytes(file: &File) -> io::Result<bool> {
        use std::os::windows::io::AsRawHandle as _;

        let mut available = 0_u32;
        let handle = file.as_raw_handle().cast::<c_void>() as HANDLE;
        // SAFETY: `handle` is a live pipe and only the available byte count is
        // requested into a valid u32 output.
        if unsafe {
            PeekNamedPipe(
                handle,
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                &raw mut available,
                ptr::null_mut(),
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            return match error.raw_os_error().map(i32::cast_unsigned) {
                Some(ERROR_BROKEN_PIPE | ERROR_NO_DATA) => Ok(true),
                _ => Err(error),
            };
        }
        Ok(available > 0)
    }

    fn endpoint_is_starting(error: &io::Error) -> bool {
        matches!(
            error.raw_os_error().map(i32::cast_unsigned),
            Some(ERROR_FILE_NOT_FOUND | ERROR_PIPE_BUSY)
        )
    }

    fn claim_mutex(name: &str, security: &SecurityDescriptor) -> io::Result<Option<OwnedHandle>> {
        let name = wide_null(name);
        let attributes = security.attributes();
        // SAFETY: name and security descriptor are live through the call. The
        // returned HANDLE, when unique, is transferred to OwnedHandle.
        let handle = unsafe { CreateMutexW(&raw const attributes, 1, name.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let owned = OwnedHandle(handle);
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            Ok(None)
        } else {
            Ok(Some(owned))
        }
    }

    fn authorize_pipe_client(handle: HANDLE, expected: &Sid) -> io::Result<()> {
        // SAFETY: the pipe is connected. Windows installs the client's token
        // only on this server thread until RevertToSelf is called.
        if unsafe { ImpersonateNamedPipeClient(handle) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let guard = ImpersonationGuard;
        let actual = thread_user_sid();
        drop(guard);
        let actual = actual?;
        // SAFETY: both SID buffers contain complete SIDs and remain live.
        if unsafe { EqualSid(expected.as_psid(), actual.as_psid()) } == 0 {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Control peer SID does not match Runtime user SID",
            ))
        } else {
            Ok(())
        }
    }

    struct ImpersonationGuard;

    impl Drop for ImpersonationGuard {
        fn drop(&mut self) {
            // SAFETY: this guard is created only after successful impersonation
            // on the current thread and reverts that thread exactly once.
            unsafe { RevertToSelf() };
        }
    }

    #[derive(Debug, Clone)]
    struct Sid(Vec<u8>);

    impl Sid {
        fn as_psid(&self) -> PSID {
            self.0.as_ptr().cast_mut().cast::<c_void>()
        }

        fn to_string(&self) -> io::Result<String> {
            let mut pointer: PWSTR = ptr::null_mut();
            // SAFETY: the SID buffer is live and valid; Windows allocates the
            // output string and its ownership is released with LocalFree.
            if unsafe { ConvertSidToStringSidW(self.as_psid(), &raw mut pointer) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let allocation = LocalAllocation(pointer.cast::<c_void>());
            let mut length = 0;
            // SAFETY: ConvertSidToStringSidW returned a NUL-terminated string.
            while unsafe { *pointer.add(length) } != 0 {
                length += 1;
            }
            // SAFETY: the scanned units are within the live NUL-terminated
            // allocation and exclude its terminator.
            let units = unsafe { std::slice::from_raw_parts(pointer, length) };
            let value = std::ffi::OsString::from_wide(units)
                .into_string()
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "SID is not Unicode"));
            drop(allocation);
            value
        }
    }

    fn process_user_sid() -> io::Result<Sid> {
        let mut token = ptr::null_mut();
        // SAFETY: GetCurrentProcess is a pseudo-handle and `token` is a valid
        // writable HANDLE output slot.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = OwnedHandle(token);
        token_user_sid(&token)
    }

    fn thread_user_sid() -> io::Result<Sid> {
        let mut token = ptr::null_mut();
        // SAFETY: called only while impersonating; `token` is a valid output.
        if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &raw mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = OwnedHandle(token);
        token_user_sid(&token)
    }

    fn token_user_sid(token: &OwnedHandle) -> io::Result<Sid> {
        let mut required = 0_u32;
        // SAFETY: null output requests the exact required byte count.
        unsafe {
            GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &raw mut required);
        }
        if required < u32::try_from(size_of::<TOKEN_USER>()).expect("TOKEN_USER size fits u32") {
            return Err(io::Error::last_os_error());
        }
        let word_count = (required as usize).div_ceil(size_of::<usize>());
        let mut buffer = vec![0_usize; word_count];
        // SAFETY: `buffer` is writable for exactly `required` bytes and token
        // remains owned for the call.
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast::<c_void>(),
                required,
                &raw mut required,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful TokenUser output begins with TOKEN_USER and its
        // SID pointer remains valid while `buffer` is live.
        let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
        let sid_length = unsafe { windows_sys::Win32::Security::GetLengthSid(user.User.Sid) };
        if sid_length == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut sid = vec![0_u8; sid_length as usize];
        // SAFETY: destination has exactly the OS-reported size and source is
        // the live token buffer SID.
        if unsafe {
            windows_sys::Win32::Security::CopySid(
                sid_length,
                sid.as_mut_ptr().cast::<c_void>(),
                user.User.Sid,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Sid(sid))
    }

    struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

    impl SecurityDescriptor {
        fn for_user(sid: &Sid) -> io::Result<Self> {
            let sddl = wide_null(&format!("D:P(A;;GA;;;{})", sid.to_string()?));
            let mut descriptor = ptr::null_mut();
            // SAFETY: input is a live NUL-terminated SDDL string; Windows
            // allocates one self-relative descriptor returned through output.
            if unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &raw mut descriptor,
                    ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(descriptor))
        }

        fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
                    .expect("SECURITY_ATTRIBUTES size fits u32"),
                lpSecurityDescriptor: self.0,
                bInheritHandle: 0,
            }
        }
    }

    impl Drop for SecurityDescriptor {
        fn drop(&mut self) {
            // SAFETY: the descriptor was allocated by LocalAlloc through the
            // conversion API and has not been freed or transferred.
            unsafe { LocalFree(self.0) };
        }
    }

    struct LocalAllocation(*mut c_void);

    impl Drop for LocalAllocation {
        fn drop(&mut self) {
            // SAFETY: this pointer is a LocalAlloc-family allocation returned
            // by a Windows conversion API and is owned exactly once here.
            unsafe { LocalFree(self.0) };
        }
    }

    #[derive(Debug)]
    struct OwnedHandle(HANDLE);

    // SAFETY: OwnedHandle has unique HANDLE ownership, exposes no references to
    // handle-backed memory, and Windows kernel handles may be closed or used
    // from a different thread.
    unsafe impl Send for OwnedHandle {}

    impl OwnedHandle {
        fn into_raw(self) -> *mut c_void {
            let handle = self.0;
            std::mem::forget(self);
            handle.cast::<c_void>()
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                // SAFETY: this wrapper uniquely owns the live HANDLE.
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    fn wide_null(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain([0]).collect()
    }
}

#[cfg(target_os = "windows")]
pub use windows::{
    WindowsControlConnection, WindowsControlEndpoint, WindowsControlOwner, WindowsEndpointClaim,
};
