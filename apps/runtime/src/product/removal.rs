use std::{
    error::Error,
    fmt, fs, io,
    io::Write as _,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::control::{ControlErrorCode, ProductRemovalCommit, RuntimeProductRemovalService};

#[cfg(target_os = "macos")]
use crate::login::MacOsLoginItem;
#[cfg(target_os = "windows")]
use crate::login::WindowsLoginItem;

#[cfg(target_os = "windows")]
use super::layout::{
    WINDOWS_INSTALLER_CACHE_DIRECTORY, WINDOWS_INSTALLER_GUID, WINDOWS_SHORTCUT_NAME,
};
use super::{
    CommitPlatform, InstalledProductLayout, ProductInstallationError, ProductLayoutError,
    ProductProjectionError, ProductProjectionManager, ProductStore, ProductStoreError,
    read_desktop_host_registration,
};

const REMOVAL_PLAN_SCHEMA_VERSION: u32 = 1;
const FINALIZER_WAIT_TIMEOUT: Duration = Duration::from_secs(120);
#[cfg(target_os = "windows")]
const OWNED_ENTRY_REMOVE_TIMEOUT: Duration = Duration::from_secs(10);

/// Validates the installed Product and prepares its one detached removal execution.
pub struct ProductRemovalCoordinator {
    layout: InstalledProductLayout,
    store: Arc<ProductStore>,
    runtime_executable: PathBuf,
}

impl ProductRemovalCoordinator {
    #[must_use]
    pub fn new(
        layout: InstalledProductLayout,
        store: Arc<ProductStore>,
        runtime_executable: PathBuf,
    ) -> Self {
        Self {
            layout,
            store,
            runtime_executable,
        }
    }

    /// Creates the private one-shot plan, retained configuration stage, and
    /// manifest-validated Runtime execution closure.
    ///
    /// # Errors
    ///
    /// Returns [`ProductRemovalError`] before the Runtime lifecycle changes when
    /// the selected Product, Desktop registration, or any staging boundary is invalid.
    pub(crate) fn prepare(
        &self,
        keep_config: bool,
    ) -> Result<PreparedProductRemoval, ProductRemovalError> {
        if self.store.pending()?.is_some() {
            return Err(ProductRemovalError::UpdateInProgress);
        }
        let version = self
            .store
            .current_version()?
            .ok_or(ProductRemovalError::CurrentProductMissing)?;
        let manifest = self.store.validate_version(&version)?;
        let expected_runtime = self
            .store
            .version_path(&version)
            .join(&manifest.entrypoints.runtime);
        if fs::canonicalize(&expected_runtime)? != fs::canonicalize(&self.runtime_executable)? {
            return Err(ProductRemovalError::RuntimeIdentityMismatch);
        }
        let desktop = read_desktop_host_registration(self.layout.debrute_home())?
            .ok_or(ProductRemovalError::DesktopRegistrationMissing)?;
        if desktop.executable != self.layout.desktop_executable() || !desktop.arguments.is_empty() {
            return Err(ProductRemovalError::DesktopRegistrationMismatch);
        }

        let transaction_id = Uuid::new_v4();
        let transaction_directory = self
            .layout
            .user_home()
            .join(format!(".debrute-removal-{transaction_id}"));
        let capsule_directory =
            std::env::temp_dir().join(format!("debrute-removal-runtime-{transaction_id}"));
        let prepared = (|| {
            create_private_directory(&transaction_directory)?;
            create_private_directory(&capsule_directory)?;
            let retained_config = if keep_config {
                let retained = transaction_directory.join("retained-config");
                create_private_directory(&retained)?;
                copy_optional_plain_file_preserving_metadata(
                    &self.layout.global_settings_file(),
                    &retained.join("global_settings.json"),
                )?;
                copy_optional_plain_file_preserving_metadata(
                    &self.layout.secrets_file(),
                    &retained.join("secrets.json"),
                )?;
                Some(retained)
            } else {
                None
            };
            let runtime_entrypoint = copy_runtime_closure(
                &expected_runtime,
                &capsule_directory,
                self.layout.platform(),
            )?;
            let plan_path = transaction_directory.join("plan.json");
            let plan = ProductRemovalPlan {
                schema_version: REMOVAL_PLAN_SCHEMA_VERSION,
                transaction_id: transaction_id.to_string(),
                platform: platform_name(self.layout.platform()).to_owned(),
                user_home: self.layout.user_home().to_owned(),
                local_app_data: windows_local_app_data(&self.layout),
                transaction_directory: transaction_directory.clone(),
                capsule_directory: capsule_directory.clone(),
                retained_config: retained_config.clone(),
            };
            write_private_json(&plan_path, &plan)?;
            Ok(PreparedProductRemoval {
                plan_path,
                runtime_entrypoint,
                transaction_directory: transaction_directory.clone(),
                capsule_directory: capsule_directory.clone(),
                #[cfg(all(test, target_os = "macos"))]
                retained_config,
            })
        })();
        match prepared {
            Ok(prepared) => Ok(prepared),
            Err(primary) => Err(with_staging_cleanup(
                primary,
                &transaction_directory,
                &capsule_directory,
                remove_owned_entry,
            )),
        }
    }
}

impl RuntimeProductRemovalService for ProductRemovalCoordinator {
    fn prepare_removal(&self, keep_config: bool) -> Result<ProductRemovalCommit, ControlErrorCode> {
        let prepared = self.prepare(keep_config).map_err(|error| {
            if error.has_cleanup_failures() {
                eprintln!("Debrute Product removal preparation and prepared-state cleanup failed");
            }
            ControlErrorCode::ProductRemovalUnavailable
        })?;
        let shared = Arc::new(std::sync::Mutex::new(Some(prepared)));
        let launch = Arc::clone(&shared);
        Ok(ProductRemovalCommit::new(
            move || {
                launch
                    .lock()
                    .expect("prepared Product removal lock poisoned")
                    .take()
                    .expect("prepared Product removal is one-shot")
                    .launch()
                    .map_err(|error| error.control_diagnostic())
            },
            move || {
                if let Some(prepared) = shared
                    .lock()
                    .expect("prepared Product removal lock poisoned")
                    .take()
                {
                    prepared
                        .cancel()
                        .map_err(|error| error.control_diagnostic())
                } else {
                    Ok(())
                }
            },
        ))
    }
}

pub(crate) struct PreparedProductRemoval {
    plan_path: PathBuf,
    runtime_entrypoint: PathBuf,
    transaction_directory: PathBuf,
    capsule_directory: PathBuf,
    #[cfg(all(test, target_os = "macos"))]
    retained_config: Option<PathBuf>,
}

impl PreparedProductRemoval {
    #[cfg(all(test, target_os = "macos"))]
    #[must_use]
    pub(crate) fn plan_path(&self) -> &Path {
        &self.plan_path
    }

    #[cfg(all(test, target_os = "macos"))]
    #[must_use]
    pub(crate) fn runtime_entrypoint(&self) -> &Path {
        &self.runtime_entrypoint
    }

    #[cfg(all(test, target_os = "macos"))]
    #[must_use]
    pub(crate) fn retained_config(&self) -> Option<&Path> {
        self.retained_config.as_deref()
    }

    /// Starts the copied Runtime closure in its private finalization mode.
    ///
    /// # Errors
    ///
    /// Returns [`ProductRemovalError`] if the detached finalizer cannot be spawned.
    pub(crate) fn launch(self) -> Result<(), ProductRemovalError> {
        let mut command = Command::new(&self.runtime_entrypoint);
        command
            .arg("finalize-product-removal")
            .arg("--plan")
            .arg(&self.plan_path)
            .arg("--runtime-pid")
            .arg(std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt as _;
            use windows_sys::Win32::System::Threading::{
                CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
            };
            command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
        }
        match command.spawn() {
            Ok(_) => Ok(()),
            Err(error) => Err(with_staging_cleanup(
                error.into(),
                &self.transaction_directory,
                &self.capsule_directory,
                remove_owned_entry,
            )),
        }
    }

    /// Cancels a prepared transaction before lifecycle admission.
    ///
    /// # Errors
    ///
    /// Returns [`ProductRemovalError`] if private staging cannot be removed.
    pub(crate) fn cancel(self) -> Result<(), ProductRemovalError> {
        cleanup_removal_staging(
            &self.transaction_directory,
            &self.capsule_directory,
            remove_owned_entry,
        )
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductRemovalPlan {
    schema_version: u32,
    transaction_id: String,
    platform: String,
    user_home: PathBuf,
    local_app_data: Option<PathBuf>,
    transaction_directory: PathBuf,
    capsule_directory: PathBuf,
    retained_config: Option<PathBuf>,
}

/// Runs the internal detached finalization mode.
///
/// # Errors
///
/// Returns [`ProductRemovalError`] when the plan is not the exact current-user
/// transaction or Product removal cannot complete.
pub fn finalize_product_removal(
    plan_path: &Path,
    runtime_pid: u32,
) -> Result<(), ProductRemovalError> {
    let bytes = fs::read(plan_path)?;
    if bytes.len() > 64 * 1024 {
        return Err(ProductRemovalError::InvalidPlan);
    }
    let plan: ProductRemovalPlan =
        serde_json::from_slice(&bytes).map_err(|_| ProductRemovalError::InvalidPlan)?;
    let layout = InstalledProductLayout::for_current_user()?;
    validate_plan(plan_path, &plan, &layout)?;
    wait_for_process_exit(runtime_pid)?;
    execute_removal_plan(
        &ProductRemovalExecutor::new(layout),
        plan.retained_config.as_deref(),
        &plan.transaction_directory,
        &plan.capsule_directory,
    )
}

pub(crate) fn execute_removal_plan(
    executor: &ProductRemovalExecutor,
    retained_config: Option<&Path>,
    transaction_directory: &Path,
    capsule_directory: &Path,
) -> Result<(), ProductRemovalError> {
    executor.execute_before_desktop(retained_config)?;
    cleanup_removal_staging(
        transaction_directory,
        capsule_directory,
        dispose_runtime_capsule,
    )?;
    executor.remove_desktop()
}

fn validate_plan(
    plan_path: &Path,
    plan: &ProductRemovalPlan,
    layout: &InstalledProductLayout,
) -> Result<(), ProductRemovalError> {
    let transaction_id =
        Uuid::parse_str(&plan.transaction_id).map_err(|_| ProductRemovalError::InvalidPlan)?;
    let expected_transaction = layout
        .user_home()
        .join(format!(".debrute-removal-{transaction_id}"));
    let expected_capsule =
        std::env::temp_dir().join(format!("debrute-removal-runtime-{transaction_id}"));
    if plan.schema_version != REMOVAL_PLAN_SCHEMA_VERSION
        || plan.platform != platform_name(layout.platform())
        || plan.user_home != layout.user_home()
        || plan.local_app_data != windows_local_app_data(layout)
        || plan.transaction_directory != expected_transaction
        || plan.capsule_directory != expected_capsule
        || plan_path != expected_transaction.join("plan.json")
        || plan
            .retained_config
            .as_deref()
            .is_some_and(|path| path != expected_transaction.join("retained-config"))
    {
        return Err(ProductRemovalError::InvalidPlan);
    }
    Ok(())
}

fn platform_name(platform: CommitPlatform) -> &'static str {
    match platform {
        CommitPlatform::Macos => "macos",
        CommitPlatform::Windows => "windows",
    }
}

fn windows_local_app_data(layout: &InstalledProductLayout) -> Option<PathBuf> {
    match layout.platform() {
        CommitPlatform::Macos => None,
        CommitPlatform::Windows => layout
            .desktop_application()
            .parent()
            .and_then(Path::parent)
            .map(Path::to_owned),
    }
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), ProductRemovalError> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(
        &serde_json::to_vec_pretty(value).map_err(|_| ProductRemovalError::InvalidPlan)?,
    )?;
    set_private_file_permissions(path)?;
    file.sync_all()?;
    sync_removal_directory(path.parent().ok_or(ProductRemovalError::InvalidPlan)?)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn sync_removal_directory(path: &Path) -> Result<(), ProductRemovalError> {
    fs::File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn sync_removal_directory(path: &Path) -> Result<(), ProductRemovalError> {
    debrute_windows_product_fs::sync_directory(path)?;
    Ok(())
}

fn copy_optional_plain_file_preserving_metadata(
    source: &Path,
    destination: &Path,
) -> Result<(), ProductRemovalError> {
    let metadata = match fs::symlink_metadata(source) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            metadata
        }
        Ok(_) => {
            return Err(ProductRemovalError::InvalidRetainedConfig(
                source.to_owned(),
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    fs::copy(source, destination)?;
    fs::set_permissions(destination, metadata.permissions())?;
    fs::File::open(destination)?.sync_all()?;
    sync_removal_directory(destination.parent().ok_or(
        ProductRemovalError::InvalidRetainedConfig(destination.to_owned()),
    )?)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_runtime_closure(
    runtime: &Path,
    capsule: &Path,
    platform: CommitPlatform,
) -> Result<PathBuf, ProductRemovalError> {
    if platform != CommitPlatform::Macos {
        return Err(ProductRemovalError::RuntimeIdentityMismatch);
    }
    let application = runtime
        .ancestors()
        .find(|path| {
            path.file_name()
                .is_some_and(|name| name == "Debrute Runtime.app")
        })
        .ok_or(ProductRemovalError::RuntimeIdentityMismatch)?;
    let destination = capsule.join("Debrute Runtime.app");
    let status = Command::new("/usr/bin/ditto")
        .arg(application)
        .arg(&destination)
        .status()?;
    if !status.success() {
        return Err(ProductRemovalError::Platform(
            "Could not copy the Runtime application closure".to_owned(),
        ));
    }
    Ok(destination.join("Contents/MacOS/debrute-runtime"))
}

#[cfg(target_os = "windows")]
fn copy_runtime_closure(
    runtime: &Path,
    capsule: &Path,
    platform: CommitPlatform,
) -> Result<PathBuf, ProductRemovalError> {
    if platform != CommitPlatform::Windows {
        return Err(ProductRemovalError::RuntimeIdentityMismatch);
    }
    let source = runtime
        .parent()
        .ok_or(ProductRemovalError::RuntimeIdentityMismatch)?;
    let destination = capsule.join("runtime");
    copy_directory(source, &destination)?;
    Ok(destination.join("debrute-runtime.exe"))
}

#[cfg(target_os = "windows")]
fn copy_directory(source: &Path, destination: &Path) -> Result<(), ProductRemovalError> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() && !kind.is_symlink() {
            copy_directory(&entry.path(), &target)?;
        } else if kind.is_file() && !kind.is_symlink() {
            fs::copy(entry.path(), target)?;
        } else {
            return Err(ProductRemovalError::RuntimeIdentityMismatch);
        }
    }
    Ok(())
}

fn create_private_directory(path: &Path) -> Result<(), ProductRemovalError> {
    fs::create_dir(path)?;
    set_private_directory_permissions(path)?;
    sync_removal_directory(path)?;
    sync_removal_directory(path.parent().ok_or(ProductRemovalError::InvalidPlan)?)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_private_directory_permissions(path: &Path) -> Result<(), ProductRemovalError> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_private_directory_permissions(_path: &Path) -> Result<(), ProductRemovalError> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_private_file_permissions(path: &Path) -> Result<(), ProductRemovalError> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_private_file_permissions(_path: &Path) -> Result<(), ProductRemovalError> {
    Ok(())
}

fn wait_for_process_exit(pid: u32) -> Result<(), ProductRemovalError> {
    let deadline = Instant::now() + FINALIZER_WAIT_TIMEOUT;
    while process_is_running(pid)? {
        if Instant::now() >= deadline {
            return Err(ProductRemovalError::ProcessExitTimedOut(pid));
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn process_is_running(pid: u32) -> Result<bool, ProductRemovalError> {
    let native_pid = i32::try_from(pid).map_err(|_| {
        ProductRemovalError::Platform(
            "Runtime process identifier is outside the macOS process range".to_owned(),
        )
    })?;
    classify_macos_process_probe(nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(native_pid),
        None,
    ))
    .map_err(|error| {
        ProductRemovalError::Platform(format!(
            "Runtime process probe failed with macOS error {}",
            error as i32
        ))
    })
}

#[cfg(target_os = "macos")]
fn classify_macos_process_probe(
    result: Result<(), nix::errno::Errno>,
) -> Result<bool, nix::errno::Errno> {
    match result {
        Ok(()) | Err(nix::errno::Errno::EPERM) => Ok(true),
        Err(nix::errno::Errno::ESRCH) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "windows")]
fn process_is_running(pid: u32) -> Result<bool, ProductRemovalError> {
    Ok(debrute_windows_product_fs::process_is_running(pid))
}

#[cfg(target_os = "macos")]
fn dispose_runtime_capsule(capsule: &Path) -> Result<(), ProductRemovalError> {
    remove_owned_entry(capsule)
}

#[cfg(target_os = "windows")]
fn dispose_runtime_capsule(capsule: &Path) -> Result<(), ProductRemovalError> {
    schedule_tree_for_reboot_deletion(capsule)
}

#[cfg(target_os = "windows")]
fn schedule_tree_for_reboot_deletion(path: &Path) -> Result<(), ProductRemovalError> {
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            schedule_tree_for_reboot_deletion(&entry?.path())?;
        }
    }
    debrute_windows_product_fs::schedule_delete_on_reboot(path)?;
    Ok(())
}

/// Executes the one closed whole-Product removal plan from a detached Runtime.
pub(crate) struct ProductRemovalExecutor {
    layout: InstalledProductLayout,
}

impl ProductRemovalExecutor {
    #[must_use]
    pub(crate) fn new(layout: InstalledProductLayout) -> Self {
        Self { layout }
    }

    /// Removes every Product-owned surface and optionally restores the two staged
    /// configuration files.
    ///
    /// # Errors
    ///
    /// Returns [`ProductRemovalError`] when the retained directory is inside a
    /// removal boundary, a platform registration cannot be removed, or any owned
    /// filesystem mutation fails.
    #[cfg(all(test, target_os = "macos"))]
    pub(crate) fn execute(
        &self,
        retained_config: Option<&Path>,
    ) -> Result<(), ProductRemovalError> {
        self.execute_before_desktop(retained_config)?;
        self.remove_desktop()
    }

    fn execute_before_desktop(
        &self,
        retained_config: Option<&Path>,
    ) -> Result<(), ProductRemovalError> {
        if let Some(staging) = retained_config {
            self.validate_retained_config(staging)?;
        }
        ProductProjectionManager::remove_command_path(&self.layout)?;
        self.remove_login_item()?;
        ProductProjectionManager::remove_official_skills(self.layout.skills_directory())?;
        #[cfg(target_os = "windows")]
        self.remove_windows_installer_registration()?;
        remove_owned_entry(self.layout.debrute_home())?;
        if let Some(staging) = retained_config {
            self.restore_retained_config(staging)?;
            remove_owned_entry(staging)?;
        }
        Ok(())
    }

    fn remove_desktop(&self) -> Result<(), ProductRemovalError> {
        remove_owned_entry(self.layout.desktop_application())
    }

    fn validate_retained_config(&self, staging: &Path) -> Result<(), ProductRemovalError> {
        if staging.starts_with(self.layout.debrute_home())
            || staging.starts_with(self.layout.desktop_application())
            || staging.starts_with(self.layout.skills_directory())
        {
            return Err(ProductRemovalError::InvalidRetainedConfig(
                staging.to_owned(),
            ));
        }
        let metadata = fs::symlink_metadata(staging)
            .map_err(|_| ProductRemovalError::InvalidRetainedConfig(staging.to_owned()))?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return Err(ProductRemovalError::InvalidRetainedConfig(
                staging.to_owned(),
            ));
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn remove_login_item(&self) -> Result<(), ProductRemovalError> {
        MacOsLoginItem::new(
            self.layout.user_home(),
            self.layout.bin_directory().join("debrute-runtime"),
        )
        .set_enabled(false)
        .map_err(|error| ProductRemovalError::Platform(error.to_string()))
    }

    #[cfg(target_os = "windows")]
    fn remove_login_item(&self) -> Result<(), ProductRemovalError> {
        WindowsLoginItem::new(
            self.layout
                .product_root()
                .join("current/runtime/debrute-runtime.exe"),
        )
        .set_enabled(false)
        .map_err(|error| ProductRemovalError::Platform(error.to_string()))
    }

    #[cfg(target_os = "windows")]
    fn remove_windows_installer_registration(&self) -> Result<(), ProductRemovalError> {
        use winreg::{RegKey, enums::HKEY_CURRENT_USER};

        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        for key in [
            format!("Software\\{WINDOWS_INSTALLER_GUID}"),
            format!(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{WINDOWS_INSTALLER_GUID}"
            ),
        ] {
            match current_user.delete_subkey_all(&key) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let programs = debrute_windows_product_fs::current_user_programs_directory()?;
        remove_owned_entry(&programs.join(WINDOWS_SHORTCUT_NAME))?;
        if let Some(local_app_data) = windows_local_app_data(&self.layout) {
            remove_owned_entry(&local_app_data.join(WINDOWS_INSTALLER_CACHE_DIRECTORY))?;
        }
        Ok(())
    }

    fn restore_retained_config(&self, staging: &Path) -> Result<(), ProductRemovalError> {
        let global_settings = staging.join("global_settings.json");
        let secrets = staging.join("secrets.json");
        if !plain_file_exists(&global_settings)? && !plain_file_exists(&secrets)? {
            return Ok(());
        }
        let config = self.layout.debrute_home().join("config");
        fs::create_dir_all(&config)?;
        set_private_directory_permissions(self.layout.debrute_home())?;
        set_private_directory_permissions(&config)?;
        sync_removal_directory(&config)?;
        sync_removal_directory(self.layout.debrute_home())?;
        sync_removal_directory(self.layout.user_home())?;
        copy_optional_plain_file_preserving_metadata(
            &global_settings,
            &self.layout.global_settings_file(),
        )?;
        copy_optional_plain_file_preserving_metadata(&secrets, &self.layout.secrets_file())?;
        Ok(())
    }
}

fn plain_file_exists(path: &Path) -> Result<bool, ProductRemovalError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            Ok(true)
        }
        Ok(_) => Err(ProductRemovalError::InvalidRetainedConfig(path.to_owned())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn remove_owned_entry(path: &Path) -> Result<(), ProductRemovalError> {
    #[cfg(target_os = "windows")]
    {
        let deadline = Instant::now() + OWNED_ENTRY_REMOVE_TIMEOUT;
        loop {
            match remove_owned_entry_once(path) {
                Ok(()) => return Ok(()),
                Err(error)
                    if is_retryable_owned_entry_remove_error(&error)
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(100));
                }
                Err(error) => return Err(error),
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        remove_owned_entry_once(path)
    }
}

#[cfg(target_os = "windows")]
fn is_retryable_owned_entry_remove_error(error: &ProductRemovalError) -> bool {
    use windows_sys::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_BUSY, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
    };

    let ProductRemovalError::Io(error) = error else {
        return false;
    };
    matches!(
        error.raw_os_error(),
        Some(code)
            if code == ERROR_ACCESS_DENIED as i32
                || code == ERROR_BUSY as i32
                || code == ERROR_LOCK_VIOLATION as i32
                || code == ERROR_SHARING_VIOLATION as i32
    )
}

fn remove_owned_entry_once(path: &Path) -> Result<(), ProductRemovalError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn cleanup_removal_staging(
    transaction_directory: &Path,
    capsule_directory: &Path,
    dispose_capsule: impl FnOnce(&Path) -> Result<(), ProductRemovalError>,
) -> Result<(), ProductRemovalError> {
    let mut failures = Vec::new();
    if let Err(error) = remove_owned_entry(transaction_directory) {
        failures.push(error);
    }
    if let Err(error) = dispose_capsule(capsule_directory) {
        failures.push(error);
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(ProductRemovalError::Cleanup(failures))
    }
}

fn with_staging_cleanup(
    primary: ProductRemovalError,
    transaction_directory: &Path,
    capsule_directory: &Path,
    dispose_capsule: impl FnOnce(&Path) -> Result<(), ProductRemovalError>,
) -> ProductRemovalError {
    match cleanup_removal_staging(transaction_directory, capsule_directory, dispose_capsule) {
        Ok(()) => primary,
        Err(ProductRemovalError::Cleanup(cleanup)) => ProductRemovalError::OperationAndCleanup {
            primary: Box::new(primary),
            cleanup,
        },
        Err(error) => ProductRemovalError::OperationAndCleanup {
            primary: Box::new(primary),
            cleanup: vec![error],
        },
    }
}

#[derive(Debug)]
pub enum ProductRemovalError {
    Io(io::Error),
    Installation(ProductInstallationError),
    Projection(ProductProjectionError),
    InvalidRetainedConfig(PathBuf),
    Platform(String),
    Product(ProductStoreError),
    Layout(ProductLayoutError),
    UpdateInProgress,
    CurrentProductMissing,
    RuntimeIdentityMismatch,
    DesktopRegistrationMissing,
    DesktopRegistrationMismatch,
    InvalidPlan,
    ProcessExitTimedOut(u32),
    Cleanup(Vec<ProductRemovalError>),
    OperationAndCleanup {
        primary: Box<ProductRemovalError>,
        cleanup: Vec<ProductRemovalError>,
    },
}

impl ProductRemovalError {
    fn has_cleanup_failures(&self) -> bool {
        match self {
            Self::Cleanup(cleanup) | Self::OperationAndCleanup { cleanup, .. } => {
                !cleanup.is_empty()
            }
            _ => false,
        }
    }

    fn control_diagnostic(&self) -> String {
        if self.has_cleanup_failures() {
            "Product removal operation and prepared-state cleanup failed".to_owned()
        } else {
            "Product removal operation failed".to_owned()
        }
    }
}

impl fmt::Display for ProductRemovalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Product removal failed: {self:?}")
    }
}

impl Error for ProductRemovalError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Installation(error) => Some(error),
            Self::Projection(error) => Some(error),
            Self::Product(error) => Some(error),
            Self::Layout(error) => Some(error),
            Self::Cleanup(errors) => errors.first().map(|error| error as &(dyn Error + 'static)),
            Self::OperationAndCleanup { primary, .. } => Some(primary.as_ref()),
            Self::InvalidRetainedConfig(_)
            | Self::Platform(_)
            | Self::UpdateInProgress
            | Self::CurrentProductMissing
            | Self::RuntimeIdentityMismatch
            | Self::DesktopRegistrationMissing
            | Self::DesktopRegistrationMismatch
            | Self::InvalidPlan
            | Self::ProcessExitTimedOut(_) => None,
        }
    }
}

impl From<io::Error> for ProductRemovalError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<ProductInstallationError> for ProductRemovalError {
    fn from(error: ProductInstallationError) -> Self {
        Self::Installation(error)
    }
}

impl From<ProductProjectionError> for ProductRemovalError {
    fn from(error: ProductProjectionError) -> Self {
        Self::Projection(error)
    }
}

impl From<ProductStoreError> for ProductRemovalError {
    fn from(error: ProductStoreError) -> Self {
        Self::Product(error)
    }
}

impl From<ProductLayoutError> for ProductRemovalError {
    fn from(error: ProductLayoutError) -> Self {
        Self::Layout(error)
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_process_probe_only_treats_esrch_as_process_exit() {
        use nix::errno::Errno;

        assert_eq!(super::classify_macos_process_probe(Ok(())), Ok(true));
        assert_eq!(
            super::classify_macos_process_probe(Err(Errno::EPERM)),
            Ok(true)
        );
        assert_eq!(
            super::classify_macos_process_probe(Err(Errno::ESRCH)),
            Ok(false)
        );
        assert_eq!(
            super::classify_macos_process_probe(Err(Errno::EINVAL)),
            Err(Errno::EINVAL)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_owned_entry_retry_is_limited_to_transient_lock_errors() {
        use std::io;

        use windows_sys::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_BUSY, ERROR_INVALID_NAME, ERROR_LOCK_VIOLATION,
            ERROR_SHARING_VIOLATION,
        };

        for code in [
            ERROR_ACCESS_DENIED,
            ERROR_BUSY,
            ERROR_LOCK_VIOLATION,
            ERROR_SHARING_VIOLATION,
        ] {
            assert!(super::is_retryable_owned_entry_remove_error(
                &super::ProductRemovalError::Io(io::Error::from_raw_os_error(code as i32))
            ));
        }
        assert!(!super::is_retryable_owned_entry_remove_error(
            &super::ProductRemovalError::Io(io::Error::from_raw_os_error(
                ERROR_INVALID_NAME as i32
            ))
        ));
    }
}
