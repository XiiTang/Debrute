//! Platform Start-at-Login registration.

use std::{
    error::Error,
    fmt, io,
    path::{Path, PathBuf},
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
    NonUtf8Path,
    InvalidWindowsCommandPath,
    InvalidStableEntrypoint,
}

impl fmt::Display for LoginItemError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            #[cfg(target_os = "macos")]
            Self::MissingParent => formatter.write_str("Login item path has no parent."),
            Self::NonUtf8Path => formatter.write_str("Login Runtime path is not valid Unicode."),
            Self::InvalidWindowsCommandPath => {
                formatter.write_str("Login Runtime path is not safe for a Windows startup command.")
            }
            Self::InvalidStableEntrypoint => {
                formatter.write_str("Stable Runtime entrypoint must be an absolute path.")
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
            Self::NonUtf8Path | Self::InvalidWindowsCommandPath | Self::InvalidStableEntrypoint => {
                None
            }
        }
    }
}
