//! Narrow macOS process-group and Windows Job Object ownership primitives.
//!
//! macOS has no Job Object equivalent. Runtime-owned children start in a fresh
//! process group, matching Codex's local PTY/worker boundary. A child that
//! deliberately creates a new session leaves that ownership boundary. Identity-
//! checked descendant observation prevents stale PID reuse and improves cleanup,
//! but is not presented as containment because it cannot close the fork/reparent
//! race.

use std::{
    io,
    process::{Child, Command},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipeReadiness {
    Ready,
    Pending,
    Closed,
}

#[cfg(target_os = "macos")]
/// Configures a worker output pipe for cancellable nonblocking reads.
///
/// # Errors
/// Returns an operating-system error when the pipe flags cannot be read or changed.
pub fn configure_output_pipe(reader: &impl std::os::fd::AsRawFd) -> io::Result<()> {
    let descriptor = reader.as_raw_fd();
    // SAFETY: `descriptor` is a live pipe descriptor and F_GETFL/F_SETFL do
    // not take ownership of it.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
/// Reports that a configured nonblocking macOS pipe may be read.
///
/// # Errors
/// This macOS implementation is infallible; the result shape is cross-platform.
pub fn output_pipe_readiness(_reader: &impl std::os::fd::AsRawFd) -> io::Result<PipeReadiness> {
    Ok(PipeReadiness::Ready)
}

#[cfg(target_os = "windows")]
pub fn configure_output_pipe(_reader: &impl std::os::windows::io::AsRawHandle) -> io::Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn output_pipe_readiness(
    reader: &impl std::os::windows::io::AsRawHandle,
) -> io::Result<PipeReadiness> {
    use windows_sys::Win32::{
        Foundation::{ERROR_BROKEN_PIPE, ERROR_NO_DATA, HANDLE},
        System::Pipes::PeekNamedPipe,
    };

    let mut available = 0_u32;
    let handle = reader.as_raw_handle().cast::<core::ffi::c_void>() as HANDLE;
    // SAFETY: `handle` is a live anonymous-pipe read handle and only the
    // available-byte count is requested.
    if unsafe {
        PeekNamedPipe(
            handle,
            core::ptr::null_mut(),
            0,
            core::ptr::null_mut(),
            &raw mut available,
            core::ptr::null_mut(),
        )
    } == 0
    {
        let error = io::Error::last_os_error();
        return match error.raw_os_error().map(|code| code.cast_unsigned()) {
            Some(ERROR_BROKEN_PIPE | ERROR_NO_DATA) => Ok(PipeReadiness::Closed),
            _ => Err(error),
        };
    }
    Ok(if available == 0 {
        PipeReadiness::Pending
    } else {
        PipeReadiness::Ready
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn configure_output_pipe(_reader: &impl std::os::fd::AsRawFd) -> io::Result<()> {
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn output_pipe_readiness(_reader: &impl std::os::fd::AsRawFd) -> io::Result<PipeReadiness> {
    Ok(PipeReadiness::Ready)
}

#[cfg(target_os = "macos")]
pub fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt as _;

    command.process_group(0);
}

#[cfg(target_os = "windows")]
pub fn configure_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;
    use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED};

    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
}

/// Linux is a best-effort distribution target and has no worker-tree contract.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn configure_process_group(_command: &mut Command) {}

pub struct ChildProcessTree {
    #[cfg(target_os = "macos")]
    mac: MacProcessTree,
    #[cfg(target_os = "windows")]
    job: isize,
}

#[cfg(target_os = "macos")]
struct MacProcessTree {
    process_group: i32,
    root_identity: (u64, u64),
    tracked: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<i32, (u64, u64)>>>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    monitor: Option<std::thread::JoinHandle<()>>,
}

impl ChildProcessTree {
    /// Attaches the freshly spawned child to its Runtime-owned process group.
    ///
    /// # Errors
    /// Returns an operating-system error when tree ownership cannot be established.
    #[cfg(target_os = "macos")]
    pub fn attach(child: &Child) -> io::Result<Self> {
        Self::attach_process_id(child.id())
    }

    /// Owns a freshly spawned PTY session leader as its macOS process group.
    ///
    /// # Errors
    /// Returns an error when the identifier is outside the macOS pid range.
    #[cfg(target_os = "macos")]
    pub fn attach_process_id(process_id: u32) -> io::Result<Self> {
        let process_group = i32::try_from(process_id)
            .map_err(|_| io::Error::other("child process id exceeds macOS pid range"))?;
        let root_identity = process_identity(process_group)?;
        let tracked = std::sync::Arc::new(std::sync::Mutex::new(
            [(process_group, root_identity)].into_iter().collect(),
        ));
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let monitor_tracked = std::sync::Arc::clone(&tracked);
        let monitor_stop = std::sync::Arc::clone(&stop);
        let monitor = std::thread::Builder::new()
            .name(format!("debrute-process-group-{process_group}"))
            .spawn(move || {
                while !monitor_stop.load(std::sync::atomic::Ordering::Acquire) {
                    refresh_descendant_set(&monitor_tracked);
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                refresh_descendant_set(&monitor_tracked);
            })?;
        Ok(Self {
            mac: MacProcessTree {
                process_group,
                root_identity,
                tracked,
                stop,
                monitor: Some(monitor),
            },
        })
    }

    /// Attaches the freshly spawned child to a kill-on-close Windows Job Object.
    ///
    /// # Errors
    /// Returns an operating-system error when Job Object creation or assignment fails.
    #[cfg(target_os = "windows")]
    pub fn attach(child: &Child) -> io::Result<Self> {
        use std::os::windows::io::AsRawHandle as _;

        let tree = Self::attach_raw_handle(child.as_raw_handle())?;
        if let Err(error) = resume_process(child.as_raw_handle()) {
            let _ = tree.force_kill();
            return Err(error);
        }
        Ok(tree)
    }

    /// Attaches a freshly spawned PTY child to a kill-on-close Windows Job Object.
    ///
    /// # Errors
    /// Returns an operating-system error when Job Object creation or assignment fails.
    #[cfg(target_os = "windows")]
    pub fn attach_raw_handle(child: std::os::windows::io::RawHandle) -> io::Result<Self> {
        use windows_sys::Win32::{
            Foundation::HANDLE,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
        };

        // SAFETY: null attributes/name request an unnamed Job Object owned by this process.
        let job = unsafe { CreateJobObjectW(core::ptr::null(), core::ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let information_size = u32::try_from(core::mem::size_of_val(&information))
            .map_err(|_| io::Error::other("Job Object information size exceeds u32"))?;
        // SAFETY: `job` is live and `information` has the exact class-specific layout/size.
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw const information).cast(),
                information_size,
            )
        };
        if configured == 0 {
            let error = io::Error::last_os_error();
            // SAFETY: `job` is a live owned handle and is not used after this close.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return Err(error);
        }
        let process = child.cast::<core::ffi::c_void>() as HANDLE;
        // SAFETY: both handles are live for the duration of the assignment call.
        if unsafe { AssignProcessToJobObject(job, process) } == 0 {
            let error = io::Error::last_os_error();
            // SAFETY: `job` is a live owned handle and is not used after this close.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return Err(error);
        }
        Ok(Self { job: job as isize })
    }

    /// Linux is a best-effort distribution target and has no worker-tree contract.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub fn attach(_child: &Child) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "process-tree ownership is unsupported on this distribution target",
        ))
    }

    /// Requests owned process-group or Job Object termination.
    ///
    /// # Errors
    /// Returns an operating-system error other than an already-exited tree.
    #[cfg(target_os = "macos")]
    pub fn terminate(&self) -> io::Result<()> {
        signal_mac_owned_processes(&self.mac, libc::SIGTERM)
    }

    /// Windows Job Objects expose one reliable whole-tree termination primitive.
    ///
    /// # Errors
    /// Returns an operating-system error when the Job Object cannot be terminated.
    #[cfg(target_os = "windows")]
    pub fn terminate(&self) -> io::Result<()> {
        self.force_kill()
    }

    /// Linux is a best-effort distribution target and has no worker-tree contract.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub fn terminate(&self) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "unsupported process tree",
        ))
    }

    /// Force-kills the owned macOS process group.
    ///
    /// # Errors
    /// Returns an operating-system error other than an already-exited tree.
    #[cfg(target_os = "macos")]
    pub fn force_kill(&self) -> io::Result<()> {
        signal_mac_owned_processes(&self.mac, libc::SIGKILL)
    }

    /// Force-kills the complete owned Windows Job Object.
    ///
    /// # Errors
    /// Returns an operating-system error when termination fails.
    #[cfg(target_os = "windows")]
    pub fn force_kill(&self) -> io::Result<()> {
        let job = self.job as windows_sys::Win32::Foundation::HANDLE;
        // SAFETY: `self.job` is a live owned Job Object handle.
        if unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(job, 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// Linux is a best-effort distribution target and has no worker-tree contract.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub fn force_kill(&self) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "unsupported process tree",
        ))
    }
}

#[cfg(target_os = "windows")]
fn resume_process(process: std::os::windows::io::RawHandle) -> io::Result<()> {
    use windows_sys::Win32::Foundation::HANDLE;

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtResumeProcess(process_handle: HANDLE) -> i32;
    }

    // SAFETY: `process` is the live handle of a child created with CREATE_SUSPENDED.
    let status = unsafe { NtResumeProcess(process.cast::<core::ffi::c_void>() as HANDLE) };
    if status < 0 {
        Err(io::Error::other(format!(
            "NtResumeProcess failed with NTSTATUS 0x{:08X}",
            status.cast_unsigned()
        )))
    } else {
        Ok(())
    }
}

/// A named Windows event that keeps the ConPTY bootstrap from spawning its
/// shell until the bootstrap process belongs to its kill-on-close Job Object.
#[cfg(target_os = "windows")]
pub struct WindowsSpawnBarrier {
    handle: isize,
    name: String,
}

#[cfg(target_os = "windows")]
impl WindowsSpawnBarrier {
    /// Creates one private, initially closed spawn barrier.
    ///
    /// # Errors
    /// Returns an operating-system error when the event cannot be created.
    pub fn new() -> io::Result<Self> {
        use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
        use windows_sys::Win32::System::Threading::CreateEventW;

        let name = format!(
            "Local\\DebruteTerminalSpawn-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        );
        let encoded = windows_string(&name)?;
        // SAFETY: null security attributes request the caller's default ACL and
        // `encoded` is a live NUL-terminated UTF-16 event name.
        let handle = unsafe { CreateEventW(core::ptr::null(), 1, 0, encoded.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: GetLastError reads the calling thread's status immediately after
        // CreateEventW and does not access the returned handle.
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            // SAFETY: `handle` is the live handle returned by CreateEventW.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "terminal spawn barrier name was already claimed",
            ));
        }
        Ok(Self {
            handle: handle as isize,
            name,
        })
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Releases the waiting bootstrap exactly after Job assignment.
    ///
    /// # Errors
    /// Returns an operating-system error when the event cannot be signalled.
    pub fn release(&self) -> io::Result<()> {
        let handle = self.handle as windows_sys::Win32::Foundation::HANDLE;
        // SAFETY: `handle` is the live event owned by this barrier.
        if unsafe { windows_sys::Win32::System::Threading::SetEvent(handle) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

/// Waits for the named ConPTY spawn barrier created by the Runtime.
///
/// # Errors
/// Returns an operating-system error for an invalid event or wait failure.
#[cfg(target_os = "windows")]
pub fn wait_for_windows_spawn_barrier(name: &str) -> io::Result<()> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{OpenEventW, SYNCHRONIZATION_SYNCHRONIZE, WaitForSingleObject},
    };

    let encoded = windows_string(name)?;
    // SAFETY: `encoded` is a live NUL-terminated UTF-16 name and the returned
    // handle, when non-null, is closed below.
    let handle = unsafe { OpenEventW(SYNCHRONIZATION_SYNCHRONIZE, 0, encoded.as_ptr()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `handle` is a live event handle for the duration of the wait.
    let result = unsafe { WaitForSingleObject(handle, 15_000) };
    // SAFETY: `handle` is owned by this function and not used after close.
    unsafe { CloseHandle(handle) };
    match result {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "terminal spawn barrier timed out before Job assignment",
        )),
        WAIT_FAILED => Err(io::Error::last_os_error()),
        value => Err(io::Error::other(format!(
            "unexpected spawn-barrier wait result: {value}"
        ))),
    }
}

#[cfg(target_os = "windows")]
fn windows_string(value: &str) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt as _;

    let mut encoded = std::ffi::OsStr::new(value)
        .encode_wide()
        .collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows object name contains NUL",
        ));
    }
    encoded.push(0);
    Ok(encoded)
}

#[cfg(target_os = "windows")]
impl Drop for WindowsSpawnBarrier {
    fn drop(&mut self) {
        let handle = self.handle as windows_sys::Win32::Foundation::HANDLE;
        // SAFETY: this value owns the event handle and closes it exactly once.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
    }
}

#[cfg(target_os = "macos")]
fn signal_group(process_group: i32, signal: i32) -> io::Result<()> {
    // SAFETY: a negative pid targets the process group created for this child.
    let result = unsafe { libc::kill(-process_group, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(target_os = "macos")]
fn signal_mac_owned_processes(tree: &MacProcessTree, signal: i32) -> io::Result<()> {
    refresh_descendant_set(&tree.tracked);
    let mut first_error = None;
    if process_identity(tree.process_group).ok().as_ref() == Some(&tree.root_identity) {
        first_error = signal_group(tree.process_group, signal).err();
    }
    refresh_descendant_set(&tree.tracked);
    let tracked = tree
        .tracked
        .lock()
        .map_err(|_| io::Error::other("macOS process ownership state is poisoned"))?
        .iter()
        .filter_map(|(process_id, identity)| {
            (process_identity(*process_id).ok().as_ref() == Some(identity))
                .then_some((*process_id, *identity))
        })
        .collect::<Vec<_>>();
    for (process_id, identity) in tracked.into_iter().rev() {
        if process_identity(process_id).ok().as_ref() != Some(&identity) {
            continue;
        }
        if let Err(error) = signal_process(process_id, signal)
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[cfg(target_os = "macos")]
fn signal_process(process_id: i32, signal: i32) -> io::Result<()> {
    // SAFETY: a positive pid targets one identity-checked owned process.
    if unsafe { libc::kill(process_id, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(target_os = "macos")]
fn refresh_descendant_set(
    tracked: &std::sync::Arc<std::sync::Mutex<std::collections::HashMap<i32, (u64, u64)>>>,
) {
    let roots = match tracked.lock() {
        Ok(mut tracked) => {
            tracked.retain(|process_id, identity| {
                process_identity(*process_id).ok().as_ref() == Some(identity)
            });
            tracked
                .iter()
                .map(|(process_id, identity)| (*process_id, *identity))
                .collect::<Vec<_>>()
        }
        Err(_) => return,
    };
    let mut discovered = std::collections::HashMap::new();
    let mut pending = roots;
    while let Some((parent, parent_identity)) = pending.pop() {
        if process_identity(parent).ok().as_ref() != Some(&parent_identity) {
            continue;
        }
        let children = child_processes(parent);
        if process_identity(parent).ok().as_ref() != Some(&parent_identity) {
            continue;
        }
        for child in children {
            if discovered.contains_key(&child) {
                continue;
            }
            if let Ok(record) = process_record(child)
                && record.parent == parent
            {
                discovered.insert(child, record.identity);
                pending.push((child, record.identity));
            }
        }
    }
    discovered.retain(|process_id, identity| {
        process_identity(*process_id).ok().as_ref() == Some(identity)
    });
    if let Ok(mut tracked) = tracked.lock() {
        tracked.extend(discovered);
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct MacBsdInfo {
    pbi_flags: u32,
    pbi_status: u32,
    pbi_xstatus: u32,
    pbi_pid: u32,
    pbi_ppid: u32,
    pbi_uid: u32,
    pbi_gid: u32,
    pbi_ruid: u32,
    pbi_rgid: u32,
    pbi_svuid: u32,
    pbi_svgid: u32,
    rfu_1: u32,
    pbi_comm: [i8; 16],
    pbi_name: [i8; 32],
    pbi_nfiles: u32,
    pbi_pgid: u32,
    pbi_pjobc: u32,
    e_tdev: u32,
    e_tpgid: u32,
    pbi_nice: i32,
    pbi_start_tvsec: u64,
    pbi_start_tvusec: u64,
}

#[cfg(target_os = "macos")]
struct MacProcessRecord {
    identity: (u64, u64),
    parent: i32,
}

#[cfg(target_os = "macos")]
fn process_identity(process_id: i32) -> io::Result<(u64, u64)> {
    process_record(process_id).map(|record| record.identity)
}

#[cfg(target_os = "macos")]
fn process_record(process_id: i32) -> io::Result<MacProcessRecord> {
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut libc::c_void,
            size: i32,
        ) -> i32;
    }

    const PROC_PIDTBSDINFO: i32 = 3;
    let mut information = core::mem::MaybeUninit::<MacBsdInfo>::uninit();
    let size = i32::try_from(core::mem::size_of::<MacBsdInfo>())
        .map_err(|_| io::Error::other("macOS process identity structure is too large"))?;
    // SAFETY: libproc initializes at most `size` bytes and returns the byte count.
    let returned = unsafe {
        proc_pidinfo(
            process_id,
            PROC_PIDTBSDINFO,
            0,
            information.as_mut_ptr().cast(),
            size,
        )
    };
    if returned != size {
        return Err(if returned == 0 {
            io::Error::last_os_error()
        } else {
            io::Error::other("macOS process identity was truncated")
        });
    }
    // SAFETY: libproc reported the exact initialized structure size.
    let information = unsafe { information.assume_init() };
    let parent = i32::try_from(information.pbi_ppid)
        .map_err(|_| io::Error::other("macOS parent process id exceeds i32"))?;
    Ok(MacProcessRecord {
        identity: (information.pbi_start_tvsec, information.pbi_start_tvusec),
        parent,
    })
}

#[cfg(target_os = "macos")]
fn child_processes(parent: i32) -> Vec<i32> {
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_listchildpids(ppid: libc::pid_t, buffer: *mut libc::c_void, size: i32) -> i32;
    }

    let mut children = vec![0_i32; 1024];
    let Ok(bytes) = i32::try_from(children.len() * core::mem::size_of::<i32>()) else {
        return Vec::new();
    };
    // SAFETY: the buffer is writable for `bytes`; libproc does not retain it.
    let returned = unsafe { proc_listchildpids(parent, children.as_mut_ptr().cast(), bytes) };
    if returned <= 0 {
        return Vec::new();
    }
    let count = usize::try_from(returned)
        .unwrap_or_default()
        .min(children.len());
    children.truncate(count);
    children.retain(|process_id| *process_id > 0);
    children
}

#[cfg(target_os = "windows")]
impl Drop for ChildProcessTree {
    fn drop(&mut self) {
        let job = self.job as windows_sys::Win32::Foundation::HANDLE;
        // SAFETY: `self.job` is owned by this value and closed exactly once here.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
    }
}

#[cfg(target_os = "macos")]
impl Drop for ChildProcessTree {
    fn drop(&mut self) {
        self.mac
            .stop
            .store(true, std::sync::atomic::Ordering::Release);
        if let Some(monitor) = self.mac.monitor.take() {
            let _ = monitor.join();
        }
        let _ = self.force_kill();
    }
}
