use std::{
    error::Error,
    fmt, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
};

#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use uuid::Uuid;

#[cfg(target_os = "macos")]
use nix::fcntl::{FcntlArg, FdFlag, fcntl};
#[cfg(target_os = "macos")]
use std::os::fd::AsRawFd as _;

use super::{
    DesktopHostRegistration, InstalledDesktopIdentity, ProductCommitError, ProductStore,
    ResumeIntent, RunningProductIdentity, UpdatePlatformAdapter, VerifiedDesktopInstaller,
    VerifiedRuntimeEntrypoint, commit::sealed,
};

const ACTIVE_PRODUCT_DIRECTORY_ENV: &str = "DEBRUTE_ACTIVE_PRODUCT_DIR";
const WEB_ASSETS_DIRECTORY_ENV: &str = "DEBRUTE_RUNTIME_WEB_ASSETS_DIR";

type ResumeHandler =
    Arc<dyn Fn(&str, &ResumeIntent) -> Result<(), ProductCommitError> + Send + Sync>;

#[derive(Clone)]
pub struct NativeUpdatePlatform {
    store: Arc<ProductStore>,
    running: RunningProductIdentity,
    desktop: DesktopHostRegistration,
    resume: ResumeHandler,
}

impl NativeUpdatePlatform {
    /// Creates the platform boundary for one exact running Runtime product.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] if the running version cannot be
    /// revalidated from the immutable Product store.
    pub fn for_runtime(
        store: Arc<ProductStore>,
        running_version: &str,
        desktop: DesktopHostRegistration,
        resume: ResumeHandler,
    ) -> Result<Self, ProductCommitError> {
        let identity = store.product_identity(running_version)?;
        Ok(Self {
            store,
            running: RunningProductIdentity::Runtime(identity),
            desktop,
            resume,
        })
    }

    /// Creates the recovery boundary for an exact Desktop-carried target seed.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] if the seed identity cannot be validated.
    pub fn for_desktop_seed(
        store: Arc<ProductStore>,
        seed: &Path,
        desktop: DesktopHostRegistration,
        resume: ResumeHandler,
    ) -> Result<Self, ProductCommitError> {
        let identity = store.inspect_seed_identity(seed)?;
        Ok(Self {
            store,
            running: RunningProductIdentity::DesktopSeed(identity),
            desktop,
            resume,
        })
    }

    fn installed_seed(&self) -> Result<PathBuf, ProductCommitError> {
        installed_product_seed(&self.desktop.executable).ok_or_else(|| {
            ProductCommitError::Platform(format!(
                "Desktop executable is outside the packaged layout: {}",
                self.desktop.executable.display()
            ))
        })
    }
}

impl sealed::Sealed for NativeUpdatePlatform {}

impl UpdatePlatformAdapter for NativeUpdatePlatform {
    fn install_desktop(
        &self,
        installer: VerifiedDesktopInstaller,
    ) -> Result<(), ProductCommitError> {
        install_desktop_native(&self.store, &self.desktop, &installer)
            .map_err(|error| ProductCommitError::Platform(error.to_string()))
    }

    fn installed_desktop_identity(&self) -> Result<InstalledDesktopIdentity, ProductCommitError> {
        let identity = self
            .store
            .inspect_seed_identity_unlocked(&self.installed_seed()?)?;
        Ok(InstalledDesktopIdentity::new(identity))
    }

    fn running_product_identity(&self) -> Result<RunningProductIdentity, ProductCommitError> {
        Ok(self.running.clone())
    }

    fn launch_runtime(
        &self,
        product_version: &str,
        entrypoint: VerifiedRuntimeEntrypoint,
    ) -> Result<(), ProductCommitError> {
        let directory = self.store.version_path(product_version);
        let mut command = Command::new(entrypoint.path());
        command
            .arg("complete-product-update")
            .arg("--product-version")
            .arg(product_version)
            .env(ACTIVE_PRODUCT_DIRECTORY_ENV, &directory)
            .env(WEB_ASSETS_DIRECTORY_ENV, directory.join("web"))
            .env("DEBRUTE_COMPLETE_PRODUCT_UPDATE", product_version)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| ProductCommitError::Platform(error.to_string()))
    }

    fn resume(
        &self,
        transaction_id: &str,
        intent: &ResumeIntent,
    ) -> Result<(), ProductCommitError> {
        if !self.store.claim_resume(transaction_id, intent)? {
            return Ok(());
        }
        (self.resume)(transaction_id, intent)
    }
}

#[cfg(target_os = "macos")]
fn installed_product_seed(executable: &Path) -> Option<PathBuf> {
    let application = executable.ancestors().find(|ancestor| {
        ancestor
            .extension()
            .is_some_and(|extension| extension == "app")
    })?;
    Some(application.join("Contents/Resources/product-seed"))
}

#[cfg(target_os = "windows")]
fn installed_product_seed(executable: &Path) -> Option<PathBuf> {
    executable
        .parent()
        .map(|directory| directory.join("resources/product-seed"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn installed_product_seed(_executable: &Path) -> Option<PathBuf> {
    None
}

#[cfg(target_os = "macos")]
fn install_desktop_native(
    store: &ProductStore,
    desktop: &DesktopHostRegistration,
    installer: &VerifiedDesktopInstaller,
) -> Result<(), NativeInstallError> {
    let attach = with_inherited_file_path(installer.file(), |installer_path| {
        command_output(
            "/usr/bin/hdiutil",
            &["attach", "-nobrowse", "-readonly", installer_path],
        )
    })?;
    let mount = attach
        .lines()
        .filter_map(|line| line.split('\t').next_back().map(str::trim))
        .find(|field| field.starts_with("/Volumes/"))
        .map(PathBuf::from)
        .ok_or(NativeInstallError::InvalidDmgMount)?;
    let result = (|| {
        let applications = fs::read_dir(&mount)?
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_ok_and(|kind| kind.is_dir())
                    && entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "app")
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        let [source_application] = applications.as_slice() else {
            return Err(NativeInstallError::InvalidApplicationInventory);
        };
        let info = source_application.join("Contents/Info.plist");
        let bundle_id = command_output(
            "/usr/bin/plutil",
            &["-extract", "CFBundleIdentifier", "raw", path_text(&info)?],
        )?;
        if bundle_id.trim() != "io.github.xiitang.debrute" {
            return Err(NativeInstallError::BundleIdentifier(
                bundle_id.trim().to_owned(),
            ));
        }
        command_success(
            "/usr/bin/codesign",
            &[
                "--verify",
                "--deep",
                "--strict",
                "--verbose=2",
                path_text(source_application)?,
            ],
        )?;
        command_success(
            "/usr/sbin/spctl",
            &["-a", "-t", "exec", "-vv", path_text(source_application)?],
        )?;
        command_success(
            "/usr/bin/xcrun",
            &["stapler", "validate", path_text(source_application)?],
        )?;
        store.inspect_seed_identity_unlocked(
            &source_application.join("Contents/Resources/product-seed"),
        )?;

        let destination = desktop
            .executable
            .ancestors()
            .find(|ancestor| {
                ancestor
                    .extension()
                    .is_some_and(|extension| extension == "app")
            })
            .ok_or(NativeInstallError::InvalidInstalledApplication)?;
        let parent = destination
            .parent()
            .ok_or(NativeInstallError::InvalidInstalledApplication)?;
        let staged = parent.join(format!(".Debrute-update-{}.app", Uuid::new_v4()));
        let retired = parent.join(format!(".Debrute-retired-{}.app", Uuid::new_v4()));
        command_success(
            "/usr/bin/ditto",
            &[path_text(source_application)?, path_text(&staged)?],
        )?;
        store.inspect_seed_identity_unlocked(&staged.join("Contents/Resources/product-seed"))?;
        command_success(
            "/usr/bin/codesign",
            &[
                "--verify",
                "--deep",
                "--strict",
                "--verbose=2",
                path_text(&staged)?,
            ],
        )?;
        fs::rename(destination, &retired)?;
        if let Err(error) = fs::rename(&staged, destination) {
            let _ = fs::rename(&retired, destination);
            let _ = fs::remove_dir_all(&staged);
            return Err(error.into());
        }
        fs::remove_dir_all(retired)?;
        Ok(())
    })();
    let detach = command_success("/usr/bin/hdiutil", &["detach", path_text(&mount)?]);
    result.and(detach)
}

#[cfg(target_os = "macos")]
fn with_inherited_file_path<T>(
    file: &fs::File,
    use_path: impl FnOnce(&str) -> Result<T, NativeInstallError>,
) -> Result<T, NativeInstallError> {
    let original = FdFlag::from_bits_retain(fcntl(file, FcntlArg::F_GETFD)?);
    let mut inherited = original;
    inherited.remove(FdFlag::FD_CLOEXEC);
    fcntl(file, FcntlArg::F_SETFD(inherited))?;
    let path = format!("/dev/fd/{}", file.as_raw_fd());
    let result = use_path(&path);
    let restore = fcntl(file, FcntlArg::F_SETFD(original))
        .map(|_| ())
        .map_err(|error| NativeInstallError::Io(error.into()));
    match (result, restore) {
        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

#[cfg(target_os = "windows")]
fn install_desktop_native(
    _store: &ProductStore,
    _desktop: &DesktopHostRegistration,
    installer: &VerifiedDesktopInstaller,
) -> Result<(), NativeInstallError> {
    command_success(path_text(installer.path())?, &["/S"])
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn install_desktop_native(
    _store: &ProductStore,
    _desktop: &DesktopHostRegistration,
    _installer: &VerifiedDesktopInstaller,
) -> Result<(), NativeInstallError> {
    Err(NativeInstallError::UnsupportedPlatform)
}

fn command_success(executable: &str, arguments: &[&str]) -> Result<(), NativeInstallError> {
    let output = Command::new(executable).args(arguments).output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(NativeInstallError::CommandFailed {
            executable: executable.to_owned(),
            status: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

#[cfg(target_os = "macos")]
fn command_output(executable: &str, arguments: &[&str]) -> Result<String, NativeInstallError> {
    let output = Command::new(executable).args(arguments).output()?;
    if !output.status.success() {
        return Err(NativeInstallError::CommandFailed {
            executable: executable.to_owned(),
            status: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    String::from_utf8(output.stdout).map_err(|_| NativeInstallError::NonUtf8Output)
}

fn path_text(path: &Path) -> Result<&str, NativeInstallError> {
    path.to_str().ok_or(NativeInstallError::NonUtf8Path)
}

#[derive(Debug)]
enum NativeInstallError {
    Io(io::Error),
    Product(super::ProductStoreError),
    #[cfg(target_os = "macos")]
    InvalidDmgMount,
    #[cfg(target_os = "macos")]
    InvalidApplicationInventory,
    #[cfg(target_os = "macos")]
    InvalidInstalledApplication,
    #[cfg(target_os = "macos")]
    BundleIdentifier(String),
    CommandFailed {
        executable: String,
        status: Option<i32>,
        stderr: String,
    },
    #[cfg(target_os = "macos")]
    NonUtf8Output,
    NonUtf8Path,
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    UnsupportedPlatform,
}

impl fmt::Display for NativeInstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("native Desktop install failed: ")?;
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Product(error) => write!(formatter, "{error}"),
            #[cfg(target_os = "macos")]
            Self::InvalidDmgMount => formatter.write_str("DMG mount point is invalid"),
            #[cfg(target_os = "macos")]
            Self::InvalidApplicationInventory => {
                formatter.write_str("DMG must contain exactly one application")
            }
            #[cfg(target_os = "macos")]
            Self::InvalidInstalledApplication => {
                formatter.write_str("installed Desktop application path is invalid")
            }
            #[cfg(target_os = "macos")]
            Self::BundleIdentifier(actual) => {
                write!(formatter, "unexpected application bundle id: {actual}")
            }
            Self::CommandFailed {
                executable,
                status,
                stderr,
            } => write!(formatter, "{executable} exited with {status:?}: {stderr}"),
            #[cfg(target_os = "macos")]
            Self::NonUtf8Output => formatter.write_str("native command output is not UTF-8"),
            Self::NonUtf8Path => formatter.write_str("native install path is not UTF-8"),
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            Self::UnsupportedPlatform => formatter.write_str("platform is unsupported"),
        }
    }
}

impl Error for NativeInstallError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Product(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for NativeInstallError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[cfg(target_os = "macos")]
impl From<nix::errno::Errno> for NativeInstallError {
    fn from(error: nix::errno::Errno) -> Self {
        Self::Io(error.into())
    }
}

impl From<super::ProductStoreError> for NativeInstallError {
    fn from(error: super::ProductStoreError) -> Self {
        Self::Product(error)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn packaged_macos_executable_maps_to_embedded_product_seed() {
        assert_eq!(
            installed_product_seed(Path::new(
                "/Applications/Debrute.app/Contents/MacOS/debrute"
            )),
            Some(PathBuf::from(
                "/Applications/Debrute.app/Contents/Resources/product-seed"
            ))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn verified_macos_file_descriptor_is_consumed_by_the_spawned_process() {
        let root = std::env::temp_dir().join(format!("debrute-fd-test-{}", Uuid::new_v4()));
        fs::write(&root, b"verified-bytes").unwrap();
        let file = fs::File::open(&root).unwrap();

        let output =
            with_inherited_file_path(&file, |path| command_output("/bin/cat", &[path])).unwrap();

        assert_eq!(output, "verified-bytes");
        let _ = fs::remove_file(root);
    }
}
