use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fmt,
    fs::{self, File},
    io::{self, Read as _, Seek as _, SeekFrom, Write as _},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use fs2::FileExt as _;
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

use super::{
    commit::{CommitPhase, PendingCommit, ProductIdentity, ResumeIntent},
    manifest::{
        DEBRUTE_UPDATE_PUBLIC_KEY_BYTES, PRODUCT_MANIFEST_NAME, ProductManifest,
        ProductManifestError, ProductPlatform, RELEASE_MANIFEST_NAME, RELEASE_SIGNATURE_NAME,
        ReleaseArchitecture, ReleaseAssetKind, ReleasePlatform, StagedDesktopAsset,
        StagedProductArchive, TrustedReleaseAsset, TrustedReleaseManifest,
        validate_release_version, verify_signed_release_manifest,
    },
};

const PRODUCT_MANIFEST_MAX_BYTES: u64 = 4 * 1024 * 1024;
const PENDING_STATE_MAX_BYTES: u64 = 1024 * 1024;
const RELEASE_MANIFEST_MAX_BYTES: u64 = 256 * 1024;
const RELEASE_SIGNATURE_MAX_BYTES: u64 = 8 * 1024;
const PENDING_COMMIT_DIRECTORY: &str = "pending-commit";
const RESUME_RECEIPT_DIRECTORY: &str = "resume-receipts";
const PENDING_PHASE_FILES: [(CommitPhase, &str); 4] = [
    (CommitPhase::Staged, "0-staged.json"),
    (CommitPhase::DesktopInstalled, "1-desktop-installed.json"),
    (CommitPhase::CurrentSelected, "2-current-selected.json"),
    (CommitPhase::RuntimeReady, "3-runtime-ready.json"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitPlatform {
    Macos,
    Windows,
}

pub struct ProductStore {
    root: PathBuf,
    platform: CommitPlatform,
    architecture: ReleaseArchitecture,
    update_public_key: [u8; 32],
    transaction: Mutex<()>,
}

pub(crate) struct ProductTransactionGuard<'a> {
    _process_guard: MutexGuard<'a, ()>,
    lock_file: File,
}

/// One exact staged Desktop installer whose signed bytes are held open for the
/// whole native installation call. The platform adapter must install from this
/// handle, not reopen [`Self::path`].
#[derive(Debug)]
pub struct VerifiedDesktopInstaller {
    staged: StagedDesktopAsset,
    file: File,
}

impl VerifiedDesktopInstaller {
    #[must_use]
    pub fn staged(&self) -> &StagedDesktopAsset {
        &self.staged
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        self.staged.path()
    }

    #[must_use]
    pub fn file(&self) -> &File {
        &self.file
    }
}

/// One exact Runtime entrypoint whose manifest-authenticated bytes are held
/// open for the whole process-launch call. The platform adapter must launch
/// this handle (or keep it locked against replacement until native launch has
/// consumed the same file identity), not reopen [`Self::path`].
#[derive(Debug)]
pub struct VerifiedRuntimeEntrypoint {
    path: PathBuf,
    file: File,
}

impl VerifiedRuntimeEntrypoint {
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub fn file(&self) -> &File {
        &self.file
    }
}

impl Drop for ProductTransactionGuard<'_> {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.lock_file);
    }
}

impl ProductStore {
    #[must_use]
    pub fn new(root: PathBuf, platform: CommitPlatform, architecture: ReleaseArchitecture) -> Self {
        Self::new_with_update_public_key(
            root,
            platform,
            architecture,
            DEBRUTE_UPDATE_PUBLIC_KEY_BYTES,
        )
    }

    #[must_use]
    pub(crate) fn new_with_update_public_key(
        root: PathBuf,
        platform: CommitPlatform,
        architecture: ReleaseArchitecture,
        update_public_key: [u8; 32],
    ) -> Self {
        Self {
            root,
            platform,
            architecture,
            update_public_key,
            transaction: Mutex::new(()),
        }
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn platform(&self) -> CommitPlatform {
        self.platform
    }

    pub(crate) fn architecture(&self) -> ReleaseArchitecture {
        self.architecture
    }

    #[must_use]
    pub fn version_path(&self, product_version: &str) -> PathBuf {
        self.root.join("versions").join(product_version)
    }

    /// Copies and validates one complete seed before atomically publishing its
    /// immutable version directory.
    ///
    /// # Errors
    ///
    /// Returns [`ProductStoreError`] if the seed contract, file inventory,
    /// digest, destination, or filesystem operation is invalid.
    pub fn materialize_seed(&self, seed: &Path) -> Result<PathBuf, ProductStoreError> {
        let _transaction = self.lock_transaction()?;
        self.materialize_seed_unlocked(seed)
    }

    /// Copies one downloaded Desktop installer into its immutable update slot
    /// only after the signed size and SHA-256 both match.
    ///
    /// # Errors
    ///
    /// Returns [`ProductStoreError`] if release identity, source type, signed
    /// size or digest, destination state, or filesystem persistence is invalid.
    pub fn stage_desktop_asset(
        &self,
        release_manifest: &TrustedReleaseManifest,
        platform: ReleasePlatform,
        architecture: ReleaseArchitecture,
        downloaded_path: &Path,
    ) -> Result<StagedDesktopAsset, ProductStoreError> {
        let _transaction = self.lock_transaction()?;
        let (release_asset, destination) = self.stage_release_asset_unlocked(
            release_manifest,
            ReleaseAssetKind::Desktop,
            platform,
            architecture,
            downloaded_path,
        )?;
        Ok(StagedDesktopAsset::new(release_asset, destination))
    }

    /// Copies one downloaded complete Product archive into the same immutable
    /// signed update slot as its matching Desktop installer.
    ///
    /// # Errors
    ///
    /// Returns [`ProductStoreError`] under the same platform, identity, size,
    /// digest, and persistence conditions as [`Self::stage_desktop_asset`].
    pub fn stage_product_archive(
        &self,
        release_manifest: &TrustedReleaseManifest,
        platform: ReleasePlatform,
        architecture: ReleaseArchitecture,
        downloaded_path: &Path,
    ) -> Result<StagedProductArchive, ProductStoreError> {
        let _transaction = self.lock_transaction()?;
        let (release_asset, destination) = self.stage_release_asset_unlocked(
            release_manifest,
            ReleaseAssetKind::Product,
            platform,
            architecture,
            downloaded_path,
        )?;
        Ok(StagedProductArchive::new(release_asset, destination))
    }

    fn stage_release_asset_unlocked(
        &self,
        release_manifest: &TrustedReleaseManifest,
        kind: ReleaseAssetKind,
        platform: ReleasePlatform,
        architecture: ReleaseArchitecture,
        downloaded_path: &Path,
    ) -> Result<(TrustedReleaseAsset, PathBuf), ProductStoreError> {
        if !matches!(
            (platform, self.platform),
            (ReleasePlatform::Macos, CommitPlatform::Macos)
                | (ReleasePlatform::Windows, CommitPlatform::Windows)
        ) || architecture != self.architecture
        {
            return Err(ProductStoreError::ProductPlatformMismatch);
        }
        let reverified = verify_signed_release_manifest(
            release_manifest.manifest_bytes(),
            release_manifest.signature_text(),
            &self.update_public_key,
        )
        .map_err(|error| ProductStoreError::InvalidStagedAsset(error.to_string()))?;
        let release_asset = reverified
            .asset_for(kind, platform, architecture)
            .ok_or_else(|| {
                ProductStoreError::InvalidStagedAsset(
                    "signed manifest does not contain the selected target".to_owned(),
                )
            })?;
        let product_version = reverified.version();
        validate_exact_file(downloaded_path, release_asset)?;
        let updates = self.root.join("updates");
        ensure_managed_directory(&updates)?;
        let directory = updates.join(product_version);
        let destination = directory.join(release_asset.name());
        ensure_managed_directory(&directory)?;
        ensure_immutable_file(
            &directory.join(RELEASE_MANIFEST_NAME),
            release_manifest.manifest_bytes(),
        )?;
        ensure_immutable_file(
            &directory.join(RELEASE_SIGNATURE_NAME),
            release_manifest.signature_text().as_bytes(),
        )?;
        if destination.exists() {
            validate_exact_file(&destination, release_asset)?;
            return Ok((release_asset.clone(), destination));
        }
        let temporary = directory.join(format!(".asset-{}", Uuid::new_v4()));
        fs::copy(downloaded_path, &temporary)?;
        if let Err(error) = validate_exact_file(&temporary, release_asset).and_then(|()| {
            File::open(&temporary)?.sync_all()?;
            fs::rename(&temporary, &destination)?;
            sync_directory(&directory)
        }) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        Ok((release_asset.clone(), destination))
    }

    /// Revalidates the complete immutable file inventory of a materialized
    /// product version.
    ///
    /// # Errors
    ///
    /// Returns [`ProductStoreError`] for an invalid version string, missing or
    /// undeclared file, digest mismatch, symlink, or incompatible manifest.
    pub fn validate_version(
        &self,
        product_version: &str,
    ) -> Result<ProductManifest, ProductStoreError> {
        let _transaction = self.lock_transaction()?;
        self.validate_version_unlocked(product_version)
    }

    /// Materializes the exact seed carried by an already installed Desktop and
    /// selects it only when it is the same as, or newer than, the active
    /// Product. A signed older Desktop can never downgrade `current`.
    ///
    /// # Errors
    ///
    /// Returns [`ProductStoreError`] when the seed is invalid, older than the
    /// active Product, or cannot be selected atomically.
    pub fn activate_desktop_seed(&self, seed: &Path) -> Result<PathBuf, ProductStoreError> {
        let _transaction = self.lock_transaction()?;
        let version_path = self.materialize_seed_unlocked(seed)?;
        let seed_version = version_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| ProductStoreError::InvalidVersionPath(version_path.clone()))?;
        if let Some(current_version) = self.current_version_unlocked()? {
            let current = semver::Version::parse(&current_version)
                .map_err(|_| ProductStoreError::InvalidCurrentPointer(self.root.join("current")))?;
            let seed = semver::Version::parse(seed_version)
                .map_err(|_| ProductStoreError::InvalidVersionPath(version_path.clone()))?;
            if seed < current {
                return Err(ProductStoreError::DesktopSeedOlderThanCurrent {
                    seed: seed_version.to_owned(),
                    current: current_version,
                });
            }
            if seed == current {
                self.validate_version_unlocked(seed_version)?;
                return Ok(version_path);
            }
        }
        self.select_current_unlocked(&version_path)?;
        Ok(version_path)
    }

    /// Reads the selected product version from the native stable pointer.
    ///
    /// # Errors
    ///
    /// Returns [`ProductStoreError`] when the pointer is malformed or cannot be
    /// read.
    pub fn current_version(&self) -> Result<Option<String>, ProductStoreError> {
        let _transaction = self.lock_transaction()?;
        self.current_version_unlocked()
    }

    /// Reads the one bounded pending commit, if present.
    ///
    /// # Errors
    ///
    /// Returns [`ProductStoreError`] if the record is malformed or incompatible
    /// with the current product contract.
    pub fn pending(&self) -> Result<Option<PendingCommit>, ProductStoreError> {
        let _transaction = self.lock_transaction()?;
        self.pending_unlocked()
    }

    /// Returns the complete manifest-derived identity of one materialized
    /// Product version.
    ///
    /// # Errors
    ///
    /// Returns [`ProductStoreError`] when the version or any declared file is
    /// unavailable, incompatible, or changed.
    pub fn product_identity(
        &self,
        product_version: &str,
    ) -> Result<ProductIdentity, ProductStoreError> {
        let _transaction = self.lock_transaction()?;
        self.product_identity_unlocked(product_version)
    }

    /// Validates an installed Desktop seed in place and returns its complete
    /// identity without publishing or selecting it.
    ///
    /// # Errors
    ///
    /// Returns [`ProductStoreError`] when the seed contract, platform, file
    /// inventory, or hashes are invalid.
    pub fn inspect_seed_identity(&self, seed: &Path) -> Result<ProductIdentity, ProductStoreError> {
        let _transaction = self.lock_transaction()?;
        self.inspect_seed_identity_unlocked(seed)
    }

    pub(crate) fn inspect_seed_identity_unlocked(
        &self,
        seed: &Path,
    ) -> Result<ProductIdentity, ProductStoreError> {
        let manifest = read_product_manifest(seed)?;
        validate_product_platform(&manifest, self.platform, self.architecture)?;
        validate_product_directory(seed, &manifest)?;
        let manifest_sha256 = sha256_file(&seed.join(PRODUCT_MANIFEST_NAME))?;
        Ok(ProductIdentity::new(
            manifest.product_version,
            manifest.platform,
            manifest.architecture,
            manifest.control_protocol,
            manifest.control_protocol_version,
            manifest_sha256,
        ))
    }

    pub(crate) fn lock_transaction(
        &self,
    ) -> Result<ProductTransactionGuard<'_>, ProductStoreError> {
        let process_guard = self
            .transaction
            .lock()
            .expect("Product transaction lock poisoned");
        if !self.root.is_absolute() {
            return Err(ProductStoreError::InvalidProductRoot(self.root.clone()));
        }
        fs::create_dir_all(&self.root)?;
        require_managed_directory(&self.root)?;
        let lock_path = self.root.join(".product.lock");
        match fs::symlink_metadata(&lock_path) {
            Ok(metadata) if metadata.file_type().is_file() => {}
            Ok(_) => return Err(ProductStoreError::ManagedPathType(lock_path)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let lock_file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        lock_file.lock_exclusive()?;
        cleanup_abandoned_transaction_artifacts(&self.root, self.platform)?;
        cleanup_retired_pending(&self.root)?;
        Ok(ProductTransactionGuard {
            _process_guard: process_guard,
            lock_file,
        })
    }

    pub(crate) fn materialize_seed_unlocked(
        &self,
        seed: &Path,
    ) -> Result<PathBuf, ProductStoreError> {
        let manifest = read_product_manifest(seed)?;
        validate_product_platform(&manifest, self.platform, self.architecture)?;
        validate_product_directory(seed, &manifest)?;
        let destination = self.version_path(&manifest.product_version);
        if destination.exists() {
            let existing = self.validate_version_unlocked(&manifest.product_version)?;
            if existing == manifest {
                return Ok(destination);
            }
            return Err(ProductStoreError::MaterializedVersionConflict(
                manifest.product_version,
            ));
        }
        ensure_managed_directory(&self.root.join("versions"))?;
        let staging = self.root.join(format!(
            ".staging-{}--{}",
            manifest.product_version,
            Uuid::new_v4()
        ));
        if let Err(error) = copy_tree(seed, &staging)
            .and_then(|()| validate_product_directory(&staging, &manifest))
            .and_then(|()| {
                sync_tree(&staging)?;
                fs::rename(&staging, &destination)?;
                sync_directory(destination.parent().expect("version parent exists"))
            })
        {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        Ok(destination)
    }

    pub(crate) fn validate_version_unlocked(
        &self,
        product_version: &str,
    ) -> Result<ProductManifest, ProductStoreError> {
        let path = self.version_path(product_version);
        require_managed_directory(&self.root.join("versions"))?;
        require_managed_directory(&path)?;
        let manifest = read_product_manifest(&path)?;
        validate_product_platform(&manifest, self.platform, self.architecture)?;
        if manifest.product_version != product_version {
            return Err(ProductStoreError::VersionPathMismatch {
                expected: product_version.to_owned(),
                actual: manifest.product_version,
            });
        }
        validate_product_directory(&path, &manifest)?;
        Ok(manifest)
    }

    pub(crate) fn product_identity_unlocked(
        &self,
        product_version: &str,
    ) -> Result<ProductIdentity, ProductStoreError> {
        let manifest = self.validate_version_unlocked(product_version)?;
        let manifest_sha256 = sha256_file(
            &self
                .version_path(product_version)
                .join(PRODUCT_MANIFEST_NAME),
        )?;
        Ok(ProductIdentity::new(
            manifest.product_version,
            manifest.platform,
            manifest.architecture,
            manifest.control_protocol,
            manifest.control_protocol_version,
            manifest_sha256,
        ))
    }

    pub(crate) fn select_current_unlocked(
        &self,
        version_path: &Path,
    ) -> Result<(), ProductStoreError> {
        let version = version_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| ProductStoreError::InvalidVersionPath(version_path.to_path_buf()))?;
        let expected = self.version_path(version);
        if expected != version_path {
            return Err(ProductStoreError::InvalidVersionPath(
                version_path.to_path_buf(),
            ));
        }
        self.validate_version_unlocked(version)?;
        require_managed_directory(&self.root)?;
        let temporary = self.root.join(format!(".current-{}", Uuid::new_v4()));
        let target = Path::new("versions").join(version);
        create_native_pointer(self.platform, &target, &temporary)?;
        let current = self.root.join("current");
        replace_native_pointer(self.platform, &temporary, &current)?;
        sync_directory(&self.root)?;
        Ok(())
    }

    pub(crate) fn current_version_unlocked(&self) -> Result<Option<String>, ProductStoreError> {
        let current = self.root.join("current");
        match fs::symlink_metadata(&current) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        let target = read_native_pointer(self.platform, &current)?;
        managed_pointer_version(&target).map(Some)
    }

    pub(crate) fn pending_unlocked(&self) -> Result<Option<PendingCommit>, ProductStoreError> {
        let directory = self.root.join(PENDING_COMMIT_DIRECTORY);
        let entries = match require_managed_directory(&directory)
            .and_then(|()| fs::read_dir(&directory).map_err(ProductStoreError::from))
        {
            Ok(entries) => entries,
            Err(ProductStoreError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let allowed = PENDING_PHASE_FILES
            .iter()
            .map(|(_, name)| *name)
            .collect::<HashSet<_>>();
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err(ProductStoreError::InvalidPendingCommit(
                    "pending state filename must be UTF-8".to_owned(),
                ));
            };
            if name.starts_with(".tmp-") && entry.file_type()?.is_file() {
                fs::remove_file(entry.path())?;
                continue;
            }
            if !allowed.contains(name) || !entry.file_type()?.is_file() {
                return Err(ProductStoreError::InvalidPendingCommit(format!(
                    "unexpected pending state entry: {name}"
                )));
            }
        }
        let mut latest: Option<PendingCommit> = None;
        let mut missing_phase_seen = false;
        for (phase, name) in PENDING_PHASE_FILES {
            let path = directory.join(name);
            let bytes = match read_file_with_limit(&path, PENDING_STATE_MAX_BYTES) {
                Ok(bytes) => bytes,
                Err(ProductStoreError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                    missing_phase_seen = true;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if missing_phase_seen {
                return Err(ProductStoreError::InvalidPendingCommit(
                    "pending phase files must form one contiguous prefix".to_owned(),
                ));
            }
            let pending: PendingCommit = serde_json::from_slice(&bytes)
                .map_err(|error| ProductStoreError::InvalidPendingCommit(error.to_string()))?;
            pending
                .validate()
                .map_err(ProductStoreError::InvalidPendingCommit)?;
            if pending.phase != phase {
                return Err(ProductStoreError::InvalidPendingCommit(format!(
                    "pending phase does not match {name}"
                )));
            }
            if latest
                .as_ref()
                .is_some_and(|previous| !previous.same_transaction_as(&pending))
            {
                return Err(ProductStoreError::InvalidPendingCommit(
                    "pending phase files describe different transactions".to_owned(),
                ));
            }
            latest = Some(pending);
        }
        if let Some(pending) = &latest {
            self.validate_staged_desktop_asset_unlocked(
                &pending.desktop_asset,
                &pending.target_version,
            )?;
        }
        Ok(latest)
    }

    pub(crate) fn write_pending_unlocked(
        &self,
        pending: &PendingCommit,
    ) -> Result<(), ProductStoreError> {
        pending
            .validate()
            .map_err(ProductStoreError::InvalidPendingCommit)?;
        let directory = self.root.join(PENDING_COMMIT_DIRECTORY);
        ensure_managed_directory(&directory)?;
        let name = pending_phase_file(pending.phase);
        let destination = directory.join(name);
        let bytes = serde_json::to_vec_pretty(pending)
            .map_err(|error| ProductStoreError::InvalidPendingCommit(error.to_string()))?;
        if bytes.len() as u64 > PENDING_STATE_MAX_BYTES {
            return Err(ProductStoreError::InvalidPendingCommit(format!(
                "pending state exceeds {PENDING_STATE_MAX_BYTES} bytes"
            )));
        }
        if destination.exists() {
            let existing: PendingCommit = serde_json::from_slice(&fs::read(&destination)?)
                .map_err(|error| ProductStoreError::InvalidPendingCommit(error.to_string()))?;
            if existing == *pending {
                return Ok(());
            }
            return Err(ProductStoreError::InvalidPendingCommit(format!(
                "pending phase already exists with different state: {name}"
            )));
        }
        write_new_file_atomic(&destination, &bytes)
    }

    /// Durably claims one initiating-surface continuation before native
    /// dispatch. A repeated matching claim is accepted without redispatch;
    /// changing the intent for an existing transaction is rejected.
    pub(crate) fn claim_resume(
        &self,
        transaction_id: &str,
        intent: &ResumeIntent,
    ) -> Result<bool, ProductStoreError> {
        if !is_canonical_uuid(transaction_id) {
            return Err(ProductStoreError::InvalidResumeReceipt(
                "transactionId must be a canonical UUID".to_owned(),
            ));
        }
        let _transaction = self.lock_transaction()?;
        let directory = self.root.join(RESUME_RECEIPT_DIRECTORY);
        ensure_managed_directory(&directory)?;
        let destination = directory.join(format!("{transaction_id}.json"));
        let bytes = serde_json::to_vec_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "transactionId": transaction_id,
            "intent": intent
        }))
        .map_err(|error| ProductStoreError::InvalidResumeReceipt(error.to_string()))?;
        match fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_file() => {
                if fs::read(&destination)? == bytes {
                    Ok(false)
                } else {
                    Err(ProductStoreError::InvalidResumeReceipt(
                        "resume transaction intent changed".to_owned(),
                    ))
                }
            }
            Ok(_) => Err(ProductStoreError::ManagedPathType(destination)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                write_new_file_atomic(&destination, &bytes)?;
                Ok(true)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn validate_staged_desktop_asset_unlocked(
        &self,
        staged: &StagedDesktopAsset,
        product_version: &str,
    ) -> Result<(), ProductStoreError> {
        if !staged
            .release_asset
            .matches_product_version(product_version)
        {
            return Err(ProductStoreError::InvalidStagedAsset(
                "release asset does not match pending target".to_owned(),
            ));
        }
        let expected = self
            .root
            .join("updates")
            .join(product_version)
            .join(staged.release_asset.name());
        if staged.path != expected {
            return Err(ProductStoreError::InvalidStagedAssetPath(
                staged.path.clone(),
            ));
        }
        let update_directory = self.root.join("updates").join(product_version);
        require_managed_directory(&self.root.join("updates"))?;
        require_managed_directory(&update_directory)?;
        let manifest_bytes = read_file_with_limit(
            &update_directory.join(RELEASE_MANIFEST_NAME),
            RELEASE_MANIFEST_MAX_BYTES,
        )?;
        let signature_bytes = read_file_with_limit(
            &update_directory.join(RELEASE_SIGNATURE_NAME),
            RELEASE_SIGNATURE_MAX_BYTES,
        )?;
        let signature_text = std::str::from_utf8(&signature_bytes).map_err(|_| {
            ProductStoreError::InvalidStagedAsset(
                "persisted release signature must be UTF-8".to_owned(),
            )
        })?;
        let trusted = verify_signed_release_manifest(
            &manifest_bytes,
            signature_text,
            &self.update_public_key,
        )
        .map_err(|error| ProductStoreError::InvalidStagedAsset(error.to_string()))?;
        if trusted.version() != product_version
            || trusted.asset_for(
                ReleaseAssetKind::Desktop,
                staged.release_asset.platform(),
                staged.release_asset.architecture(),
            ) != Some(&staged.release_asset)
        {
            return Err(ProductStoreError::InvalidStagedAsset(
                "pending Desktop asset is not proven by the persisted signed manifest".to_owned(),
            ));
        }
        validate_exact_file(&staged.path, &staged.release_asset)
    }

    pub(crate) fn open_verified_desktop_installer_unlocked(
        &self,
        staged: &StagedDesktopAsset,
        product_version: &str,
    ) -> Result<VerifiedDesktopInstaller, ProductStoreError> {
        self.validate_staged_desktop_asset_unlocked(staged, product_version)?;
        let file = open_managed_file(staged.path())?;
        validate_exact_open_file(&file, staged.release_asset())?;
        Ok(VerifiedDesktopInstaller {
            staged: staged.clone(),
            file,
        })
    }

    pub(crate) fn open_verified_runtime_unlocked(
        &self,
        product_version: &str,
    ) -> Result<VerifiedRuntimeEntrypoint, ProductStoreError> {
        let manifest = self.validate_version_unlocked(product_version)?;
        let declared = manifest
            .files
            .iter()
            .find(|file| file.path == manifest.entrypoints.runtime)
            .expect("validated manifest contains the Runtime entrypoint");
        let path = self
            .version_path(product_version)
            .join(&manifest.entrypoints.runtime);
        let file = open_managed_file(&path)?;
        validate_open_product_file(&file, declared)?;
        Ok(VerifiedRuntimeEntrypoint { path, file })
    }

    pub(crate) fn clear_pending_unlocked(
        &self,
        completed_version: &str,
    ) -> Result<(), ProductStoreError> {
        let active = self.root.join(PENDING_COMMIT_DIRECTORY);
        match fs::symlink_metadata(&active) {
            Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            }
            Ok(_) => return Err(ProductStoreError::ManagedPathType(active)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        let retired = self.root.join(format!(
            ".retired-pending-{completed_version}--{}",
            Uuid::new_v4()
        ));
        fs::rename(&active, &retired)?;
        sync_directory(&self.root)?;
        if self.retire_update_unlocked(completed_version).is_err() {
            // The retired-pending marker makes cleanup retryable on the next
            // product-store lock. The product commit itself is already
            // durably complete and must not be reported as failed here.
            return Ok(());
        }
        let _cleanup_result = fs::remove_dir_all(&retired);
        Ok(())
    }

    fn retire_update_unlocked(&self, product_version: &str) -> Result<(), ProductStoreError> {
        retire_update_at_root(&self.root, product_version)
    }

    pub(crate) fn remove_version_unlocked(
        &self,
        product_version: &str,
    ) -> Result<(), ProductStoreError> {
        if self.current_version_unlocked()?.as_deref() == Some(product_version) {
            return Err(ProductStoreError::CannotRemoveCurrentVersion(
                product_version.to_owned(),
            ));
        }
        let versions = self.root.join("versions");
        require_managed_directory(&versions)?;
        let path = self.version_path(product_version);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
                fs::remove_dir_all(path)?;
                sync_directory(&versions)?;
            }
            Ok(_) => return Err(ProductStoreError::ManagedPathType(path)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }
}

fn read_product_manifest(root: &Path) -> Result<ProductManifest, ProductStoreError> {
    let path = root.join(PRODUCT_MANIFEST_NAME);
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.file_type().is_file() || metadata.len() > PRODUCT_MANIFEST_MAX_BYTES {
        return Err(ProductStoreError::InvalidManifestFile(path));
    }
    let manifest: ProductManifest = serde_json::from_slice(&fs::read(&path)?)
        .map_err(|error| ProductStoreError::InvalidManifestJson(error.to_string()))?;
    manifest.validate_contract()?;
    Ok(manifest)
}

fn validate_product_platform(
    manifest: &ProductManifest,
    platform: CommitPlatform,
    architecture: ReleaseArchitecture,
) -> Result<(), ProductStoreError> {
    let matches = matches!(
        (manifest.platform, platform),
        (ProductPlatform::Macos, CommitPlatform::Macos)
            | (ProductPlatform::Windows, CommitPlatform::Windows)
    );
    if matches && manifest.architecture == architecture {
        Ok(())
    } else {
        Err(ProductStoreError::ProductPlatformMismatch)
    }
}

fn validate_product_directory(
    root: &Path,
    manifest: &ProductManifest,
) -> Result<(), ProductStoreError> {
    manifest.validate_contract()?;
    if read_product_manifest(root)? != *manifest {
        return Err(ProductStoreError::ManifestChangedDuringMaterialization);
    }
    let declared = manifest
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<HashMap<_, _>>();
    let actual = collect_regular_files(root)?;
    if actual.len() != declared.len() + 1 || !actual.contains(PRODUCT_MANIFEST_NAME) {
        return Err(ProductStoreError::FileInventoryMismatch);
    }
    for path in &actual {
        if path == PRODUCT_MANIFEST_NAME {
            continue;
        }
        let file = declared
            .get(path.as_str())
            .ok_or_else(|| ProductStoreError::UndeclaredFile(path.clone()))?;
        let file_path = root.join(path);
        let metadata = fs::metadata(&file_path)?;
        if metadata.len() != file.size_bytes {
            return Err(ProductStoreError::FileSizeMismatch(path.clone()));
        }
        if sha256_file(&file_path)? != file.sha256 {
            return Err(ProductStoreError::FileDigestMismatch(path.clone()));
        }
    }
    for path in declared.keys() {
        if !actual.contains(*path) {
            return Err(ProductStoreError::MissingDeclaredFile((*path).to_owned()));
        }
    }
    #[cfg(unix)]
    if manifest.platform == ProductPlatform::Macos {
        use std::os::unix::fs::PermissionsExt as _;

        for executable in [&manifest.entrypoints.runtime, &manifest.entrypoints.cli] {
            if fs::metadata(root.join(executable))?.permissions().mode() & 0o111 == 0 {
                return Err(ProductStoreError::ProductEntrypointNotExecutable(
                    executable.clone(),
                ));
            }
        }
    }
    Ok(())
}

fn collect_regular_files(root: &Path) -> Result<HashSet<String>, ProductStoreError> {
    let mut files = HashSet::new();
    collect_regular_files_at(root, root, &mut files)?;
    Ok(files)
}

fn collect_regular_files_at(
    root: &Path,
    directory: &Path,
    files: &mut HashSet<String>,
) -> Result<(), ProductStoreError> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(ProductStoreError::ProductSymlink(path));
        }
        if file_type.is_dir() {
            collect_regular_files_at(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| ProductStoreError::InvalidVersionPath(path.clone()))?;
            files.insert(relative_path_string(relative)?);
        } else {
            return Err(ProductStoreError::UnsupportedProductEntry(path));
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), ProductStoreError> {
    fs::create_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(ProductStoreError::ProductSymlink(source_path));
        }
        if file_type.is_dir() {
            copy_tree(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)?;
            fs::set_permissions(&destination_path, fs::metadata(&source_path)?.permissions())?;
        } else {
            return Err(ProductStoreError::UnsupportedProductEntry(source_path));
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, ProductStoreError> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn sha256_open_file(file: &File) -> Result<String, ProductStoreError> {
    let mut reader = file;
    reader.seek(SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    reader.seek(SeekFrom::Start(0))?;
    Ok(format!("{:x}", digest.finalize()))
}

fn open_managed_file(path: &Path) -> Result<File, ProductStoreError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(ProductStoreError::ManagedPathType(path.to_path_buf()));
    }
    let file = open_identity_locked_file(path)?;
    if !file.metadata()?.file_type().is_file() {
        return Err(ProductStoreError::ManagedPathType(path.to_path_buf()));
    }
    Ok(file)
}

#[cfg(unix)]
fn open_identity_locked_file(path: &Path) -> io::Result<File> {
    fs::OpenOptions::new().read(true).open(path)
}

#[cfg(windows)]
fn open_identity_locked_file(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt as _;

    // Keep the already verified identity readable but deny replacement and
    // writes until the adapter has handed the same image to the native API.
    fs::OpenOptions::new().read(true).share_mode(1).open(path)
}

fn validate_open_product_file(
    file: &File,
    declared: &super::manifest::ProductManifestFile,
) -> Result<(), ProductStoreError> {
    if file.metadata()?.len() != declared.size_bytes {
        return Err(ProductStoreError::FileSizeMismatch(declared.path.clone()));
    }
    if sha256_open_file(file)? != declared.sha256 {
        return Err(ProductStoreError::FileDigestMismatch(declared.path.clone()));
    }
    Ok(())
}

fn validate_exact_open_file(
    file: &File,
    release_asset: &TrustedReleaseAsset,
) -> Result<(), ProductStoreError> {
    if file.metadata()?.len() != release_asset.size_bytes() {
        return Err(ProductStoreError::InvalidStagedAsset(
            "Desktop installer size does not match signed manifest".to_owned(),
        ));
    }
    if sha256_open_file(file)? != release_asset.sha256() {
        return Err(ProductStoreError::InvalidStagedAsset(
            "Desktop installer digest does not match signed manifest".to_owned(),
        ));
    }
    Ok(())
}

fn validate_exact_file(
    path: &Path,
    release_asset: &TrustedReleaseAsset,
) -> Result<(), ProductStoreError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(ProductStoreError::InvalidStagedAssetPath(
            path.to_path_buf(),
        ));
    }
    if metadata.len() != release_asset.size_bytes() {
        return Err(ProductStoreError::InvalidStagedAsset(
            "Desktop installer size does not match signed manifest".to_owned(),
        ));
    }
    if sha256_file(path)? != release_asset.sha256() {
        return Err(ProductStoreError::InvalidStagedAsset(
            "Desktop installer digest does not match signed manifest".to_owned(),
        ));
    }
    Ok(())
}

fn ensure_immutable_file(path: &Path, bytes: &[u8]) -> Result<(), ProductStoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            if fs::read(path)? == bytes {
                Ok(())
            } else {
                Err(ProductStoreError::InvalidStagedAsset(format!(
                    "immutable update evidence changed: {}",
                    path.display()
                )))
            }
        }
        Ok(_) => Err(ProductStoreError::ManagedPathType(path.to_path_buf())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => write_new_file_atomic(path, bytes),
        Err(error) => Err(error.into()),
    }
}

fn read_file_with_limit(path: &Path, max_bytes: u64) -> Result<Vec<u8>, ProductStoreError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() > max_bytes {
        return Err(ProductStoreError::InvalidStagedAssetPath(
            path.to_path_buf(),
        ));
    }
    Ok(fs::read(path)?)
}

fn sync_tree(root: &Path) -> Result<(), ProductStoreError> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            sync_tree(&path)?;
        } else {
            File::open(path)?.sync_all()?;
        }
    }
    sync_directory(root)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), ProductStoreError> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(windows)]
fn sync_directory(path: &Path) -> Result<(), ProductStoreError> {
    debrute_windows_product_fs::sync_directory(path)?;
    Ok(())
}

fn write_new_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), ProductStoreError> {
    let temporary = path
        .parent()
        .expect("pending state has a parent")
        .join(format!(".tmp-{}", Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    sync_directory(path.parent().expect("atomic file has a parent"))
}

fn pending_phase_file(phase: CommitPhase) -> &'static str {
    PENDING_PHASE_FILES
        .iter()
        .find_map(|(candidate, name)| (*candidate == phase).then_some(*name))
        .expect("every closed pending phase has a file")
}

fn cleanup_abandoned_transaction_artifacts(
    root: &Path,
    platform: CommitPlatform,
) -> Result<(), ProductStoreError> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        if let Some(suffix) = name.strip_prefix(".staging-") {
            let Some((product_version, transaction_id)) = suffix.split_once("--") else {
                continue;
            };
            if validate_release_version(product_version).is_err()
                || !is_canonical_uuid(transaction_id)
            {
                continue;
            }
            let file_type = entry.file_type()?;
            if !file_type.is_dir() || file_type.is_symlink() {
                return Err(ProductStoreError::ManagedPathType(entry.path()));
            }
            fs::remove_dir_all(entry.path())?;
            continue;
        }
        if let Some(transaction_id) = name.strip_prefix(".current-") {
            if !is_canonical_uuid(transaction_id) {
                continue;
            }
            remove_abandoned_native_pointer(platform, &entry.path())?;
        }
    }

    let updates = root.join("updates");
    let update_directories = match require_managed_directory(&updates)
        .and_then(|()| fs::read_dir(&updates).map_err(ProductStoreError::from))
    {
        Ok(entries) => entries,
        Err(ProductStoreError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    for update_directory in update_directories {
        let update_directory = update_directory?;
        let Some(product_version) = update_directory.file_name().to_str().map(ToOwned::to_owned)
        else {
            continue;
        };
        if validate_release_version(&product_version).is_err() {
            continue;
        }
        let file_type = update_directory.file_type()?;
        if !file_type.is_dir() || file_type.is_symlink() {
            return Err(ProductStoreError::ManagedPathType(update_directory.path()));
        }
        for entry in fs::read_dir(update_directory.path())? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
                continue;
            };
            let Some(transaction_id) = name.strip_prefix(".asset-") else {
                continue;
            };
            if !is_canonical_uuid(transaction_id) {
                continue;
            }
            let file_type = entry.file_type()?;
            if !file_type.is_file() || file_type.is_symlink() {
                return Err(ProductStoreError::ManagedPathType(entry.path()));
            }
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn cleanup_retired_pending(root: &Path) -> Result<(), ProductStoreError> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        let pending_version = if let Some(suffix) = name.strip_prefix(".retired-pending-") {
            let Some((product_version, transaction_id)) = suffix.split_once("--") else {
                continue;
            };
            if validate_release_version(product_version).is_err()
                || !is_canonical_uuid(transaction_id)
            {
                continue;
            }
            Some(product_version.to_owned())
        } else if let Some(transaction_id) = name.strip_prefix(".retired-update-") {
            if !is_canonical_uuid(transaction_id) {
                continue;
            }
            None
        } else {
            continue;
        };
        let file_type = entry.file_type()?;
        if !file_type.is_dir() || file_type.is_symlink() {
            return Err(ProductStoreError::ManagedPathType(entry.path()));
        }
        if let Some(product_version) = pending_version {
            retire_update_at_root(root, &product_version)?;
        }
        fs::remove_dir_all(entry.path())?;
    }
    Ok(())
}

fn retire_update_at_root(root: &Path, product_version: &str) -> Result<(), ProductStoreError> {
    let updates = root.join("updates");
    let active = updates.join(product_version);
    match fs::symlink_metadata(&active) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(ProductStoreError::ManagedPathType(active)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    let retired = root.join(format!(".retired-update-{}", Uuid::new_v4()));
    fs::rename(active, &retired)?;
    sync_directory(&updates)?;
    sync_directory(root)?;
    let _cleanup_result = fs::remove_dir_all(retired);
    Ok(())
}

fn is_canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|uuid| uuid.hyphenated().to_string() == value)
}

fn ensure_managed_directory(path: &Path) -> Result<(), ProductStoreError> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    require_managed_directory(path)
}

fn require_managed_directory(path: &Path) -> Result<(), ProductStoreError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
        Ok(())
    } else {
        Err(ProductStoreError::ManagedPathType(path.to_path_buf()))
    }
}

fn relative_path_string(path: &Path) -> Result<String, ProductStoreError> {
    let components = path
        .components()
        .map(|component| {
            component
                .as_os_str()
                .to_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| ProductStoreError::NonUtf8ProductPath(path.to_path_buf()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(components.join("/"))
}

fn pointer_version(target: &Path) -> Result<String, ProductStoreError> {
    let mut components = target.components();
    let versions = components.next();
    let version = components.next();
    let Some(version) = version.and_then(|component| component.as_os_str().to_str()) else {
        return Err(ProductStoreError::InvalidCurrentPointer(
            target.to_path_buf(),
        ));
    };
    if versions.and_then(|component| component.as_os_str().to_str()) != Some("versions")
        || components.next().is_some()
    {
        return Err(ProductStoreError::InvalidCurrentPointer(
            target.to_path_buf(),
        ));
    }
    Ok(version.to_owned())
}

fn managed_pointer_version(target: &Path) -> Result<String, ProductStoreError> {
    let version = pointer_version(target)?;
    validate_release_version(&version)?;
    Ok(version)
}

#[cfg(windows)]
fn absolute_pointer_target(pointer: &Path, target: &Path) -> Result<PathBuf, ProductStoreError> {
    let root = pointer
        .parent()
        .ok_or_else(|| ProductStoreError::InvalidVersionPath(pointer.to_path_buf()))?;
    let absolute = root.join(target);
    if absolute.is_absolute() {
        Ok(absolute)
    } else {
        Err(ProductStoreError::InvalidVersionPath(absolute))
    }
}

#[cfg(unix)]
fn create_native_pointer(
    platform: CommitPlatform,
    target: &Path,
    pointer: &Path,
) -> Result<(), ProductStoreError> {
    if platform != CommitPlatform::Macos {
        return Err(ProductStoreError::UnsupportedPointerPlatform(platform));
    }
    std::os::unix::fs::symlink(target, pointer)?;
    Ok(())
}

#[cfg(unix)]
fn replace_native_pointer(
    platform: CommitPlatform,
    temporary: &Path,
    current: &Path,
) -> Result<(), ProductStoreError> {
    if platform != CommitPlatform::Macos {
        return Err(ProductStoreError::UnsupportedPointerPlatform(platform));
    }
    fs::rename(temporary, current)?;
    Ok(())
}

#[cfg(unix)]
fn read_native_pointer(
    platform: CommitPlatform,
    current: &Path,
) -> Result<PathBuf, ProductStoreError> {
    if platform != CommitPlatform::Macos {
        return Err(ProductStoreError::UnsupportedPointerPlatform(platform));
    }
    Ok(fs::read_link(current)?)
}

#[cfg(unix)]
fn remove_abandoned_native_pointer(
    platform: CommitPlatform,
    pointer: &Path,
) -> Result<(), ProductStoreError> {
    if platform != CommitPlatform::Macos {
        return Err(ProductStoreError::UnsupportedPointerPlatform(platform));
    }
    let target = read_native_pointer(platform, pointer)?;
    managed_pointer_version(&target)?;
    fs::remove_file(pointer)?;
    Ok(())
}

#[cfg(windows)]
fn create_native_pointer(
    platform: CommitPlatform,
    target: &Path,
    pointer: &Path,
) -> Result<(), ProductStoreError> {
    if platform != CommitPlatform::Windows {
        return Err(ProductStoreError::UnsupportedPointerPlatform(platform));
    }
    let absolute_target = absolute_pointer_target(pointer, target)?;
    debrute_windows_product_fs::create_junction(&absolute_target, pointer)?;
    Ok(())
}

#[cfg(windows)]
fn replace_native_pointer(
    platform: CommitPlatform,
    temporary: &Path,
    current: &Path,
) -> Result<(), ProductStoreError> {
    if platform != CommitPlatform::Windows {
        return Err(ProductStoreError::UnsupportedPointerPlatform(platform));
    }
    let root = current
        .parent()
        .ok_or_else(|| ProductStoreError::InvalidVersionPath(current.to_path_buf()))?;
    let target = read_native_pointer(platform, temporary)?;
    managed_pointer_version(&target)?;
    let absolute_target = root.join(&target);
    match fs::symlink_metadata(current) {
        Ok(_) => {
            // Refuse to retarget an arbitrary reparse point or unmanaged
            // junction. Reading it proves that its existing target is one
            // canonical versions/<version> path under this product root.
            managed_pointer_version(&read_native_pointer(platform, current)?)?;
            debrute_windows_product_fs::retarget_junction(current, &absolute_target)?;
            fs::remove_dir(temporary)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::rename(temporary, current)?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

#[cfg(windows)]
fn read_native_pointer(
    platform: CommitPlatform,
    current: &Path,
) -> Result<PathBuf, ProductStoreError> {
    if platform != CommitPlatform::Windows {
        return Err(ProductStoreError::UnsupportedPointerPlatform(platform));
    }
    let target = debrute_windows_product_fs::junction_target(current)?;
    let canonical = fs::canonicalize(if target.is_absolute() {
        target
    } else {
        current.parent().expect("current has parent").join(target)
    })?;
    let root = fs::canonicalize(current.parent().expect("current has parent"))?;
    canonical
        .strip_prefix(root)
        .map(Path::to_path_buf)
        .map_err(|_| ProductStoreError::InvalidCurrentPointer(canonical))
}

#[cfg(windows)]
fn remove_abandoned_native_pointer(
    platform: CommitPlatform,
    pointer: &Path,
) -> Result<(), ProductStoreError> {
    if platform != CommitPlatform::Windows {
        return Err(ProductStoreError::UnsupportedPointerPlatform(platform));
    }
    match read_native_pointer(platform, pointer) {
        Ok(target) => {
            managed_pointer_version(&target)?;
            fs::remove_dir(pointer)?;
            Ok(())
        }
        Err(pointer_error) => {
            let metadata = fs::symlink_metadata(pointer)?;
            if metadata.file_type().is_dir()
                && !metadata.file_type().is_symlink()
                && fs::read_dir(pointer)?.next().is_none()
            {
                fs::remove_dir(pointer)?;
                Ok(())
            } else {
                Err(pointer_error)
            }
        }
    }
}

#[derive(Debug)]
pub enum ProductStoreError {
    Io(io::Error),
    InvalidManifestJson(String),
    InvalidManifest(ProductManifestError),
    InvalidManifestFile(PathBuf),
    InvalidVersionPath(PathBuf),
    VersionPathMismatch { expected: String, actual: String },
    MaterializedVersionConflict(String),
    ProductSymlink(PathBuf),
    UnsupportedProductEntry(PathBuf),
    NonUtf8ProductPath(PathBuf),
    FileInventoryMismatch,
    UndeclaredFile(String),
    MissingDeclaredFile(String),
    FileSizeMismatch(String),
    FileDigestMismatch(String),
    ManifestChangedDuringMaterialization,
    InvalidCurrentPointer(PathBuf),
    UnsupportedPointerPlatform(CommitPlatform),
    ManagedPathType(PathBuf),
    ProductPlatformMismatch,
    ProductEntrypointNotExecutable(String),
    InvalidPendingCommit(String),
    InvalidResumeReceipt(String),
    InvalidStagedAsset(String),
    InvalidStagedAssetPath(PathBuf),
    CannotRemoveCurrentVersion(String),
    DesktopSeedOlderThanCurrent { seed: String, current: String },
    InvalidProductRoot(PathBuf),
}

impl fmt::Display for ProductStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "product store I/O failed: {error}"),
            other => write!(formatter, "product store rejected state: {other:?}"),
        }
    }
}

impl Error for ProductStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::InvalidManifest(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for ProductStoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<ProductManifestError> for ProductStoreError {
    fn from(error: ProductManifestError) -> Self {
        Self::InvalidManifest(error)
    }
}
