use std::{
    error::Error,
    fmt, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
};

#[cfg(target_os = "macos")]
use std::ffi::{OsStr, OsString};
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
    stable_runtime_entrypoint: PathBuf,
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
        stable_runtime_entrypoint: PathBuf,
        resume: ResumeHandler,
    ) -> Result<Self, ProductCommitError> {
        let identity = store.product_identity(running_version)?;
        Ok(Self {
            store,
            running: RunningProductIdentity::Runtime(identity),
            desktop,
            stable_runtime_entrypoint,
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
        stable_runtime_entrypoint: PathBuf,
        resume: ResumeHandler,
    ) -> Result<Self, ProductCommitError> {
        let identity = store.inspect_seed_identity(seed)?;
        Ok(Self {
            store,
            running: RunningProductIdentity::DesktopSeed(identity),
            desktop,
            stable_runtime_entrypoint,
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

    /// Launches the exact manifest-verified selected Runtime for pending update
    /// recovery through the same target launch contract as a running Runtime.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] when the selected Product or native launch
    /// contract is invalid.
    pub fn launch_selected_runtime(&self, product_version: &str) -> Result<(), ProductCommitError> {
        let _transaction = self.store.lock_transaction()?;
        let entrypoint = self.store.open_verified_runtime_unlocked(product_version)?;
        launch_target_runtime_update(
            &self.store,
            product_version,
            entrypoint,
            &self.stable_runtime_entrypoint,
        )
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
        launch_target_runtime_update(
            &self.store,
            product_version,
            entrypoint,
            &self.stable_runtime_entrypoint,
        )
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

struct TargetRuntimeUpdateLaunch {
    product_version: String,
    product_directory: PathBuf,
    web_assets_directory: PathBuf,
    stable_runtime_entrypoint: PathBuf,
    entrypoint: VerifiedRuntimeEntrypoint,
}

impl TargetRuntimeUpdateLaunch {
    fn new(
        store: &ProductStore,
        product_version: &str,
        entrypoint: VerifiedRuntimeEntrypoint,
        stable_runtime_entrypoint: &Path,
    ) -> Result<Self, ProductCommitError> {
        if !stable_runtime_entrypoint.is_absolute() {
            return Err(ProductCommitError::Platform(
                "target Runtime update launch requires an absolute stable entrypoint".to_owned(),
            ));
        }
        let product_directory = store.version_path(product_version);
        if !entrypoint.path().starts_with(&product_directory) {
            return Err(ProductCommitError::Platform(
                "verified target Runtime is outside the selected Product".to_owned(),
            ));
        }
        Ok(Self {
            product_version: product_version.to_owned(),
            web_assets_directory: product_directory.join("web"),
            product_directory,
            stable_runtime_entrypoint: stable_runtime_entrypoint.to_owned(),
            entrypoint,
        })
    }

    #[cfg(target_os = "macos")]
    fn application(&self) -> Result<&Path, ProductCommitError> {
        self.entrypoint
            .path()
            .ancestors()
            .find(|path| path.extension().is_some_and(|extension| extension == "app"))
            .ok_or_else(|| {
                ProductCommitError::Platform(
                    "verified target Runtime is outside a macOS application bundle".to_owned(),
                )
            })
    }
}

fn launch_target_runtime_update(
    store: &ProductStore,
    product_version: &str,
    entrypoint: VerifiedRuntimeEntrypoint,
    stable_runtime_entrypoint: &Path,
) -> Result<(), ProductCommitError> {
    let launch = TargetRuntimeUpdateLaunch::new(
        store,
        product_version,
        entrypoint,
        stable_runtime_entrypoint,
    )?;
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("/usr/bin/open");
        command
            .arg("-g")
            .arg("-n")
            .arg("--env")
            .arg(macos_environment_argument(
                ACTIVE_PRODUCT_DIRECTORY_ENV,
                launch.product_directory.as_os_str(),
            ))
            .arg("--env")
            .arg(macos_environment_argument(
                WEB_ASSETS_DIRECTORY_ENV,
                launch.web_assets_directory.as_os_str(),
            ))
            .arg("--env")
            .arg(macos_environment_argument(
                "DEBRUTE_COMPLETE_PRODUCT_UPDATE",
                OsStr::new(&launch.product_version),
            ))
            .arg(launch.application()?)
            .arg("--args");
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = Command::new(launch.entrypoint.path());
    command
        .arg("complete-product-update")
        .arg("--product-version")
        .arg(&launch.product_version)
        .arg("--stable-runtime-entrypoint")
        .arg(&launch.stable_runtime_entrypoint);
    #[cfg(target_os = "windows")]
    command
        .env(ACTIVE_PRODUCT_DIRECTORY_ENV, &launch.product_directory)
        .env(WEB_ASSETS_DIRECTORY_ENV, &launch.web_assets_directory)
        .env("DEBRUTE_COMPLETE_PRODUCT_UPDATE", &launch.product_version);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "macos")]
    {
        let status = command
            .status()
            .map_err(|error| ProductCommitError::Platform(error.to_string()))?;
        if !status.success() {
            return Err(ProductCommitError::Platform(format!(
                "LaunchServices rejected the target Runtime launch with status {status}"
            )));
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| ProductCommitError::Platform(error.to_string()))
    }
}

#[cfg(target_os = "macos")]
fn macos_environment_argument(name: &str, value: &OsStr) -> OsString {
    let mut argument = OsString::from(name);
    argument.push("=");
    argument.push(value);
    argument
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

#[cfg(target_os = "macos")]
fn install_desktop_native(
    store: &ProductStore,
    desktop: &DesktopHostRegistration,
    installer: &VerifiedDesktopInstaller,
) -> Result<(), NativeInstallError> {
    let (attach, restore_descriptor) =
        with_inherited_file_path(installer.file(), |installer_path| {
            command_output(
                "/usr/bin/hdiutil",
                &["attach", "-nobrowse", "-readonly", installer_path],
            )
        })?;
    let attach = match attach {
        Ok(attach) => attach,
        Err(error) => {
            return finish_macos_install_step(
                "attach verified Desktop DMG",
                Err(error),
                [(
                    "restore installer descriptor flags".to_owned(),
                    restore_descriptor,
                )],
            );
        }
    };
    let mount = attach
        .lines()
        .filter_map(|line| line.split('\t').next_back().map(str::trim))
        .find(|field| field.starts_with("/Volumes/"))
        .map(PathBuf::from);
    let Some(mount) = mount else {
        return finish_macos_install_step(
            "locate mounted Desktop DMG",
            Err(NativeInstallError::InvalidDmgMount),
            [(
                "restore installer descriptor flags".to_owned(),
                restore_descriptor,
            )],
        );
    };
    let result = install_mounted_macos_desktop(store, desktop, &mount);
    let detach =
        path_text(&mount).and_then(|mount| command_success("/usr/bin/hdiutil", &["detach", mount]));
    finish_macos_install_step(
        "install mounted Desktop application",
        result,
        [
            (
                "restore installer descriptor flags".to_owned(),
                restore_descriptor,
            ),
            (format!("detach Desktop DMG at {}", mount.display()), detach),
        ],
    )
}

#[cfg(target_os = "macos")]
fn install_mounted_macos_desktop(
    store: &ProductStore,
    desktop: &DesktopHostRegistration,
    mount: &Path,
) -> Result<(), NativeInstallError> {
    let source_application = mounted_desktop_application(mount)?;
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
            path_text(&source_application)?,
        ],
    )?;
    command_success(
        "/usr/sbin/spctl",
        &["-a", "-t", "exec", "-vv", path_text(&source_application)?],
    )?;
    command_success(
        "/usr/bin/xcrun",
        &["stapler", "validate", path_text(&source_application)?],
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
    let staging = command_success(
        "/usr/bin/ditto",
        &[path_text(&source_application)?, path_text(&staged)?],
    )
    .and_then(|()| {
        store
            .inspect_seed_identity_unlocked(&staged.join("Contents/Resources/product-seed"))
            .map_err(NativeInstallError::from)
    })
    .and_then(|_| {
        command_success(
            "/usr/bin/codesign",
            &[
                "--verify",
                "--deep",
                "--strict",
                "--verbose=2",
                path_text(&staged)?,
            ],
        )
    });
    if let Err(error) = staging {
        return finish_macos_install_step(
            format!("stage Desktop application at {}", staged.display()),
            Err(error),
            [(
                format!("remove staged application at {}", staged.display()),
                remove_macos_application(&staged).map_err(NativeInstallError::from),
            )],
        );
    }
    replace_macos_application(
        destination,
        &staged,
        &retired,
        |from, to| fs::rename(from, to),
        remove_macos_application,
    )
}

#[cfg(target_os = "macos")]
fn replace_macos_application(
    destination: &Path,
    staged: &Path,
    retired: &Path,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
    mut remove: impl FnMut(&Path) -> io::Result<()>,
) -> Result<(), NativeInstallError> {
    if let Err(error) = rename(destination, retired) {
        return finish_macos_install_step(
            format!(
                "retire installed application from {} to {}",
                destination.display(),
                retired.display()
            ),
            Err(error.into()),
            [(
                format!("remove staged application at {}", staged.display()),
                remove(staged).map_err(NativeInstallError::from),
            )],
        );
    }

    if let Err(install_error) = rename(staged, destination) {
        let restore = rename(retired, destination);
        if let Err(restore_error) = restore {
            return finish_macos_install_step(
                format!(
                    "install staged application from {} to {}",
                    staged.display(),
                    destination.display()
                ),
                Err(install_error.into()),
                [(
                    format!(
                        "restore retired application from {} to {}; recovery paths: staged={}, retired={}",
                        retired.display(),
                        destination.display(),
                        staged.display(),
                        retired.display()
                    ),
                    Err(restore_error.into()),
                )],
            );
        }
        return finish_macos_install_step(
            format!(
                "install staged application from {} to {}",
                staged.display(),
                destination.display()
            ),
            Err(install_error.into()),
            [(
                format!("remove staged application at {}", staged.display()),
                remove(staged).map_err(NativeInstallError::from),
            )],
        );
    }

    finish_macos_install_step(
        format!(
            "install staged application from {} to {}",
            staged.display(),
            destination.display()
        ),
        Ok(()),
        [(
            format!("remove retired application at {}", retired.display()),
            remove(retired).map_err(NativeInstallError::from),
        )],
    )
}

#[cfg(target_os = "macos")]
fn remove_macos_application(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

#[cfg(target_os = "macos")]
fn mounted_desktop_application(mount: &Path) -> Result<PathBuf, NativeInstallError> {
    let application = mount.join("Debrute.app");
    let metadata = fs::symlink_metadata(&application)
        .map_err(|_| NativeInstallError::InvalidApplicationBundle)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(NativeInstallError::InvalidApplicationBundle);
    }
    Ok(application)
}

#[cfg(target_os = "macos")]
type InheritedFilePathResult<T> = Result<
    (
        Result<T, NativeInstallError>,
        Result<(), NativeInstallError>,
    ),
    NativeInstallError,
>;

#[cfg(target_os = "macos")]
fn with_inherited_file_path<T>(
    file: &fs::File,
    use_path: impl FnOnce(&str) -> Result<T, NativeInstallError>,
) -> InheritedFilePathResult<T> {
    let original = FdFlag::from_bits_retain(fcntl(file, FcntlArg::F_GETFD)?);
    let mut inherited = original;
    inherited.remove(FdFlag::FD_CLOEXEC);
    fcntl(file, FcntlArg::F_SETFD(inherited))?;
    let path = format!("/dev/fd/{}", file.as_raw_fd());
    let result = use_path(&path);
    let restore = fcntl(file, FcntlArg::F_SETFD(original))
        .map(|_| ())
        .map_err(|error| NativeInstallError::Io(error.into()));
    Ok((result, restore))
}

#[cfg(target_os = "macos")]
fn finish_macos_install_step<T>(
    operation: impl Into<String>,
    result: Result<T, NativeInstallError>,
    followups: impl IntoIterator<Item = (String, Result<(), NativeInstallError>)>,
) -> Result<T, NativeInstallError> {
    let mut followup_failures = followups
        .into_iter()
        .filter_map(|(operation, result)| {
            result.err().map(|error| NativeInstallFailure {
                operation,
                error: Box::new(error),
            })
        })
        .collect::<Vec<_>>();
    match result {
        Ok(value) if followup_failures.is_empty() => Ok(value),
        Ok(_) => Err(NativeInstallError::Failures(followup_failures)),
        Err(error) => {
            followup_failures.insert(
                0,
                NativeInstallFailure {
                    operation: operation.into(),
                    error: Box::new(error),
                },
            );
            Err(NativeInstallError::Failures(followup_failures))
        }
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
    InvalidApplicationBundle,
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
    #[cfg(target_os = "macos")]
    Failures(Vec<NativeInstallFailure>),
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct NativeInstallFailure {
    operation: String,
    error: Box<NativeInstallError>,
}

impl fmt::Display for NativeInstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("native Desktop install failed: ")?;
        self.fmt_detail(formatter)
    }
}

impl NativeInstallError {
    fn fmt_detail(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Product(error) => write!(formatter, "{error}"),
            #[cfg(target_os = "macos")]
            Self::InvalidDmgMount => formatter.write_str("DMG mount point is invalid"),
            #[cfg(target_os = "macos")]
            Self::InvalidApplicationBundle => {
                formatter.write_str("DMG must contain a real Debrute.app directory at its root")
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
            #[cfg(target_os = "macos")]
            Self::Failures(failures) => {
                for (index, failure) in failures.iter().enumerate() {
                    if index > 0 {
                        formatter.write_str("; ")?;
                    }
                    write!(formatter, "{}: ", failure.operation)?;
                    failure.error.fmt_detail(formatter)?;
                }
                Ok(())
            }
        }
    }
}

impl Error for NativeInstallError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Product(error) => Some(error),
            #[cfg(target_os = "macos")]
            Self::Failures(failures) => failures
                .first()
                .map(|failure| failure.error.as_ref() as &(dyn Error + 'static)),
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
    use std::cell::Cell;

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

    #[test]
    fn mounted_dmg_requires_the_fixed_real_debrute_application() {
        let root = std::env::temp_dir().join(format!("debrute-dmg-test-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("Other.app")).unwrap();
        assert!(matches!(
            mounted_desktop_application(&root),
            Err(NativeInstallError::InvalidApplicationBundle)
        ));
        fs::create_dir(root.join("Debrute.app")).unwrap();
        assert_eq!(
            mounted_desktop_application(&root).unwrap(),
            root.join("Debrute.app")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mounted_dmg_rejects_a_debrute_application_symlink() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("debrute-dmg-link-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("actual.app")).unwrap();
        symlink(root.join("actual.app"), root.join("Debrute.app")).unwrap();
        assert!(matches!(
            mounted_desktop_application(&root),
            Err(NativeInstallError::InvalidApplicationBundle)
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn verified_macos_file_descriptor_is_consumed_by_the_spawned_process() {
        let root = std::env::temp_dir().join(format!("debrute-fd-test-{}", Uuid::new_v4()));
        fs::write(&root, b"verified-bytes").unwrap();
        let file = fs::File::open(&root).unwrap();

        let (output, restore) =
            with_inherited_file_path(&file, |path| command_output("/bin/cat", &[path])).unwrap();

        assert_eq!(output.unwrap(), "verified-bytes");
        restore.unwrap();
        let _ = fs::remove_file(root);
    }

    #[test]
    fn install_failure_reports_every_cleanup_failure() {
        let error = finish_macos_install_step::<()>(
            "install application",
            Err(io_failure("install failed")),
            [
                (
                    "restore descriptor".to_owned(),
                    Err(io_failure("restore failed")),
                ),
                ("detach DMG".to_owned(), Err(io_failure("detach failed"))),
            ],
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("install application: install failed"));
        assert!(error.contains("restore descriptor: restore failed"));
        assert!(error.contains("detach DMG: detach failed"));
    }

    #[test]
    fn failed_application_swap_restores_old_application_before_cleaning_staged_copy() {
        let rename_calls = Cell::new(0);
        let remove_calls = Cell::new(0);
        let error = replace_macos_application(
            Path::new("/Applications/Debrute.app"),
            Path::new("/Applications/.Debrute-update.app"),
            Path::new("/Applications/.Debrute-retired.app"),
            |_, _| {
                let call = rename_calls.get();
                rename_calls.set(call + 1);
                match call {
                    0 | 2 => Ok(()),
                    1 => Err(io::Error::other("install failed")),
                    _ => unreachable!(),
                }
            },
            |_| {
                remove_calls.set(remove_calls.get() + 1);
                Err(io::Error::other("staged cleanup failed"))
            },
        )
        .unwrap_err()
        .to_string();

        assert_eq!(rename_calls.get(), 3);
        assert_eq!(remove_calls.get(), 1);
        assert!(error.contains("install failed"));
        assert!(error.contains("remove staged application"));
        assert!(error.contains("staged cleanup failed"));
    }

    #[test]
    fn failed_restore_retains_both_recovery_applications() {
        let rename_calls = Cell::new(0);
        let remove_called = Cell::new(false);
        let error = replace_macos_application(
            Path::new("/Applications/Debrute.app"),
            Path::new("/Applications/.Debrute-update.app"),
            Path::new("/Applications/.Debrute-retired.app"),
            |_, _| {
                let call = rename_calls.get();
                rename_calls.set(call + 1);
                match call {
                    0 => Ok(()),
                    1 => Err(io::Error::other("install failed")),
                    2 => Err(io::Error::other("restore failed")),
                    _ => unreachable!(),
                }
            },
            |_| {
                remove_called.set(true);
                Ok(())
            },
        )
        .unwrap_err()
        .to_string();

        assert_eq!(rename_calls.get(), 3);
        assert!(!remove_called.get());
        assert!(error.contains("install failed"));
        assert!(error.contains("restore failed"));
        assert!(error.contains("recovery paths"));
        assert!(error.contains(".Debrute-update.app"));
        assert!(error.contains(".Debrute-retired.app"));
    }

    #[test]
    fn failed_retirement_reports_staged_cleanup_failure() {
        let remove_calls = Cell::new(0);
        let error = replace_macos_application(
            Path::new("/Applications/Debrute.app"),
            Path::new("/Applications/.Debrute-update.app"),
            Path::new("/Applications/.Debrute-retired.app"),
            |_, _| Err(io::Error::other("retire failed")),
            |_| {
                remove_calls.set(remove_calls.get() + 1);
                Err(io::Error::other("staged cleanup failed"))
            },
        )
        .unwrap_err()
        .to_string();

        assert_eq!(remove_calls.get(), 1);
        assert!(error.contains("retire failed"));
        assert!(error.contains("staged cleanup failed"));
    }

    #[test]
    fn successful_application_swap_reports_retired_cleanup_failure() {
        let rename_calls = Cell::new(0);
        let error = replace_macos_application(
            Path::new("/Applications/Debrute.app"),
            Path::new("/Applications/.Debrute-update.app"),
            Path::new("/Applications/.Debrute-retired.app"),
            |_, _| {
                rename_calls.set(rename_calls.get() + 1);
                Ok(())
            },
            |path| {
                assert_eq!(path, Path::new("/Applications/.Debrute-retired.app"));
                Err(io::Error::other("retired cleanup failed"))
            },
        )
        .unwrap_err()
        .to_string();

        assert_eq!(rename_calls.get(), 2);
        assert!(error.contains("remove retired application"));
        assert!(error.contains("retired cleanup failed"));
    }

    #[test]
    fn successful_application_swap_removes_only_the_retired_application() {
        let rename_calls = Cell::new(0);
        let remove_calls = Cell::new(0);
        replace_macos_application(
            Path::new("/Applications/Debrute.app"),
            Path::new("/Applications/.Debrute-update.app"),
            Path::new("/Applications/.Debrute-retired.app"),
            |_, _| {
                rename_calls.set(rename_calls.get() + 1);
                Ok(())
            },
            |path| {
                remove_calls.set(remove_calls.get() + 1);
                assert_eq!(path, Path::new("/Applications/.Debrute-retired.app"));
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(rename_calls.get(), 2);
        assert_eq!(remove_calls.get(), 1);
    }

    fn io_failure(message: &str) -> NativeInstallError {
        NativeInstallError::Io(io::Error::other(message.to_owned()))
    }
}
