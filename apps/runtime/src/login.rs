//! Platform Start-at-Login registration.

use std::{
    error::Error,
    fmt, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use uuid::Uuid;

#[cfg(target_os = "macos")]
const MACOS_LAUNCH_AGENT_NAME: &str = "com.debrute.runtime.plist";
#[cfg(target_os = "windows")]
const WINDOWS_RUN_VALUE_NAME: &str = "Debrute Runtime";

/// Validates the stable Runtime path supplied by a launcher.
///
/// # Errors
///
/// Returns [`LoginItemError`] when the path is not absolute.
pub fn require_stable_runtime_entrypoint(path: PathBuf) -> Result<PathBuf, LoginItemError> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(LoginItemError::InvalidStableEntrypoint)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StartAtLoginSnapshot {
    pub revision: u64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartAtLoginMutationResult {
    pub snapshot: StartAtLoginSnapshot,
    pub changed: bool,
}

pub trait StartAtLoginSetting: Send + Sync {
    fn snapshot(&self) -> StartAtLoginSnapshot;

    /// Applies the requested native login registration and confirms its exact state.
    ///
    /// # Errors
    ///
    /// Returns [`LoginItemError`] when the native state cannot be read or changed.
    fn set_enabled(&self, enabled: bool) -> Result<StartAtLoginMutationResult, LoginItemError>;

    fn install_observer(&self, observer: Arc<dyn Fn(StartAtLoginSnapshot) + Send + Sync>) -> bool;
}

#[cfg(target_os = "macos")]
pub struct MacOsLoginItem {
    path: PathBuf,
    stable_runtime: PathBuf,
}

#[cfg(target_os = "macos")]
impl MacOsLoginItem {
    #[must_use]
    pub fn new(home: impl AsRef<Path>, stable_runtime: impl AsRef<Path>) -> Self {
        Self {
            path: home
                .as_ref()
                .join("Library/LaunchAgents")
                .join(MACOS_LAUNCH_AGENT_NAME),
            stable_runtime: stable_runtime.as_ref().to_owned(),
        }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Reports whether the exact stable Runtime launch agent is installed.
    ///
    /// # Errors
    ///
    /// Returns [`LoginItemError`] when an installed file cannot be read.
    pub fn is_enabled(&self) -> Result<bool, LoginItemError> {
        match fs::read_to_string(&self.path) {
            Ok(source) => Ok(source == self.plist()?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(LoginItemError::Io(error)),
        }
    }

    /// Installs or removes the next-login `LaunchAgent` atomically.
    ///
    /// The executable has no frontend or Project arguments. It starts Runtime
    /// without opening a Workbench frontend.
    ///
    /// # Errors
    ///
    /// Returns [`LoginItemError`] for an invalid path or filesystem failure.
    pub fn set_enabled(&self, enabled: bool) -> Result<(), LoginItemError> {
        if !enabled {
            return match fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(LoginItemError::Io(error)),
            };
        }
        let directory = self.path.parent().ok_or(LoginItemError::MissingParent)?;
        fs::create_dir_all(directory).map_err(LoginItemError::Io)?;
        let temporary = self.path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let result = (|| {
            fs::write(&temporary, self.plist()?).map_err(LoginItemError::Io)?;
            set_private_file_permissions(&temporary)?;
            fs::rename(&temporary, &self.path).map_err(LoginItemError::Io)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn plist(&self) -> Result<String, LoginItemError> {
        let runtime = self
            .stable_runtime
            .to_str()
            .ok_or(LoginItemError::NonUtf8Path)?;
        let runtime = xml_escape(runtime);
        Ok(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
             \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n\
             <dict>\n\
               <key>Label</key>\n\
               <string>com.debrute.runtime</string>\n\
               <key>ProgramArguments</key>\n\
               <array><string>{runtime}</string></array>\n\
               <key>RunAtLoad</key>\n\
               <true/>\n\
               <key>KeepAlive</key>\n\
               <false/>\n\
               <key>StandardOutPath</key>\n\
               <string>/dev/null</string>\n\
               <key>StandardErrorPath</key>\n\
               <string>/dev/null</string>\n\
             </dict>\n\
             </plist>\n"
        ))
    }
}

/// Serializes the exact current-user Windows Run value.
///
/// # Errors
///
/// Returns [`LoginItemError`] when the path cannot be represented safely in the
/// one Windows startup command.
pub fn windows_run_value(stable_runtime: &Path) -> Result<String, LoginItemError> {
    let value = stable_runtime.to_str().ok_or(LoginItemError::NonUtf8Path)?;
    if value.contains('"') {
        return Err(LoginItemError::InvalidWindowsCommandPath);
    }
    Ok(format!(
        "\"{value}\" --stable-runtime-entrypoint \"{value}\""
    ))
}

#[cfg(target_os = "windows")]
pub struct WindowsLoginItem {
    stable_runtime: PathBuf,
}

#[cfg(target_os = "windows")]
impl WindowsLoginItem {
    #[must_use]
    pub fn new(stable_runtime: impl AsRef<Path>) -> Self {
        Self {
            stable_runtime: stable_runtime.as_ref().to_owned(),
        }
    }

    /// Reports whether the exact stable Runtime entrypoint owns the Run value.
    ///
    /// # Errors
    ///
    /// Returns [`LoginItemError`] for registry or path failures.
    pub fn is_enabled(&self) -> Result<bool, LoginItemError> {
        use winreg::{RegKey, enums::HKEY_CURRENT_USER};

        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        let run =
            match current_user.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run") {
                Ok(run) => run,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
                Err(error) => return Err(LoginItemError::Io(error)),
            };
        match run.get_value::<String, _>(WINDOWS_RUN_VALUE_NAME) {
            Ok(value) => Ok(value == windows_run_value(&self.stable_runtime)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(LoginItemError::Io(error)),
        }
    }

    /// Installs or removes the current-user Run value.
    ///
    /// # Errors
    ///
    /// Returns [`LoginItemError`] for registry or path failures.
    pub fn set_enabled(&self, enabled: bool) -> Result<(), LoginItemError> {
        use winreg::{RegKey, enums::HKEY_CURRENT_USER};

        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        let (run, _) = current_user
            .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
            .map_err(LoginItemError::Io)?;
        if enabled {
            run.set_value(
                WINDOWS_RUN_VALUE_NAME,
                &windows_run_value(&self.stable_runtime)?,
            )
            .map_err(LoginItemError::Io)
        } else {
            match run.delete_value(WINDOWS_RUN_VALUE_NAME) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(LoginItemError::Io(error)),
            }
        }
    }
}

trait LoginItemRegistration: Send + Sync {
    fn is_enabled(&self) -> Result<bool, LoginItemError>;
    fn set_enabled(&self, enabled: bool) -> Result<(), LoginItemError>;
}

#[cfg(target_os = "macos")]
impl LoginItemRegistration for MacOsLoginItem {
    fn is_enabled(&self) -> Result<bool, LoginItemError> {
        MacOsLoginItem::is_enabled(self)
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), LoginItemError> {
        MacOsLoginItem::set_enabled(self, enabled)
    }
}

#[cfg(target_os = "windows")]
impl LoginItemRegistration for WindowsLoginItem {
    fn is_enabled(&self) -> Result<bool, LoginItemError> {
        WindowsLoginItem::is_enabled(self)
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), LoginItemError> {
        WindowsLoginItem::set_enabled(self, enabled)
    }
}

struct StartAtLoginState {
    revision: u64,
    enabled: bool,
    observer: Option<Arc<dyn Fn(StartAtLoginSnapshot) + Send + Sync>>,
}

struct StartAtLoginService<R> {
    registration: R,
    state: Mutex<StartAtLoginState>,
}

impl<R: LoginItemRegistration> StartAtLoginService<R> {
    fn new(registration: R) -> Result<Self, LoginItemError> {
        let enabled = registration.is_enabled()?;
        Ok(Self {
            registration,
            state: Mutex::new(StartAtLoginState {
                revision: 0,
                enabled,
                observer: None,
            }),
        })
    }

    fn snapshot(&self) -> StartAtLoginSnapshot {
        let state = self.lock_state();
        StartAtLoginSnapshot {
            revision: state.revision,
            enabled: state.enabled,
        }
    }

    fn set_enabled(&self, requested: bool) -> Result<StartAtLoginMutationResult, LoginItemError> {
        let mut state = self.lock_state();
        let actual = self.registration.is_enabled()?;
        if actual != requested {
            self.registration.set_enabled(requested)?;
            let confirmed = self.registration.is_enabled()?;
            if confirmed != requested {
                return Err(LoginItemError::StateConfirmationFailed);
            }
        }
        let changed = state.enabled != requested;
        if changed {
            state.revision = state
                .revision
                .checked_add(1)
                .expect("Start at Login revision exhausted");
            state.enabled = requested;
        }
        let snapshot = StartAtLoginSnapshot {
            revision: state.revision,
            enabled: state.enabled,
        };
        let observer = changed.then(|| state.observer.clone()).flatten();
        drop(state);
        if let Some(observer) = observer {
            observer(snapshot);
        }
        Ok(StartAtLoginMutationResult { snapshot, changed })
    }

    fn install_observer(&self, observer: Arc<dyn Fn(StartAtLoginSnapshot) + Send + Sync>) -> bool {
        let mut state = self.lock_state();
        if state.observer.is_some() {
            return false;
        }
        state.observer = Some(observer);
        true
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, StartAtLoginState> {
        self.state
            .lock()
            .expect("Start at Login state lock poisoned")
    }
}

#[cfg(target_os = "macos")]
type PlatformLoginItem = MacOsLoginItem;
#[cfg(target_os = "windows")]
type PlatformLoginItem = WindowsLoginItem;

pub struct PlatformStartAtLoginSetting {
    service: StartAtLoginService<PlatformLoginItem>,
}

impl PlatformStartAtLoginSetting {
    /// Opens the current user's exact native Runtime login registration.
    ///
    /// # Errors
    ///
    /// Returns [`LoginItemError`] when the current-user registration cannot be read.
    pub fn new(stable_runtime: impl AsRef<Path>) -> Result<Self, LoginItemError> {
        #[cfg(target_os = "macos")]
        let registration = {
            let home = std::env::var_os("HOME").ok_or(LoginItemError::HomeUnavailable)?;
            MacOsLoginItem::new(home, stable_runtime)
        };
        #[cfg(target_os = "windows")]
        let registration = WindowsLoginItem::new(stable_runtime);
        Ok(Self {
            service: StartAtLoginService::new(registration)?,
        })
    }
}

impl StartAtLoginSetting for PlatformStartAtLoginSetting {
    fn snapshot(&self) -> StartAtLoginSnapshot {
        self.service.snapshot()
    }

    fn set_enabled(&self, enabled: bool) -> Result<StartAtLoginMutationResult, LoginItemError> {
        self.service.set_enabled(enabled)
    }

    fn install_observer(&self, observer: Arc<dyn Fn(StartAtLoginSnapshot) + Send + Sync>) -> bool {
        self.service.install_observer(observer)
    }
}

#[cfg(any(test, feature = "test-support"))]
struct MemoryLoginItem {
    enabled: Mutex<bool>,
}

#[cfg(any(test, feature = "test-support"))]
impl LoginItemRegistration for MemoryLoginItem {
    fn is_enabled(&self) -> Result<bool, LoginItemError> {
        Ok(*self.enabled.lock().expect("memory login item should lock"))
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), LoginItemError> {
        *self.enabled.lock().expect("memory login item should lock") = enabled;
        Ok(())
    }
}

#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub struct MemoryStartAtLoginSetting {
    service: StartAtLoginService<MemoryLoginItem>,
}

#[cfg(any(test, feature = "test-support"))]
impl MemoryStartAtLoginSetting {
    #[must_use]
    pub fn new(enabled: bool) -> Self {
        Self {
            service: StartAtLoginService::new(MemoryLoginItem {
                enabled: Mutex::new(enabled),
            })
            .expect("memory login item construction should succeed"),
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
impl StartAtLoginSetting for MemoryStartAtLoginSetting {
    fn snapshot(&self) -> StartAtLoginSnapshot {
        self.service.snapshot()
    }

    fn set_enabled(&self, enabled: bool) -> Result<StartAtLoginMutationResult, LoginItemError> {
        self.service.set_enabled(enabled)
    }

    fn install_observer(&self, observer: Arc<dyn Fn(StartAtLoginSnapshot) + Send + Sync>) -> bool {
        self.service.install_observer(observer)
    }
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn set_private_file_permissions(path: &Path) -> Result<(), LoginItemError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(LoginItemError::Io)
}

#[derive(Debug)]
pub enum LoginItemError {
    Io(io::Error),
    #[cfg(target_os = "macos")]
    MissingParent,
    HomeUnavailable,
    NonUtf8Path,
    InvalidWindowsCommandPath,
    InvalidStableEntrypoint,
    StateConfirmationFailed,
}

impl fmt::Display for LoginItemError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            #[cfg(target_os = "macos")]
            Self::MissingParent => formatter.write_str("Login item path has no parent."),
            Self::HomeUnavailable => formatter.write_str("User home is unavailable."),
            Self::NonUtf8Path => formatter.write_str("Login Runtime path is not valid Unicode."),
            Self::InvalidWindowsCommandPath => {
                formatter.write_str("Login Runtime path is not safe for a Windows startup command.")
            }
            Self::InvalidStableEntrypoint => {
                formatter.write_str("Stable Runtime entrypoint must be an absolute path.")
            }
            Self::StateConfirmationFailed => {
                formatter.write_str("Start at Login did not reach the requested native state.")
            }
        }
    }
}

impl Error for LoginItemError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            #[cfg(target_os = "macos")]
            Self::MissingParent => None,
            Self::HomeUnavailable
            | Self::NonUtf8Path
            | Self::InvalidWindowsCommandPath
            | Self::InvalidStableEntrypoint
            | Self::StateConfirmationFailed => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FallibleMemoryLoginItem {
        state: Mutex<Result<bool, &'static str>>,
    }

    impl FallibleMemoryLoginItem {
        fn enabled(enabled: bool) -> Self {
            Self {
                state: Mutex::new(Ok(enabled)),
            }
        }
    }

    impl LoginItemRegistration for FallibleMemoryLoginItem {
        fn is_enabled(&self) -> Result<bool, LoginItemError> {
            self.state
                .lock()
                .expect("memory login item should lock")
                .map_err(|message| LoginItemError::Io(io::Error::other(message)))
        }

        fn set_enabled(&self, enabled: bool) -> Result<(), LoginItemError> {
            let mut state = self.state.lock().expect("memory login item should lock");
            if state.is_err() {
                return Err(LoginItemError::Io(io::Error::other("denied")));
            }
            *state = Ok(enabled);
            Ok(())
        }
    }

    #[test]
    fn start_at_login_confirms_changes_and_notifies_one_observer() {
        let service = StartAtLoginService::new(FallibleMemoryLoginItem::enabled(false)).unwrap();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let observer_values = Arc::clone(&observed);
        assert!(service.install_observer(Arc::new(move |snapshot| {
            observer_values
                .lock()
                .expect("observer values should lock")
                .push(snapshot);
        })));
        assert!(!service.install_observer(Arc::new(|_| {})));

        let changed = service.set_enabled(true).unwrap();
        assert!(changed.changed);
        assert_eq!(changed.snapshot.revision, 1);
        assert!(changed.snapshot.enabled);
        assert_eq!(observed.lock().unwrap().as_slice(), &[changed.snapshot]);

        let repeated = service.set_enabled(true).unwrap();
        assert!(!repeated.changed);
        assert_eq!(observed.lock().unwrap().len(), 1);
    }

    #[test]
    fn failed_native_write_preserves_the_last_confirmed_state() {
        let item = FallibleMemoryLoginItem::enabled(true);
        let service = StartAtLoginService::new(item).unwrap();
        *service.registration.state.lock().unwrap() = Err("denied");

        assert!(service.set_enabled(false).is_err());
        assert_eq!(
            service.snapshot(),
            StartAtLoginSnapshot {
                revision: 0,
                enabled: true,
            }
        );
    }
}
