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
            fs::OpenOptionsExt as _,
            io::FromRawHandle as _,
        },
        ptr,
        time::{Duration, Instant},
    };

    use windows_sys::{
        Win32::{
            Foundation::{
                CloseHandle, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING,
                ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
                LocalFree, WAIT_OBJECT_0, WAIT_TIMEOUT,
            },
            Security::{
                Authorization::{
                    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                    SDDL_REVISION_1,
                },
                EqualSid, GetTokenInformation, PSECURITY_DESCRIPTOR, PSID, RevertToSelf,
                SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
            },
            Storage::FileSystem::{FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX, ReadFile, WriteFile},
            System::{
                IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
                Pipes::{
                    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe,
                    ImpersonateNamedPipeClient, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
                    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, WaitNamedPipeW,
                },
                Threading::{
                    CreateEventW, CreateMutexW, GetCurrentProcess, GetCurrentThread, INFINITE,
                    OpenProcessToken, OpenThreadToken, WaitForSingleObject,
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
        /// Accepts one local client into a connection that authorizes its
        /// impersonation SID before exposing the first client bytes.
        ///
        /// # Errors
        ///
        /// Returns an operating-system error when pipe creation or connection
        /// fails. First-read authorization failures are returned by the
        /// connection's [`io::Read`] implementation.
        pub fn accept_current_user(&self) -> io::Result<WindowsControlConnection> {
            let security = SecurityDescriptor::for_user(&self.current_user_sid)?;
            let attributes = security.attributes();
            let pipe_name = wide_null(&self.pipe_name);
            // SAFETY: the name and security descriptor are valid for the call;
            // on success the returned unique server HANDLE is owned below.
            let handle = unsafe {
                CreateNamedPipeW(
                    pipe_name.as_ptr(),
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
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
            connect_named_pipe(&owned)?;
            Ok(WindowsControlConnection::from_owned_handle(
                owned,
                self.current_user_sid.clone(),
            ))
        }
    }

    #[derive(Debug)]
    pub struct WindowsControlConnection {
        file: File,
        read_timeout: Option<Duration>,
        peer_authorization: PeerAuthorization,
    }

    #[derive(Debug, Clone)]
    enum PeerAuthorization {
        NotRequired,
        Pending(Sid),
        Authorized,
        Rejected,
    }

    impl WindowsControlConnection {
        fn from_owned_handle(handle: OwnedHandle, expected_user_sid: Sid) -> Self {
            let raw = handle.into_raw();
            // SAFETY: `raw` is a uniquely owned, valid pipe HANDLE and File
            // becomes its sole owner.
            Self {
                file: unsafe { File::from_raw_handle(raw.cast::<c_void>()) },
                read_timeout: None,
                peer_authorization: PeerAuthorization::Pending(expected_user_sid),
            }
        }

        /// Duplicates the pipe HANDLE for ordered writes or cancellation.
        ///
        /// # Errors
        ///
        /// Returns an operating-system error when the HANDLE cannot be cloned.
        pub fn try_clone(&self) -> io::Result<Self> {
            if matches!(
                self.peer_authorization,
                PeerAuthorization::Pending(_) | PeerAuthorization::Rejected
            ) {
                return Err(peer_not_authorized());
            }
            self.file.try_clone().map(|file| Self {
                file,
                read_timeout: self.read_timeout,
                peer_authorization: self.peer_authorization.clone(),
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
            use std::os::windows::io::AsRawHandle as _;

            if matches!(self.peer_authorization, PeerAuthorization::Rejected) {
                return Err(peer_not_authorized());
            }
            let handle = self.file.as_raw_handle().cast::<c_void>() as HANDLE;
            let read = overlapped_read(handle, buffer, self.read_timeout)?;
            if read > 0
                && let PeerAuthorization::Pending(expected) = &self.peer_authorization
            {
                let expected = expected.clone();
                if let Err(error) = authorize_pipe_client(handle, &expected) {
                    self.peer_authorization = PeerAuthorization::Rejected;
                    return Err(error);
                }
                self.peer_authorization = PeerAuthorization::Authorized;
            }
            Ok(read)
        }
    }

    impl io::Write for WindowsControlConnection {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            use std::os::windows::io::AsRawHandle as _;

            if matches!(
                self.peer_authorization,
                PeerAuthorization::Pending(_) | PeerAuthorization::Rejected
            ) {
                return Err(peer_not_authorized());
            }
            let handle = self.file.as_raw_handle().cast::<c_void>() as HANDLE;
            overlapped_write(handle, buffer)
        }

        fn flush(&mut self) -> io::Result<()> {
            if matches!(
                self.peer_authorization,
                PeerAuthorization::Pending(_) | PeerAuthorization::Rejected
            ) {
                return Err(peer_not_authorized());
            }
            Ok(())
        }
    }

    fn connect_pipe(pipe_name: &str) -> io::Result<WindowsControlConnection> {
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_OVERLAPPED);
        options
            .open(pipe_name)
            .map(|file| WindowsControlConnection {
                file,
                read_timeout: None,
                peer_authorization: PeerAuthorization::NotRequired,
            })
    }

    fn peer_not_authorized() -> io::Error {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Control peer is not authorized",
        )
    }

    fn connect_named_pipe(pipe: &OwnedHandle) -> io::Result<()> {
        let (event, mut overlapped) = new_overlapped()?;
        // SAFETY: `pipe` is a live overlapped server pipe. `overlapped` and
        // its event remain live until this connection operation completes.
        if unsafe { ConnectNamedPipe(pipe.0, &raw mut overlapped) } != 0 {
            return Ok(());
        }
        match unsafe { GetLastError() } {
            ERROR_IO_PENDING => wait_for_overlapped(pipe.0, &overlapped, &event, None).map(|_| ()),
            // A client may connect between CreateNamedPipeW and
            // ConnectNamedPipe; Windows reports that successful race here.
            ERROR_PIPE_CONNECTED => Ok(()),
            error => Err(io::Error::from_raw_os_error(error.cast_signed())),
        }
    }

    fn overlapped_read(
        handle: HANDLE,
        buffer: &mut [u8],
        timeout: Option<Duration>,
    ) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let length = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        let (event, mut overlapped) = new_overlapped()?;
        let mut transferred = 0_u32;
        // SAFETY: `handle` is a live overlapped pipe. `buffer`, `overlapped`,
        // and the event remain live until the operation has completed or has
        // been cancelled and reaped by `wait_for_overlapped`.
        if unsafe {
            ReadFile(
                handle,
                buffer.as_mut_ptr(),
                length,
                &raw mut transferred,
                &raw mut overlapped,
            )
        } != 0
        {
            return Ok(transferred as usize);
        }
        if unsafe { GetLastError() } != ERROR_IO_PENDING {
            return Err(io::Error::last_os_error());
        }
        wait_for_overlapped(handle, &overlapped, &event, timeout)
            .map(|transferred| transferred as usize)
    }

    fn overlapped_write(handle: HANDLE, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let length = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        let (event, mut overlapped) = new_overlapped()?;
        let mut transferred = 0_u32;
        // SAFETY: `handle` is a live overlapped pipe. `buffer`, `overlapped`,
        // and the event remain live until the operation completes.
        if unsafe {
            WriteFile(
                handle,
                buffer.as_ptr(),
                length,
                &raw mut transferred,
                &raw mut overlapped,
            )
        } != 0
        {
            return Ok(transferred as usize);
        }
        if unsafe { GetLastError() } != ERROR_IO_PENDING {
            return Err(io::Error::last_os_error());
        }
        wait_for_overlapped(handle, &overlapped, &event, None)
            .map(|transferred| transferred as usize)
    }

    fn new_overlapped() -> io::Result<(OwnedHandle, OVERLAPPED)> {
        // SAFETY: this creates an unnamed, manual-reset event with no security
        // descriptor. The returned unique HANDLE is owned below.
        let event = OwnedHandle(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) });
        if event.0.is_null() {
            return Err(io::Error::last_os_error());
        }
        let overlapped = OVERLAPPED {
            hEvent: event.0,
            ..OVERLAPPED::default()
        };
        Ok((event, overlapped))
    }

    fn wait_for_overlapped(
        handle: HANDLE,
        overlapped: &OVERLAPPED,
        event: &OwnedHandle,
        timeout: Option<Duration>,
    ) -> io::Result<u32> {
        let wait_milliseconds = wait_milliseconds(timeout)?;
        // SAFETY: `event` remains a live synchronization handle for this
        // operation throughout the wait.
        match unsafe { WaitForSingleObject(event.0, wait_milliseconds) } {
            WAIT_OBJECT_0 => overlapped_result(handle, overlapped),
            WAIT_TIMEOUT => {
                cancel_and_reap(handle, overlapped);
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Control pipe read timed out",
                ))
            }
            _ => {
                let error = io::Error::last_os_error();
                cancel_and_reap(handle, overlapped);
                Err(error)
            }
        }
    }

    fn overlapped_result(handle: HANDLE, overlapped: &OVERLAPPED) -> io::Result<u32> {
        let mut transferred = 0_u32;
        // SAFETY: the operation event has signalled, and `overlapped` remains
        // live while Windows publishes its final byte count.
        if unsafe { GetOverlappedResult(handle, overlapped, &raw mut transferred, 0) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(transferred)
        }
    }

    fn cancel_and_reap(handle: HANDLE, overlapped: &OVERLAPPED) {
        // SAFETY: the operation and its OVERLAPPED are still live. Cancellation
        // is best-effort because the I/O may have completed at the timeout
        // boundary; the blocking result call then guarantees that Windows no
        // longer references the stack OVERLAPPED or caller buffer.
        unsafe {
            CancelIoEx(handle, overlapped);
            let mut transferred = 0_u32;
            GetOverlappedResult(handle, overlapped, &raw mut transferred, 1);
        }
    }

    fn wait_milliseconds(timeout: Option<Duration>) -> io::Result<u32> {
        let Some(timeout) = timeout else {
            return Ok(INFINITE);
        };
        if timeout.is_zero() {
            return Ok(0);
        }
        let milliseconds = u32::try_from(timeout.as_millis().max(1)).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "read timeout is too large")
        })?;
        if milliseconds == INFINITE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "read timeout is too large",
            ));
        }
        Ok(milliseconds)
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

    #[cfg(test)]
    mod tests {
        use std::{
            io::{Read as _, Write as _},
            sync::{
                Arc, Barrier,
                atomic::{AtomicU64, Ordering},
            },
            time::Duration,
        };

        use super::{WindowsControlEndpoint, WindowsEndpointClaim, process_user_sid};

        #[test]
        fn same_user_connection_supports_concurrent_reads_and_writes_after_authorization() {
            let endpoint = test_endpoint();
            let WindowsEndpointClaim::Owner(owner) = endpoint
                .claim_or_connect(Duration::ZERO)
                .expect("first claimant should own the test endpoint")
            else {
                panic!("first claimant unexpectedly connected to an existing endpoint");
            };
            let client_endpoint = endpoint.clone();
            let client = std::thread::spawn(move || {
                let WindowsEndpointClaim::Existing(mut connection) = client_endpoint
                    .claim_or_connect(Duration::from_secs(1))
                    .expect("same-user client should connect to the test endpoint")
                else {
                    panic!("same-user client unexpectedly owned the test endpoint");
                };
                connection
                    .write_all(b"hello")
                    .expect("same-user client bytes should be written");
                connection.set_read_timeout(Some(Duration::from_secs(1)));
                let mut reply = [0_u8; 5];
                connection
                    .read_exact(&mut reply)
                    .expect("authorized server reply should be readable");
                connection
                    .write_all(b"again")
                    .expect("client should write while the server read is pending");
                reply
            });

            let mut connection = owner
                .accept_current_user()
                .expect("same-user connection should be authorized");
            let mut bytes = [0_u8; 5];
            connection
                .read_exact(&mut bytes)
                .expect("authorized client bytes should be readable");

            assert_eq!(&bytes, b"hello");
            let mut writer = connection
                .try_clone()
                .expect("authorized connection should be cloneable for writing");
            let reader_started = Arc::new(Barrier::new(2));
            let reader_barrier = Arc::clone(&reader_started);
            let reader = std::thread::spawn(move || {
                let mut connection = connection;
                let mut next = [0_u8; 5];
                reader_barrier.wait();
                connection
                    .read_exact(&mut next)
                    .expect("next client bytes should be readable");
                next
            });
            reader_started.wait();
            std::thread::sleep(Duration::from_millis(50));
            writer
                .write_all(b"world")
                .expect("server should write while its read is pending");
            assert_eq!(
                client.join().expect("same-user client should finish"),
                *b"world"
            );
            assert_eq!(
                reader.join().expect("server reader should finish"),
                *b"again"
            );
        }

        fn test_endpoint() -> WindowsControlEndpoint {
            static NEXT_ID: AtomicU64 = AtomicU64::new(1);
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let process_id = std::process::id();
            WindowsControlEndpoint {
                pipe_name: format!(r"\\.\pipe\debrute-control-test-{process_id}-{id}"),
                mutex_name: format!(r"Local\DebruteRuntimeTest-{process_id}-{id}"),
                current_user_sid: process_user_sid()
                    .expect("current test user SID should be available"),
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub use windows::{
    WindowsControlConnection, WindowsControlEndpoint, WindowsControlOwner, WindowsEndpointClaim,
};
