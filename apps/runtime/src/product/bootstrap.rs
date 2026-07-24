use std::{
    error::Error,
    fmt, fs, io,
    io::Write as _,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{CommitPhase, ProductStore, ProductStoreError};

const DESKTOP_HOST_CONFIG_NAME: &str = "desktop-host.json";
const MAX_DESKTOP_ARGUMENTS: usize = 32;
const MAX_DESKTOP_ARGUMENT_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopHostRegistration {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopHostRegistrationFile {
    schema_version: u32,
    executable: PathBuf,
    arguments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivatedProduct {
    pub product_version: String,
    pub directory: PathBuf,
    pub runtime_entrypoint: PathBuf,
    pub cli_entrypoint: PathBuf,
    pub web_assets: PathBuf,
}

pub struct ProductBootstrap {
    store: Arc<ProductStore>,
    bin_directory: PathBuf,
    shared_skills_directory: PathBuf,
    debrute_home: PathBuf,
}

impl ProductBootstrap {
    #[must_use]
    pub fn new(
        store: Arc<ProductStore>,
        bin_directory: PathBuf,
        shared_skills_directory: PathBuf,
        debrute_home: PathBuf,
    ) -> Self {
        Self {
            store,
            bin_directory,
            shared_skills_directory,
            debrute_home,
        }
    }

    /// Returns the one stable Runtime entrypoint for the selected Product.
    #[must_use]
    pub fn stable_runtime_entrypoint(&self) -> PathBuf {
        #[cfg(target_os = "macos")]
        {
            self.bin_directory.join("debrute-runtime")
        }
        #[cfg(target_os = "windows")]
        {
            self.store
                .root()
                .join("current/runtime/debrute-runtime.exe")
        }
    }

    /// Validates and activates one Desktop-carried Product seed, then installs
    /// stable user entrypoints and the matching official Skills.
    ///
    /// # Errors
    ///
    /// Returns [`ProductBootstrapError`] when any Product, stable entrypoint,
    /// Skills, or Desktop registration boundary is invalid.
    pub fn activate(
        &self,
        seed: &Path,
        desktop: Option<&DesktopHostRegistration>,
    ) -> Result<ActivatedProduct, ProductBootstrapError> {
        let pending = self.store.pending()?;
        let directory = if let Some(pending) = pending.as_ref() {
            let seed_identity = self.store.inspect_seed_identity(seed)?;
            let seed_version = seed_identity.product_version();
            let recover_old_runtime = pending.phase == CommitPhase::Staged
                && seed_version == pending.from_version
                && self.store.current_version()?.as_deref() == Some(&pending.from_version);
            if seed_version != pending.target_version && !recover_old_runtime {
                return Err(ProductBootstrapError::PendingTargetMismatch {
                    expected: pending.target_version.clone(),
                    actual: seed_version.to_owned(),
                });
            }
            self.store.validate_version(seed_version)?;
            self.store.version_path(seed_version)
        } else {
            self.store.activate_desktop_seed(seed)?
        };
        if pending.is_some() {
            return Ok(self.activated_product(directory));
        }
        self.finalize_product(directory, desktop)
    }

    /// Revalidates and publishes the selected Product's stable entrypoints and
    /// official Skills after the target Runtime owns Control and is Ready.
    ///
    /// # Errors
    ///
    /// Returns [`ProductBootstrapError`] if current is missing or any selected
    /// Product, entrypoint, Skills, or Desktop registration is invalid.
    pub fn finalize_current(
        &self,
        desktop: Option<&DesktopHostRegistration>,
    ) -> Result<ActivatedProduct, ProductBootstrapError> {
        let version = self
            .store
            .current_version()?
            .ok_or(ProductBootstrapError::CurrentProductMissing)?;
        self.store.validate_version(&version)?;
        self.finalize_product(self.store.version_path(&version), desktop)
    }

    fn finalize_product(
        &self,
        directory: PathBuf,
        desktop: Option<&DesktopHostRegistration>,
    ) -> Result<ActivatedProduct, ProductBootstrapError> {
        #[cfg(target_os = "macos")]
        let (runtime_relative, cli_relative) = (
            "runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime",
            "runtime/debrute",
        );
        #[cfg(target_os = "windows")]
        let (runtime_relative, cli_relative) =
            ("runtime/debrute-runtime.exe", "runtime/debrute.exe");
        let current = self.store.root().join("current");
        let current_runtime = current.join(runtime_relative);
        let current_cli = current.join(cli_relative);
        fs::create_dir_all(&self.bin_directory)?;
        let runtime_entrypoint = install_runtime_entrypoint(&self.bin_directory, &current_runtime)?;
        let cli_entrypoint =
            install_cli_entrypoint(&self.bin_directory, &current_cli, &runtime_entrypoint)?;
        materialize_official_skills(&directory.join("skills"), &self.shared_skills_directory)?;
        if let Some(desktop) = desktop {
            write_desktop_host_registration(&self.debrute_home, desktop)?;
        }
        Ok(ActivatedProduct {
            product_version: directory
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| ProductBootstrapError::InvalidEntrypoint(directory.clone()))?
                .to_owned(),
            web_assets: directory.join("web"),
            directory,
            runtime_entrypoint,
            cli_entrypoint,
        })
    }

    fn activated_product(&self, directory: PathBuf) -> ActivatedProduct {
        #[cfg(target_os = "windows")]
        let current = self.store.root().join("current");
        #[cfg(target_os = "macos")]
        let (runtime_entrypoint, cli_entrypoint) = (
            self.bin_directory.join("debrute-runtime"),
            self.bin_directory.join("debrute"),
        );
        #[cfg(target_os = "windows")]
        let (runtime_entrypoint, cli_entrypoint) = (
            current.join("runtime/debrute-runtime.exe"),
            self.bin_directory.join("debrute.cmd"),
        );
        ActivatedProduct {
            product_version: directory
                .file_name()
                .and_then(|name| name.to_str())
                .expect("validated Product version path is UTF-8")
                .to_owned(),
            web_assets: directory.join("web"),
            directory,
            runtime_entrypoint,
            cli_entrypoint,
        }
    }
}

/// Reads the one closed Desktop launch registration written by bootstrap.
///
/// # Errors
///
/// Returns [`ProductBootstrapError`] when an existing registration is malformed.
pub fn read_desktop_host_registration(
    debrute_home: &Path,
) -> Result<Option<DesktopHostRegistration>, ProductBootstrapError> {
    let path = debrute_home.join(DESKTOP_HOST_CONFIG_NAME);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let file: DesktopHostRegistrationFile = serde_json::from_slice(&bytes)
        .map_err(|error| ProductBootstrapError::InvalidDesktopRegistration(error.to_string()))?;
    if file.schema_version != 1 {
        return Err(ProductBootstrapError::InvalidDesktopRegistration(
            "schemaVersion must be 1".to_owned(),
        ));
    }
    let registration = DesktopHostRegistration {
        executable: file.executable,
        arguments: file.arguments,
    };
    validate_desktop_registration(&registration)?;
    Ok(Some(registration))
}

fn write_desktop_host_registration(
    debrute_home: &Path,
    registration: &DesktopHostRegistration,
) -> Result<(), ProductBootstrapError> {
    validate_desktop_registration(registration)?;
    fs::create_dir_all(debrute_home)?;
    let destination = debrute_home.join(DESKTOP_HOST_CONFIG_NAME);
    let temporary = debrute_home.join(format!(".{DESKTOP_HOST_CONFIG_NAME}-{}", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(&DesktopHostRegistrationFile {
        schema_version: 1,
        executable: registration.executable.clone(),
        arguments: registration.arguments.clone(),
    })
    .map_err(|error| ProductBootstrapError::InvalidDesktopRegistration(error.to_string()))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    #[cfg(target_os = "macos")]
    set_private_file_permissions(&temporary)?;
    replace_file(&temporary, &destination)?;
    sync_directory(debrute_home)?;
    Ok(())
}

fn validate_desktop_registration(
    registration: &DesktopHostRegistration,
) -> Result<(), ProductBootstrapError> {
    if !registration.executable.is_absolute()
        || registration.arguments.len() > MAX_DESKTOP_ARGUMENTS
        || registration
            .arguments
            .iter()
            .map(String::len)
            .sum::<usize>()
            > MAX_DESKTOP_ARGUMENT_BYTES
        || registration
            .arguments
            .iter()
            .any(|argument| argument.contains('\0'))
    {
        return Err(ProductBootstrapError::InvalidDesktopRegistration(
            "Desktop executable or arguments are outside the closed boundary".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[expect(
    clippy::unnecessary_wraps,
    reason = "both platforms share one fallible Runtime entrypoint installation contract"
)]
fn install_runtime_entrypoint(
    _bin_directory: &Path,
    current_runtime: &Path,
) -> Result<PathBuf, ProductBootstrapError> {
    Ok(current_runtime.to_owned())
}

#[cfg(target_os = "windows")]
fn install_cli_entrypoint(
    bin_directory: &Path,
    current_cli: &Path,
    runtime_entrypoint: &Path,
) -> Result<PathBuf, ProductBootstrapError> {
    let destination = bin_directory.join("debrute.cmd");
    let path = current_cli.to_string_lossy().replace('%', "%%");
    let runtime = runtime_entrypoint.to_string_lossy().replace('%', "%%");
    write_file_atomic(
        &destination,
        format!(
            "@echo off\r\nset \"DEBRUTE_RUNTIME_STABLE_ENTRYPOINT={runtime}\"\r\n\"{path}\" %*\r\n"
        )
        .as_bytes(),
    )?;
    Ok(destination)
}

#[cfg(target_os = "macos")]
fn install_cli_entrypoint(
    bin_directory: &Path,
    current_cli: &Path,
    runtime_entrypoint: &Path,
) -> Result<PathBuf, ProductBootstrapError> {
    let destination = bin_directory.join("debrute");
    let target = shell_escaped_path(current_cli)?;
    let runtime = shell_escaped_path(runtime_entrypoint)?;
    write_unix_script(
        &destination,
        &format!(
            "#!/bin/sh\nexport DEBRUTE_RUNTIME_STABLE_ENTRYPOINT='{runtime}'\nexec '{target}' \"$@\"\n"
        ),
    )?;
    Ok(destination)
}

#[cfg(target_os = "macos")]
fn install_runtime_entrypoint(
    bin_directory: &Path,
    current_runtime: &Path,
) -> Result<PathBuf, ProductBootstrapError> {
    let application = current_runtime
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| ProductBootstrapError::InvalidEntrypoint(current_runtime.to_owned()))?;
    let destination = bin_directory.join("debrute-runtime");
    let application = shell_escaped_path(application)?;
    let stable = shell_escaped_path(&destination)?;
    write_unix_script(
        &destination,
        &format!(
            "#!/bin/sh\nexec /usr/bin/open -g -n '{application}' --args \"$@\" --stable-runtime-entrypoint '{stable}'\n"
        ),
    )?;
    Ok(destination)
}

#[cfg(target_os = "macos")]
fn shell_escaped_path(path: &Path) -> Result<String, ProductBootstrapError> {
    path.to_str()
        .map(|path| path.replace('\'', "'\\''"))
        .ok_or_else(|| ProductBootstrapError::InvalidEntrypoint(path.to_owned()))
}

#[cfg(target_os = "macos")]
fn write_unix_script(destination: &Path, source: &str) -> Result<(), ProductBootstrapError> {
    use std::os::unix::fs::PermissionsExt as _;

    write_file_atomic(destination, source.as_bytes())?;
    let mut permissions = fs::metadata(destination)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(destination, permissions)?;
    Ok(())
}

fn write_file_atomic(destination: &Path, bytes: &[u8]) -> Result<(), ProductBootstrapError> {
    let parent = destination
        .parent()
        .ok_or_else(|| ProductBootstrapError::InvalidEntrypoint(destination.to_owned()))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".entrypoint-{}", Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    replace_file(&temporary, destination)?;
    sync_directory(parent)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    debrute_windows_product_fs::replace_file_atomic(source, destination)
}

#[cfg(target_os = "macos")]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
fn sync_directory(path: &Path) -> io::Result<()> {
    debrute_windows_product_fs::sync_directory(path)
}

#[cfg(target_os = "macos")]
fn sync_directory(path: &Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}

fn materialize_official_skills(
    source: &Path,
    destination: &Path,
) -> Result<(), ProductBootstrapError> {
    require_plain_directory(source)?;
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(destination)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() && is_managed_skill(&entry.path())? {
            fs::remove_dir_all(entry.path())?;
        }
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            return Err(ProductBootstrapError::InvalidSkillsPayload(entry.path()));
        }
        let source_directory = entry.path();
        if !source_directory.join("SKILL.md").is_file() {
            return Err(ProductBootstrapError::InvalidSkillsPayload(
                source_directory,
            ));
        }
        let target = destination.join(entry.file_name());
        let temporary = destination.join(format!(
            ".{}-{}",
            entry.file_name().to_string_lossy(),
            Uuid::new_v4()
        ));
        copy_plain_tree(&source_directory, &temporary)?;
        if target.exists() {
            fs::remove_dir_all(&target)?;
        }
        fs::rename(temporary, target)?;
    }
    Ok(())
}

fn is_managed_skill(directory: &Path) -> Result<bool, ProductBootstrapError> {
    let source = match fs::read_to_string(directory.join("SKILL.md")) {
        Ok(source) => source,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    Ok(source.contains("debrute.managed: \"true\"") && source.contains("debrute.package: debrute"))
}

fn copy_plain_tree(source: &Path, destination: &Path) -> Result<(), ProductBootstrapError> {
    require_plain_directory(source)?;
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_plain_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)?;
        } else {
            return Err(ProductBootstrapError::InvalidSkillsPayload(entry.path()));
        }
    }
    Ok(())
}

fn require_plain_directory(path: &Path) -> Result<(), ProductBootstrapError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(ProductBootstrapError::InvalidSkillsPayload(path.to_owned()));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_private_file_permissions(path: &Path) -> Result<(), ProductBootstrapError> {
    use std::os::unix::fs::PermissionsExt as _;
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o600);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[derive(Debug)]
pub enum ProductBootstrapError {
    Product(ProductStoreError),
    Io(io::Error),
    InvalidEntrypoint(PathBuf),
    InvalidSkillsPayload(PathBuf),
    InvalidDesktopRegistration(String),
    PendingTargetMismatch { expected: String, actual: String },
    CurrentProductMissing,
}

impl fmt::Display for ProductBootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Product bootstrap failed: {self:?}")
    }
}

impl Error for ProductBootstrapError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Product(error) => Some(error),
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ProductStoreError> for ProductBootstrapError {
    fn from(error: ProductStoreError) -> Self {
        Self::Product(error)
    }
}

impl From<io::Error> for ProductBootstrapError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt as _, path::Path};

    use sha2::{Digest as _, Sha256};

    use crate::control::{CONTROL_PROTOCOL, CONTROL_PROTOCOL_VERSION};

    use super::*;
    use crate::product::{
        CommitPlatform, ProductEntrypoints, ProductManifest, ProductManifestFile, ProductPlatform,
        ReleaseArchitecture,
    };

    #[test]
    fn desktop_seed_installs_stable_entrypoints_skills_and_closed_desktop_registration() {
        let root = std::env::temp_dir().join(format!("debrute-bootstrap-{}", Uuid::new_v4()));
        let home = root.join("home");
        let debrute_home = home.join(".debrute");
        let product_root = debrute_home.join("products");
        let bin = debrute_home.join("bin");
        let shared_skills = home.join(".agents/skills");
        let seed = write_seed(&root, "0.0.3");
        let bootstrap = ProductBootstrap::new(
            Arc::new(ProductStore::new(
                product_root.clone(),
                CommitPlatform::Macos,
                current_architecture(),
            )),
            bin.clone(),
            shared_skills.clone(),
            debrute_home.clone(),
        );
        let desktop = DesktopHostRegistration {
            executable: PathBuf::from("/Applications/Debrute.app/Contents/MacOS/debrute"),
            arguments: Vec::new(),
        };

        let activated = bootstrap.activate(&seed, Some(&desktop)).unwrap();

        assert_eq!(activated.directory, product_root.join("versions/0.0.3"));
        assert!(bin.join("debrute-runtime").is_file());
        assert!(bin.join("debrute").is_file());
        assert!(shared_skills.join("debrute-core/SKILL.md").is_file());
        assert_eq!(
            read_desktop_host_registration(&debrute_home).unwrap(),
            Some(desktop)
        );
        let runtime_entrypoint = fs::read_to_string(bin.join("debrute-runtime")).unwrap();
        assert!(runtime_entrypoint.contains("products/current/runtime/Debrute Runtime.app"));
        assert!(runtime_entrypoint.contains("/usr/bin/open -g -n"));
        assert!(runtime_entrypoint.contains("--args \"$@\""));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn desktop_seed_can_advance_but_never_downgrade_current() {
        let root = std::env::temp_dir().join(format!("debrute-bootstrap-{}", Uuid::new_v4()));
        let product_root = root.join("home/.debrute/products");
        let bootstrap = ProductBootstrap::new(
            Arc::new(ProductStore::new(
                product_root.clone(),
                CommitPlatform::Macos,
                current_architecture(),
            )),
            root.join("home/.debrute/bin"),
            root.join("home/.agents/skills"),
            root.join("home/.debrute"),
        );

        bootstrap
            .activate(&write_seed(&root, "0.0.3"), None)
            .unwrap();
        bootstrap
            .activate(&write_seed(&root, "0.0.4"), None)
            .unwrap();
        let error = bootstrap
            .activate(&write_seed(&root, "0.0.2"), None)
            .unwrap_err();

        assert!(matches!(
            error,
            ProductBootstrapError::Product(ProductStoreError::DesktopSeedOlderThanCurrent { .. })
        ));
        assert_eq!(
            ProductStore::new(product_root, CommitPlatform::Macos, current_architecture())
                .current_version()
                .unwrap()
                .as_deref(),
            Some("0.0.4")
        );
        let _ = fs::remove_dir_all(root);
    }

    fn write_seed(root: &Path, version: &str) -> PathBuf {
        let seed = root.join(format!("seed-{version}"));
        let files = [
            (
                "runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime",
                "runtime",
            ),
            ("web/index.html", "web"),
            ("runtime/debrute", "cli"),
            (
                "skills/debrute-core/SKILL.md",
                "---\nmetadata:\n  debrute.managed: \"true\"\n  debrute.package: debrute\n---\n",
            ),
            ("model-docs/models.json", "models"),
            ("native-workers/manifest.json", "worker"),
        ];
        let mut declared = Vec::new();
        for (path, contents) in files {
            let destination = seed.join(path);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::write(&destination, contents).unwrap();
            if path.ends_with("/debrute-runtime") || path == "runtime/debrute" {
                let mut permissions = fs::metadata(&destination).unwrap().permissions();
                permissions.set_mode(0o755);
                fs::set_permissions(&destination, permissions).unwrap();
            }
            declared.push(ProductManifestFile {
                path: path.to_owned(),
                size_bytes: contents.len() as u64,
                sha256: format!("{:x}", Sha256::digest(contents.as_bytes())),
            });
        }
        let manifest = ProductManifest {
            schema_version: 1,
            product: "debrute".to_owned(),
            product_version: version.to_owned(),
            control_protocol: CONTROL_PROTOCOL.to_owned(),
            control_protocol_version: CONTROL_PROTOCOL_VERSION,
            platform: ProductPlatform::Macos,
            architecture: current_architecture(),
            entrypoints: ProductEntrypoints {
                runtime: "runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime".to_owned(),
                web: "web/index.html".to_owned(),
                cli: "runtime/debrute".to_owned(),
                skills: "skills/debrute-core/SKILL.md".to_owned(),
                model_docs: "model-docs/models.json".to_owned(),
                native_workers: "native-workers/manifest.json".to_owned(),
            },
            files: declared,
        };
        fs::write(
            seed.join("product-manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        seed
    }

    const fn current_architecture() -> ReleaseArchitecture {
        if cfg!(target_arch = "aarch64") {
            ReleaseArchitecture::Arm64
        } else {
            ReleaseArchitecture::X64
        }
    }
}
