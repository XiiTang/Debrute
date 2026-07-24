use std::{error::Error, fmt, path::Path, sync::Arc};

use semver::Version;
use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

use crate::control::{CONTROL_PROTOCOL, CONTROL_PROTOCOL_VERSION};

use super::{
    manifest::{
        ReleaseArchitecture, ReleaseAssetKind, ReleasePlatform, StagedDesktopAsset,
        TrustedReleaseAsset, validate_release_version,
    },
    store::{
        CommitPlatform, ProductStore, ProductStoreError, VerifiedDesktopInstaller,
        VerifiedRuntimeEntrypoint,
    },
};

const MAX_PROJECT_ID_BYTES: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitPhase {
    Staged,
    DesktopInstalled,
    CurrentSelected,
    RuntimeReady,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductIdentity {
    product_version: String,
    platform: super::manifest::ProductPlatform,
    architecture: ReleaseArchitecture,
    control_protocol: String,
    control_protocol_version: u32,
    manifest_sha256: String,
}

impl ProductIdentity {
    pub(crate) fn new(
        product_version: String,
        platform: super::manifest::ProductPlatform,
        architecture: ReleaseArchitecture,
        control_protocol: String,
        control_protocol_version: u32,
        manifest_sha256: String,
    ) -> Self {
        Self {
            product_version,
            platform,
            architecture,
            control_protocol,
            control_protocol_version,
            manifest_sha256,
        }
    }

    #[must_use]
    pub fn product_version(&self) -> &str {
        &self.product_version
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledDesktopIdentity {
    product: ProductIdentity,
}

impl InstalledDesktopIdentity {
    #[must_use]
    pub fn new(product: ProductIdentity) -> Self {
        Self { product }
    }

    #[must_use]
    pub fn product(&self) -> &ProductIdentity {
        &self.product
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunningProductIdentity {
    Runtime(ProductIdentity),
    DesktopSeed(ProductIdentity),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResumeIntent {
    Desktop { target: ResumeTarget },
    Browser { target: ResumeTarget },
    Cli,
    Bootstrap { target: ResumeTarget },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResumeTarget {
    Root,
    Project { project_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingCommit {
    pub schema_version: u32,
    pub transaction_id: String,
    pub from_version: String,
    pub target_version: String,
    pub control_protocol: String,
    pub control_protocol_version: u32,
    pub desktop_asset: StagedDesktopAsset,
    pub resume_intent: ResumeIntent,
    pub phase: CommitPhase,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingCommitWire {
    schema_version: u32,
    transaction_id: String,
    from_version: String,
    target_version: String,
    control_protocol: String,
    control_protocol_version: u32,
    desktop_asset: StagedDesktopAssetWire,
    resume_intent: ResumeIntent,
    phase: CommitPhase,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StagedDesktopAssetWire {
    release_asset: PersistedReleaseAssetWire,
    path: std::path::PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedReleaseAssetWire {
    kind: ReleaseAssetKind,
    platform: ReleasePlatform,
    #[serde(rename = "arch")]
    architecture: ReleaseArchitecture,
    name: String,
    url: String,
    sha256: String,
    size_bytes: u64,
}

impl<'de> Deserialize<'de> for PendingCommit {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = PendingCommitWire::deserialize(deserializer)?;
        Ok(Self {
            schema_version: wire.schema_version,
            transaction_id: wire.transaction_id,
            from_version: wire.from_version,
            target_version: wire.target_version,
            control_protocol: wire.control_protocol,
            control_protocol_version: wire.control_protocol_version,
            desktop_asset: StagedDesktopAsset::new(
                TrustedReleaseAsset::restore(
                    wire.desktop_asset.release_asset.kind,
                    wire.desktop_asset.release_asset.platform,
                    wire.desktop_asset.release_asset.architecture,
                    wire.desktop_asset.release_asset.name,
                    wire.desktop_asset.release_asset.url,
                    wire.desktop_asset.release_asset.sha256,
                    wire.desktop_asset.release_asset.size_bytes,
                ),
                wire.desktop_asset.path,
            ),
            resume_intent: wire.resume_intent,
            phase: wire.phase,
        })
    }
}

impl PendingCommit {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("schemaVersion must be 1".to_owned());
        }
        let transaction_id = Uuid::parse_str(&self.transaction_id)
            .map_err(|_| "transactionId must be a canonical UUID".to_owned())?;
        if transaction_id.hyphenated().to_string() != self.transaction_id {
            return Err("transactionId must be a canonical UUID".to_owned());
        }
        validate_release_version(&self.from_version).map_err(|error| error.to_string())?;
        validate_release_version(&self.target_version).map_err(|error| error.to_string())?;
        if Version::parse(&self.target_version).expect("validated target version")
            <= Version::parse(&self.from_version).expect("validated from version")
        {
            return Err("targetVersion must be newer than fromVersion".to_owned());
        }
        if self.control_protocol != CONTROL_PROTOCOL
            || self.control_protocol_version != CONTROL_PROTOCOL_VERSION
        {
            return Err("Control protocol identity is incompatible".to_owned());
        }
        if !self
            .desktop_asset
            .release_asset
            .matches_product_version(&self.target_version)
        {
            return Err("Desktop asset does not match targetVersion".to_owned());
        }
        validate_resume_intent(&self.resume_intent)
    }

    pub(crate) fn same_transaction_as(&self, other: &Self) -> bool {
        self.schema_version == other.schema_version
            && self.transaction_id == other.transaction_id
            && self.from_version == other.from_version
            && self.target_version == other.target_version
            && self.control_protocol == other.control_protocol
            && self.control_protocol_version == other.control_protocol_version
            && self.desktop_asset == other.desktop_asset
            && self.resume_intent == other.resume_intent
    }
}

pub(crate) mod sealed {
    pub trait Sealed {}
}

pub trait UpdatePlatformAdapter: sealed::Sealed + Send + Sync {
    /// Installs the exact signed Desktop bytes represented by the held-open
    /// file. The implementation must consume that handle (for example through
    /// `/dev/fd` on macOS) or keep it locked against replacement until the
    /// native installer has consumed the same file identity. It must not reopen
    /// the path and trust those potentially different bytes.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] when native installation or exact version
    /// inspection fails.
    fn install_desktop(
        &self,
        installer: VerifiedDesktopInstaller,
    ) -> Result<(), ProductCommitError>;

    /// Reads the installed Desktop product version without changing the
    /// installation. This lets the exact target Desktop seed attest an install
    /// that completed just before the old Runtime crashed.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] when native Desktop identity cannot be
    /// inspected exactly.
    fn installed_desktop_identity(&self) -> Result<InstalledDesktopIdentity, ProductCommitError>;

    /// Returns the complete identity derived from this process's trusted
    /// startup context. Implementations must never build it from Control or HTTP
    /// request data.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] when the running executable or embedded
    /// seed identity cannot be inspected exactly.
    fn running_product_identity(&self) -> Result<RunningProductIdentity, ProductCommitError>;

    /// Launches the selected Runtime from the held-open manifest-authenticated
    /// entrypoint. The same-handle requirement as [`Self::install_desktop`]
    /// applies until the operating system has consumed the executable image.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] if the native process cannot be launched.
    fn launch_runtime(
        &self,
        product_version: &str,
        entrypoint: VerifiedRuntimeEntrypoint,
    ) -> Result<(), ProductCommitError>;

    /// Claims and dispatches exactly the persisted initiating-surface
    /// continuation after the target Runtime is Ready. The implementation must
    /// durably claim `transaction_id` before native dispatch and return success
    /// without redispatching when the same ID is delivered after restart.
    /// A crash after the durable claim may suppress the convenience relaunch;
    /// this deliberate at-most-once boundary avoids duplicate windows and tabs,
    /// and must never be replaced by in-memory deduplication or automatic replay.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] if the requested native continuation
    /// cannot be dispatched.
    fn resume(&self, transaction_id: &str, intent: &ResumeIntent)
    -> Result<(), ProductCommitError>;
}

pub struct ProductCommitCoordinator<P> {
    store: Arc<ProductStore>,
    platform: P,
}

impl<P: UpdatePlatformAdapter> ProductCommitCoordinator<P> {
    #[must_use]
    pub fn new(store: Arc<ProductStore>, platform: P) -> Self {
        Self { store, platform }
    }

    /// Records the one bounded commit after the target product has been fully
    /// materialized and revalidated.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] if another commit exists, no current
    /// product is selected, target identity is incompatible, or persistence
    /// fails.
    pub fn begin(
        &self,
        staged_product: &Path,
        desktop_asset: StagedDesktopAsset,
        resume_intent: ResumeIntent,
    ) -> Result<String, ProductCommitError> {
        let _transaction = self.store.lock_transaction()?;
        if self.store.pending_unlocked()?.is_some() {
            return Err(ProductCommitError::PendingCommitExists);
        }
        let from_version = self
            .store
            .current_version_unlocked()?
            .ok_or(ProductCommitError::CurrentProductMissing)?;
        let target_version = staged_product
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| ProductCommitError::InvalidStagedProduct(staged_product.to_path_buf()))?
            .to_owned();
        if self.store.version_path(&target_version) != staged_product {
            return Err(ProductCommitError::InvalidStagedProduct(
                staged_product.to_path_buf(),
            ));
        }
        let manifest = self.store.validate_version_unlocked(&target_version)?;
        if manifest.product_version != target_version
            || manifest.control_protocol != CONTROL_PROTOCOL
            || manifest.control_protocol_version != CONTROL_PROTOCOL_VERSION
        {
            return Err(ProductCommitError::IncompatibleTargetProduct);
        }
        let from = Version::parse(&from_version)
            .map_err(|_| ProductCommitError::InvalidCurrentVersion(from_version.clone()))?;
        let target = Version::parse(&target_version)
            .map_err(|_| ProductCommitError::InvalidTargetVersion(target_version.clone()))?;
        if target <= from
            || !desktop_asset
                .release_asset
                .matches_product_version(&target_version)
        {
            return Err(ProductCommitError::IncompatibleTargetProduct);
        }
        if !asset_matches_platform(desktop_asset.release_asset(), self.store.platform()) {
            return Err(ProductCommitError::DesktopAssetPlatformMismatch);
        }
        if manifest.architecture != self.store.architecture()
            || desktop_asset.release_asset().architecture() != self.store.architecture()
        {
            return Err(ProductCommitError::DesktopAssetPlatformMismatch);
        }
        self.store
            .validate_staged_desktop_asset_unlocked(&desktop_asset, &target_version)?;
        validate_resume_intent(&resume_intent).map_err(ProductCommitError::InvalidResumeIntent)?;
        let transaction_id = Uuid::new_v4().to_string();
        self.store.write_pending_unlocked(&PendingCommit {
            schema_version: 1,
            transaction_id: transaction_id.clone(),
            from_version,
            target_version,
            control_protocol: CONTROL_PROTOCOL.to_owned(),
            control_protocol_version: CONTROL_PROTOCOL_VERSION,
            desktop_asset,
            resume_intent,
            phase: CommitPhase::Staged,
        })?;
        Ok(transaction_id)
    }

    /// Installs the matching Desktop and durably advances only the pending
    /// commit phase.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] for an unauthorized running identity,
    /// wrong phase, installer failure, or installed version mismatch. On every
    /// error, `current` remains unchanged.
    pub(crate) fn install_desktop(&self) -> Result<(), ProductCommitError> {
        let _transaction = self.store.lock_transaction()?;
        let mut pending = self.required_pending()?;
        if pending.phase != CommitPhase::Staged {
            return Err(ProductCommitError::UnexpectedCommitPhase {
                expected: CommitPhase::Staged,
                actual: pending.phase,
            });
        }
        let running = self.platform.running_product_identity()?;
        self.authorize_running_product(&pending, &running, CommitPhase::Staged)?;
        self.store.validate_staged_desktop_asset_unlocked(
            &pending.desktop_asset,
            &pending.target_version,
        )?;
        let mut installed = self.platform.installed_desktop_identity()?;
        if !desktop_identity_matches(
            &installed,
            &pending,
            &self.expected_identity(&pending.target_version)?,
        ) && matches!(running, RunningProductIdentity::Runtime(_))
        {
            let verified_asset = self.store.open_verified_desktop_installer_unlocked(
                &pending.desktop_asset,
                &pending.target_version,
            )?;
            self.platform.install_desktop(verified_asset)?;
            installed = self.platform.installed_desktop_identity()?;
        }
        let expected = self.expected_identity(&pending.target_version)?;
        if !desktop_identity_matches(&installed, &pending, &expected) {
            return Err(ProductCommitError::DesktopVersionMismatch {
                expected: pending.target_version,
                actual: installed.product.product_version,
            });
        }
        pending.phase = CommitPhase::DesktopInstalled;
        self.store.write_pending_unlocked(&pending)?;
        Ok(())
    }

    /// Atomically retargets `current` only after matching Desktop installation
    /// has been durably confirmed.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] for an unauthorized identity, wrong phase,
    /// corrupt target product, or pointer replacement failure.
    pub(crate) fn select_current(&self) -> Result<(), ProductCommitError> {
        let _transaction = self.store.lock_transaction()?;
        let mut pending = self.required_pending()?;
        if pending.phase != CommitPhase::DesktopInstalled {
            return Err(ProductCommitError::UnexpectedCommitPhase {
                expected: CommitPhase::DesktopInstalled,
                actual: pending.phase,
            });
        }
        let running = self.platform.running_product_identity()?;
        self.authorize_running_product(&pending, &running, CommitPhase::DesktopInstalled)?;
        let target = self.store.version_path(&pending.target_version);
        self.store.select_current_unlocked(&target)?;
        pending.phase = CommitPhase::CurrentSelected;
        self.store.write_pending_unlocked(&pending)?;
        Ok(())
    }

    /// Continues the single transaction forward from its durable phase and
    /// launches only the selected target Runtime. It never rolls back or chooses
    /// another version.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] if identity authorization, installation,
    /// selection, target validation, or launch fails.
    pub fn continue_commit(&self) -> Result<(), ProductCommitError> {
        let pending = self
            .store
            .pending()?
            .ok_or(ProductCommitError::PendingCommitMissing)?;
        let transaction_id = pending.transaction_id.clone();
        let running = self.platform.running_product_identity()?;
        self.authorize_running_product(&pending, &running, pending.phase)?;
        if pending.phase == CommitPhase::Staged {
            self.install_desktop()?;
        }
        let phase = self
            .store
            .pending()?
            .ok_or(ProductCommitError::PendingCommitMissing)?
            .phase;
        if phase == CommitPhase::DesktopInstalled {
            self.select_current()?;
        }
        let _transaction = self.store.lock_transaction()?;
        let pending = self.required_pending()?;
        if pending.transaction_id != transaction_id {
            return Err(ProductCommitError::PendingCommitChanged);
        }
        if pending.phase != CommitPhase::CurrentSelected {
            return Err(ProductCommitError::UnexpectedCommitPhase {
                expected: CommitPhase::CurrentSelected,
                actual: pending.phase,
            });
        }
        let running = self.platform.running_product_identity()?;
        self.authorize_running_product(&pending, &running, CommitPhase::CurrentSelected)?;
        let current = self
            .store
            .current_version_unlocked()?
            .ok_or(ProductCommitError::CurrentProductMissing)?;
        if current != pending.target_version {
            return Err(ProductCommitError::CurrentProductMismatch {
                expected: pending.target_version,
                actual: current,
            });
        }
        let entrypoint = self
            .store
            .open_verified_runtime_unlocked(&pending.target_version)?;
        self.platform
            .launch_runtime(&pending.target_version, entrypoint)
    }

    /// Completes the transaction only after the selected target Runtime reports
    /// Ready, removes the previous product, durably records the Ready cut, and
    /// idempotently dispatches the fixed initiating-surface continuation before
    /// removing pending state.
    ///
    /// # Errors
    ///
    /// Returns [`ProductCommitError`] if the Ready reporter is not the exact
    /// target, `current` disagrees, cleanup fails, or continuation dispatch
    /// fails.
    pub fn complete_ready(&self) -> Result<(), ProductCommitError> {
        let (transaction_id, resume_intent) = {
            let _transaction = self.store.lock_transaction()?;
            let mut pending = self.required_pending()?;
            if !matches!(
                pending.phase,
                CommitPhase::CurrentSelected | CommitPhase::RuntimeReady
            ) {
                return Err(ProductCommitError::UnexpectedCommitPhase {
                    expected: CommitPhase::CurrentSelected,
                    actual: pending.phase,
                });
            }
            let running = self.platform.running_product_identity()?;
            let RunningProductIdentity::Runtime(ready_identity) = running else {
                return Err(ProductCommitError::TargetRuntimeNotReady {
                    expected: pending.target_version,
                    actual: "desktop_seed".to_owned(),
                });
            };
            let expected_ready = self.expected_identity(&pending.target_version)?;
            if ready_identity != expected_ready {
                return Err(ProductCommitError::TargetRuntimeNotReady {
                    expected: pending.target_version,
                    actual: ready_identity.product_version,
                });
            }
            let current = self
                .store
                .current_version_unlocked()?
                .ok_or(ProductCommitError::CurrentProductMissing)?;
            if current != pending.target_version {
                return Err(ProductCommitError::CurrentProductMismatch {
                    expected: pending.target_version,
                    actual: current,
                });
            }
            self.store
                .validate_version_unlocked(&expected_ready.product_version)?;
            if pending.phase == CommitPhase::CurrentSelected {
                self.store.remove_version_unlocked(&pending.from_version)?;
                pending.phase = CommitPhase::RuntimeReady;
                self.store.write_pending_unlocked(&pending)?;
            }
            (pending.transaction_id, pending.resume_intent)
        };
        self.platform.resume(&transaction_id, &resume_intent)?;
        let _transaction = self.store.lock_transaction()?;
        let pending = self.required_pending()?;
        if pending.transaction_id != transaction_id || pending.phase != CommitPhase::RuntimeReady {
            return Err(ProductCommitError::PendingCommitChanged);
        }
        self.store.clear_pending_unlocked(&pending.target_version)?;
        Ok(())
    }

    fn required_pending(&self) -> Result<PendingCommit, ProductCommitError> {
        self.store
            .pending_unlocked()?
            .ok_or(ProductCommitError::PendingCommitMissing)
    }

    fn expected_identity(
        &self,
        product_version: &str,
    ) -> Result<ProductIdentity, ProductCommitError> {
        Ok(self.store.product_identity_unlocked(product_version)?)
    }

    fn authorize_running_product(
        &self,
        pending: &PendingCommit,
        running: &RunningProductIdentity,
        phase: CommitPhase,
    ) -> Result<(), ProductCommitError> {
        let expected_version = if phase == CommitPhase::RuntimeReady {
            &pending.target_version
        } else {
            match running {
                RunningProductIdentity::Runtime(_) => &pending.from_version,
                RunningProductIdentity::DesktopSeed(_) => &pending.target_version,
            }
        };
        let expected = self.expected_identity(expected_version)?;
        let actual = match running {
            RunningProductIdentity::Runtime(identity)
            | RunningProductIdentity::DesktopSeed(identity) => identity,
        };
        if actual == &expected
            && !(phase == CommitPhase::RuntimeReady
                && matches!(running, RunningProductIdentity::DesktopSeed(_)))
        {
            Ok(())
        } else {
            Err(ProductCommitError::RecoveryIdentityDenied {
                phase,
                actual: actual.clone(),
            })
        }
    }
}

fn desktop_identity_matches(
    installed: &InstalledDesktopIdentity,
    _pending: &PendingCommit,
    expected_product: &ProductIdentity,
) -> bool {
    &installed.product == expected_product
}

fn validate_resume_intent(intent: &ResumeIntent) -> Result<(), String> {
    match intent {
        ResumeIntent::Desktop { target }
        | ResumeIntent::Browser { target }
        | ResumeIntent::Bootstrap { target } => validate_resume_target(target),
        ResumeIntent::Cli => Ok(()),
    }
}

fn validate_resume_target(target: &ResumeTarget) -> Result<(), String> {
    match target {
        ResumeTarget::Root => Ok(()),
        ResumeTarget::Project { project_id }
            if !project_id.trim().is_empty() && project_id.len() <= MAX_PROJECT_ID_BYTES =>
        {
            Ok(())
        }
        ResumeTarget::Project { .. } => Err("Project resume id must be non-empty".to_owned()),
    }
}

fn asset_matches_platform(asset: &TrustedReleaseAsset, platform: CommitPlatform) -> bool {
    matches!(
        (asset.platform(), platform),
        (ReleasePlatform::Macos, CommitPlatform::Macos)
            | (ReleasePlatform::Windows, CommitPlatform::Windows)
    )
}

#[derive(Debug)]
pub enum ProductCommitError {
    Store(ProductStoreError),
    PendingCommitExists,
    PendingCommitMissing,
    CurrentProductMissing,
    InvalidCurrentVersion(String),
    InvalidTargetVersion(String),
    InvalidStagedProduct(std::path::PathBuf),
    IncompatibleTargetProduct,
    DesktopAssetPlatformMismatch,
    InvalidResumeIntent(String),
    UnexpectedCommitPhase {
        expected: CommitPhase,
        actual: CommitPhase,
    },
    RecoveryIdentityDenied {
        phase: CommitPhase,
        actual: ProductIdentity,
    },
    DesktopVersionMismatch {
        expected: String,
        actual: String,
    },
    TargetRuntimeNotReady {
        expected: String,
        actual: String,
    },
    CurrentProductMismatch {
        expected: String,
        actual: String,
    },
    PendingCommitChanged,
    Platform(String),
}

impl fmt::Display for ProductCommitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(error) => write!(formatter, "product commit store failed: {error}"),
            other => write!(formatter, "product commit rejected: {other:?}"),
        }
    }
}

impl Error for ProductCommitError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Store(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ProductStoreError> for ProductCommitError {
    fn from(error: ProductStoreError) -> Self {
        Self::Store(error)
    }
}
