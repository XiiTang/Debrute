use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use semver::Version;
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    control::{ProductUpdateTransitionFailure, RuntimeControlState},
    global::GlobalRuntimeService,
    workbench::{ProductUpdateInitiator, RuntimeHttpServiceError, RuntimeProductHttpService},
};

use super::{
    CommitPhase, NativeUpdatePlatform, ProductCommitCoordinator, ProductStore,
    ProductUpdateFailureStage, ReleaseArchitecture, ReleaseAssetKind, ReleasePlatform,
    ResumeIntent, TrustedReleaseManifest, extract_product_archive,
    release::{GitHubProductReleaseSource, ProductReleaseSource},
};

const AUTOMATIC_DISCOVERY_INTERVAL: Duration = Duration::from_hours(24);

pub struct RuntimeProductService {
    current_version: String,
    platform: ReleasePlatform,
    architecture: ReleaseArchitecture,
    debrute_home: PathBuf,
    store: Arc<ProductStore>,
    native: NativeUpdatePlatform,
    runtime: Arc<RuntimeControlState>,
    global: Arc<GlobalRuntimeService>,
    source: Arc<dyn ProductReleaseSource>,
    operation: Mutex<()>,
    projection: Arc<Mutex<ProductProjection>>,
    next_automatic_discovery: Mutex<Instant>,
    automatic_discovery_in_flight: AtomicBool,
}

#[derive(Clone)]
struct ProductProjection {
    update: UpdateState,
    available: Option<TrustedReleaseManifest>,
}

#[derive(Clone, Copy)]
enum DiscoveryOrigin {
    Automatic,
    Manual,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum PreparingStage {
    ClosingNewWork,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum CommittingStage {
    ContinuingTransaction,
    InstallingAndSelecting,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum InstallFailureStage {
    Preparing,
    Committing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum UpdateState {
    Unknown {
        #[serde(rename = "currentVersion")]
        current_version: String,
    },
    UpToDate {
        #[serde(rename = "currentVersion")]
        current_version: String,
        #[serde(rename = "lastCheckedAt", skip_serializing_if = "Option::is_none")]
        last_checked_at: Option<String>,
    },
    Checking {
        #[serde(rename = "currentVersion")]
        current_version: String,
    },
    Available {
        #[serde(rename = "currentVersion")]
        current_version: String,
        #[serde(rename = "updateVersion")]
        update_version: String,
        #[serde(rename = "releaseName")]
        release_name: String,
        #[serde(rename = "releaseDate")]
        release_date: String,
    },
    Preparing {
        #[serde(rename = "currentVersion")]
        current_version: String,
        #[serde(rename = "updateVersion")]
        update_version: String,
        stage: PreparingStage,
    },
    Committing {
        #[serde(rename = "currentVersion")]
        current_version: String,
        #[serde(rename = "updateVersion")]
        update_version: String,
        stage: CommittingStage,
    },
    DiscoveryFailed {
        #[serde(rename = "currentVersion")]
        current_version: String,
        message: String,
    },
    InstallFailed {
        #[serde(rename = "currentVersion")]
        current_version: String,
        #[serde(rename = "updateVersion", skip_serializing_if = "Option::is_none")]
        update_version: Option<String>,
        stage: InstallFailureStage,
        message: String,
    },
}

impl RuntimeProductService {
    /// Creates the single Runtime-owned Product status and update capability.
    ///
    /// # Errors
    ///
    /// Returns [`RuntimeHttpServiceError`] if the fixed official release client
    /// cannot be initialized.
    #[expect(
        clippy::too_many_arguments,
        reason = "the single Runtime composition root keeps Product identity and its owned runtime dependencies explicit"
    )]
    pub fn official(
        current_version: String,
        platform: ReleasePlatform,
        architecture: ReleaseArchitecture,
        debrute_home: PathBuf,
        store: Arc<ProductStore>,
        native: NativeUpdatePlatform,
        runtime: Arc<RuntimeControlState>,
        global: Arc<GlobalRuntimeService>,
    ) -> Result<Arc<Self>, RuntimeHttpServiceError> {
        let source = Arc::new(GitHubProductReleaseSource::new().map_err(|error| {
            RuntimeHttpServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "product_update_unavailable",
                error.to_string(),
            )
        })?);
        let initial_update = match store.pending().map_err(|error| {
            RuntimeHttpServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "product_update_unavailable",
                error.to_string(),
            )
        })? {
            Some(pending) => match pending.phase {
                CommitPhase::Staged | CommitPhase::DesktopInstalled => UpdateState::InstallFailed {
                    current_version: current_version.clone(),
                    stage: InstallFailureStage::Committing,
                    message:
                        "A previously interrupted Product update requires explicit continuation."
                            .to_owned(),
                    update_version: Some(pending.target_version),
                },
                CommitPhase::CurrentSelected => UpdateState::Committing {
                    current_version: current_version.clone(),
                    update_version: pending.target_version,
                    stage: CommittingStage::ContinuingTransaction,
                },
                CommitPhase::RuntimeReady => UpdateState::UpToDate {
                    current_version: current_version.clone(),
                    last_checked_at: None,
                },
            },
            None => UpdateState::Unknown {
                current_version: current_version.clone(),
            },
        };
        let service = Arc::new(Self {
            projection: Arc::new(Mutex::new(ProductProjection {
                update: initial_update,
                available: None,
            })),
            current_version,
            platform,
            architecture,
            debrute_home,
            store,
            native,
            runtime,
            global,
            source,
            operation: Mutex::new(()),
            next_automatic_discovery: Mutex::new(Instant::now()),
            automatic_discovery_in_flight: AtomicBool::new(false),
        });
        service.publish_state();
        Ok(service)
    }

    fn product_state(&self) -> Value {
        product_state_value(
            &self.current_version,
            self.platform,
            &self.debrute_home,
            &self
                .projection
                .lock()
                .expect("Product projection lock poisoned")
                .update,
        )
    }

    fn publish_state(&self) -> Value {
        let state = self.product_state();
        self.global.publish_product_changed(state.clone());
        state
    }

    fn perform_check(&self, origin: DiscoveryOrigin) -> Value {
        let previous = {
            let mut projection = self
                .projection
                .lock()
                .expect("Product projection lock poisoned");
            let previous = projection.clone();
            if matches!(origin, DiscoveryOrigin::Manual) {
                projection.update = UpdateState::Checking {
                    current_version: self.current_version.clone(),
                };
            }
            previous
        };
        if matches!(origin, DiscoveryOrigin::Manual) {
            self.publish_state();
        }
        let result = self.source.latest();
        let mut projection = self
            .projection
            .lock()
            .expect("Product projection lock poisoned");
        let mut publish = true;
        match result {
            Ok(Some(release)) => {
                let current = Version::parse(&self.current_version);
                let available = Version::parse(release.version());
                match (current, available) {
                    (Ok(current), Ok(available)) if available > current => {
                        let desktop = release.asset_for(
                            ReleaseAssetKind::Desktop,
                            self.platform,
                            self.architecture,
                        );
                        let product = release.asset_for(
                            ReleaseAssetKind::Product,
                            self.platform,
                            self.architecture,
                        );
                        if desktop.is_none() || product.is_none() {
                            projection.available = None;
                            projection.update = UpdateState::DiscoveryFailed {
                                current_version: self.current_version.clone(),
                                message: "The release does not contain the complete matching Desktop and Product pair."
                                    .to_owned(),
                            };
                        } else {
                            projection.update = UpdateState::Available {
                                current_version: self.current_version.clone(),
                                update_version: release.version().to_owned(),
                                release_name: format!("Debrute {}", release.version()),
                                release_date: release.published_at().to_owned(),
                            };
                            projection.available = Some(release);
                        }
                    }
                    (Ok(_), Ok(_)) => {
                        projection.available = None;
                        projection.update = UpdateState::UpToDate {
                            current_version: self.current_version.clone(),
                            last_checked_at: Some(crate::now_rfc3339()),
                        };
                    }
                    _ => {
                        projection.available = None;
                        projection.update = UpdateState::DiscoveryFailed {
                            current_version: self.current_version.clone(),
                            message: "Product version comparison failed.".to_owned(),
                        };
                    }
                }
            }
            Ok(None) => {
                projection.available = None;
                projection.update = UpdateState::UpToDate {
                    current_version: self.current_version.clone(),
                    last_checked_at: Some(crate::now_rfc3339()),
                };
            }
            Err(error) => {
                if matches!(origin, DiscoveryOrigin::Automatic) && error.is_transient_discovery() {
                    *projection = previous;
                    publish = false;
                } else {
                    projection.available = None;
                    projection.update = UpdateState::DiscoveryFailed {
                        current_version: self.current_version.clone(),
                        message: error.to_string(),
                    };
                }
            }
        }
        drop(projection);
        if publish {
            self.publish_state()
        } else {
            self.product_state()
        }
    }

    /// Starts one due automatic discovery worker without retaining an updater thread.
    ///
    /// # Panics
    ///
    /// Panics if an authoritative Product operation or scheduling lock is poisoned.
    pub fn poll_automatic_discovery(self: &Arc<Self>) {
        let now = Instant::now();
        {
            let mut next = self
                .next_automatic_discovery
                .lock()
                .expect("Product automatic-discovery schedule lock poisoned");
            if now < *next
                || self
                    .automatic_discovery_in_flight
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
            {
                return;
            }
            *next = now + AUTOMATIC_DISCOVERY_INTERVAL;
        }
        let service = Arc::clone(self);
        if thread::Builder::new()
            .name("debrute-product-discovery".to_owned())
            .spawn(move || {
                let _operation = service
                    .operation
                    .lock()
                    .expect("Product operation lock poisoned");
                if service.reject_active_install().is_ok() {
                    service.perform_check(DiscoveryOrigin::Automatic);
                }
                service
                    .automatic_discovery_in_flight
                    .store(false, Ordering::Release);
            })
            .is_err()
        {
            self.automatic_discovery_in_flight
                .store(false, Ordering::Release);
        }
    }

    /// Publishes the selected startup Product as Ready after durable completion.
    ///
    /// # Panics
    ///
    /// Panics if the authoritative Product projection lock is poisoned.
    pub fn mark_startup_ready(&self) {
        let mut projection = self
            .projection
            .lock()
            .expect("Product projection lock poisoned");
        projection.available = None;
        projection.update = UpdateState::UpToDate {
            current_version: self.current_version.clone(),
            last_checked_at: None,
        };
        drop(projection);
        self.publish_state();
    }

    /// Publishes a retryable target-Runtime finalization failure.
    ///
    /// # Panics
    ///
    /// Panics if the authoritative Product projection lock is poisoned.
    pub fn mark_startup_failure(&self, update_version: String, message: String) {
        self.set_install_failure(
            InstallFailureStage::Committing,
            message,
            Some(update_version),
        );
    }

    fn stage_available(
        &self,
        release: &TrustedReleaseManifest,
    ) -> Result<(PathBuf, super::StagedDesktopAsset), RuntimeHttpServiceError> {
        let download_directory = self
            .store
            .root()
            .join("downloads")
            .join(Uuid::new_v4().to_string());
        let result = (|| {
            let desktop_asset = release
                .asset_for(ReleaseAssetKind::Desktop, self.platform, self.architecture)
                .ok_or_else(|| update_error("Matching Desktop asset is missing."))?;
            let product_asset = release
                .asset_for(ReleaseAssetKind::Product, self.platform, self.architecture)
                .ok_or_else(|| update_error("Matching Product archive is missing."))?;
            let downloaded_desktop = self
                .source
                .download(desktop_asset, &download_directory)
                .map_err(|error| update_error(&error.to_string()))?;
            let downloaded_product = self
                .source
                .download(product_asset, &download_directory)
                .map_err(|error| update_error(&error.to_string()))?;
            let staged_desktop = self
                .store
                .stage_desktop_asset(
                    release,
                    self.platform,
                    self.architecture,
                    &downloaded_desktop,
                )
                .map_err(|error| update_error(&error.to_string()))?;
            let staged_product = self
                .store
                .stage_product_archive(
                    release,
                    self.platform,
                    self.architecture,
                    &downloaded_product,
                )
                .map_err(|error| update_error(&error.to_string()))?;
            let extracted =
                extract_product_archive(&staged_product, &self.store.root().join("extracted"))
                    .map_err(|error| update_error(&error.to_string()))?;
            let materialized = self
                .store
                .materialize_seed(&extracted)
                .map_err(|error| update_error(&error.to_string()))?;
            let _ = fs::remove_dir_all(extracted);
            Ok((materialized, staged_desktop))
        })();
        let _ = fs::remove_dir_all(download_directory);
        result
    }

    fn resume_intent(initiator: ProductUpdateInitiator) -> ResumeIntent {
        match initiator {
            ProductUpdateInitiator::Desktop => ResumeIntent::Desktop,
            ProductUpdateInitiator::Browser => ResumeIntent::Browser,
        }
    }

    fn set_install_failure(
        &self,
        stage: InstallFailureStage,
        message: String,
        update_version: Option<String>,
    ) -> Value {
        self.projection
            .lock()
            .expect("Product projection lock poisoned")
            .update = UpdateState::InstallFailed {
            current_version: self.current_version.clone(),
            stage,
            message,
            update_version,
        };
        self.publish_state()
    }

    fn reject_active_install(&self) -> Result<(), RuntimeHttpServiceError> {
        if matches!(
            self.projection
                .lock()
                .expect("Product projection lock poisoned")
                .update,
            UpdateState::Preparing { .. } | UpdateState::Committing { .. }
        ) {
            Err(RuntimeHttpServiceError::new(
                StatusCode::CONFLICT,
                "product_update_busy",
                "A Product update transition is active.",
            ))
        } else {
            Ok(())
        }
    }

    fn lock_operation(&self) -> Result<MutexGuard<'_, ()>, RuntimeHttpServiceError> {
        match self.operation.try_lock() {
            Ok(operation) => Ok(operation),
            Err(TryLockError::WouldBlock) => Err(RuntimeHttpServiceError::new(
                StatusCode::CONFLICT,
                "product_update_busy",
                "A Product operation is active.",
            )),
            Err(TryLockError::Poisoned(_)) => panic!("Product operation lock poisoned"),
        }
    }

    fn start_transition(
        self: &Arc<Self>,
        target_version: String,
        transition: Box<dyn FnOnce() -> Result<(), ProductUpdateTransitionFailure> + Send>,
    ) -> Result<Value, RuntimeHttpServiceError> {
        let transition_id = Uuid::new_v4().to_string();
        let accepted_service = Arc::clone(self);
        let accepted_update_version = target_version.clone();
        let global = Arc::clone(&self.global);
        let cancel_projection = Arc::clone(&self.projection);
        let cancel_current_version = self.current_version.clone();
        let cancel_platform = self.platform;
        let cancel_debrute_home = self.debrute_home.clone();
        let cancel_update_version = target_version.clone();
        let accepted = self.runtime.request_product_update(
            &transition_id,
            Box::new(move || {
                accepted_service
                    .projection
                    .lock()
                    .expect("Product projection lock poisoned")
                    .update = UpdateState::Preparing {
                    current_version: accepted_service.current_version.clone(),
                    update_version: accepted_update_version,
                    stage: PreparingStage::ClosingNewWork,
                };
                accepted_service.publish_state();
            }),
            transition,
            Box::new(move |message| {
                let mut projection = cancel_projection
                    .lock()
                    .expect("Product projection lock poisoned");
                let stage = if matches!(projection.update, UpdateState::Committing { .. }) {
                    InstallFailureStage::Committing
                } else {
                    InstallFailureStage::Preparing
                };
                projection.update = UpdateState::InstallFailed {
                    current_version: cancel_current_version.clone(),
                    message: message.to_owned(),
                    update_version: Some(cancel_update_version.clone()),
                    stage,
                };
                drop(projection);
                let published_state = product_state_value(
                    &cancel_current_version,
                    cancel_platform,
                    &cancel_debrute_home,
                    &cancel_projection
                        .lock()
                        .expect("Product projection lock poisoned")
                        .update,
                );
                global.publish_product_changed(published_state);
            }),
        );
        if !accepted {
            self.set_install_failure(
                InstallFailureStage::Preparing,
                "Runtime cannot enter the Product update transition.".to_owned(),
                Some(target_version),
            );
            return Err(RuntimeHttpServiceError::new(
                StatusCode::CONFLICT,
                "product_update_busy",
                "Runtime cannot enter the Product update transition.",
            ));
        }
        Ok(json!({ "state": self.product_state() }))
    }

    fn committing_failure(
        &self,
        coordinator: &ProductCommitCoordinator<NativeUpdatePlatform>,
        transaction_id: &str,
        error: impl std::fmt::Display,
    ) -> ProductUpdateTransitionFailure {
        let mut message = error.to_string();
        match coordinator.record_failure(
            transaction_id,
            ProductUpdateFailureStage::Committing,
            message.clone(),
        ) {
            Ok(()) => {
                if let Err(launch_error) = self.native.launch_update_failure(transaction_id) {
                    message.push_str(" Desktop failure surface could not be launched: ");
                    message.push_str(&launch_error.to_string());
                }
            }
            Err(record_error) => {
                message.push_str(" Failure persistence also failed: ");
                message.push_str(&record_error.to_string());
            }
        }
        ProductUpdateTransitionFailure::committing(message)
    }
}

impl RuntimeProductHttpService for RuntimeProductService {
    fn state(&self) -> Result<Value, RuntimeHttpServiceError> {
        Ok(self.product_state())
    }

    fn check(&self) -> Result<Value, RuntimeHttpServiceError> {
        let _operation = self.lock_operation()?;
        self.reject_active_install()?;
        Ok(self.perform_check(DiscoveryOrigin::Manual))
    }

    fn apply(
        self: Arc<Self>,
        input: &Value,
        initiator: ProductUpdateInitiator,
    ) -> Result<Value, RuntimeHttpServiceError> {
        require_empty_object(input)?;
        let _operation = self.lock_operation()?;
        self.reject_active_install()?;
        if let Some(pending) = self
            .store
            .pending()
            .map_err(|error| update_error(&error.to_string()))?
        {
            if pending.phase == CommitPhase::RuntimeReady {
                return Ok(json!({ "state": self.product_state() }));
            }
            let store = Arc::clone(&self.store);
            let native = self.native.clone();
            let service = Arc::clone(&self);
            let target_version = pending.target_version.clone();
            let transaction_id = pending.transaction_id.clone();
            return self.start_transition(
                target_version.clone(),
                Box::new(move || {
                    service
                        .projection
                        .lock()
                        .expect("Product projection lock poisoned")
                        .update = UpdateState::Committing {
                        current_version: service.current_version.clone(),
                        update_version: target_version,
                        stage: CommittingStage::ContinuingTransaction,
                    };
                    service.publish_state();
                    let coordinator = ProductCommitCoordinator::new(store, native);
                    coordinator.continue_commit().map_err(|error| {
                        service.committing_failure(&coordinator, &transaction_id, error)
                    })
                }),
            );
        }
        let needs_check = !matches!(
            self.projection
                .lock()
                .expect("Product projection lock poisoned")
                .update,
            UpdateState::Available { .. }
        );
        if needs_check {
            self.perform_check(DiscoveryOrigin::Manual);
        }
        let release = self
            .projection
            .lock()
            .expect("Product projection lock poisoned")
            .available
            .clone();
        let Some(release) = release else {
            return Ok(json!({ "state": self.product_state() }));
        };
        let target_version = release.version().to_owned();
        let resume_intent = Self::resume_intent(initiator);
        let service = Arc::clone(&self);
        self.start_transition(
            target_version,
            Box::new(move || {
                let (materialized, desktop_asset) = service
                    .stage_available(&release)
                    .map_err(|error| ProductUpdateTransitionFailure::preparing(error.message))?;
                let coordinator = ProductCommitCoordinator::new(
                    Arc::clone(&service.store),
                    service.native.clone(),
                );
                let transaction_id = coordinator
                    .begin(&materialized, desktop_asset, resume_intent)
                    .map_err(|error| {
                        ProductUpdateTransitionFailure::preparing(error.to_string())
                    })?;
                service
                    .projection
                    .lock()
                    .expect("Product projection lock poisoned")
                    .update = UpdateState::Committing {
                    current_version: service.current_version.clone(),
                    update_version: release.version().to_owned(),
                    stage: CommittingStage::InstallingAndSelecting,
                };
                service.publish_state();
                coordinator.continue_commit().map_err(|error| {
                    service.committing_failure(&coordinator, &transaction_id, error)
                })
            }),
        )
    }

    fn remove(self: Arc<Self>, keep_config: bool) -> Result<Value, RuntimeHttpServiceError> {
        self.runtime.remove_product(keep_config).map_err(|code| {
            RuntimeHttpServiceError::new(
                axum::http::StatusCode::CONFLICT,
                match code {
                    crate::control::ControlErrorCode::UpdateCommitInProgress => {
                        "product_update_in_progress"
                    }
                    crate::control::ControlErrorCode::RemovalInProgress => {
                        "product_removal_in_progress"
                    }
                    _ => "product_removal_unavailable",
                },
                format!("Product removal was rejected: {code:?}"),
            )
        })?;
        Ok(json!({
            "accepted": true,
            "configPreserved": keep_config
        }))
    }
}

fn product_state_value(
    current_version: &str,
    platform: ReleasePlatform,
    debrute_home: &std::path::Path,
    update: &UpdateState,
) -> Value {
    let user_home = debrute_home.parent().unwrap_or(debrute_home);
    let cli_path = if platform == ReleasePlatform::Windows {
        debrute_home.join("bin/debrute.cmd")
    } else {
        debrute_home.join("bin/debrute")
    };
    json!({
        "productVersion": current_version,
        "platform": if platform == ReleasePlatform::Windows { "win32" } else { "darwin" },
        "cli": {
            "status": "ready",
            "version": current_version,
            "path": cli_path,
            "skillsVersion": current_version,
            "skillsRoot": user_home.join(".agents/skills")
        },
        "update": update
    })
}

fn require_empty_object(input: &Value) -> Result<(), RuntimeHttpServiceError> {
    if input.as_object().is_some_and(serde_json::Map::is_empty) || input.is_null() {
        Ok(())
    } else {
        Err(RuntimeHttpServiceError::new(
            StatusCode::BAD_REQUEST,
            "invalid_product_request",
            "Product request contains unsupported fields.",
        ))
    }
}

fn update_error(message: &str) -> RuntimeHttpServiceError {
    RuntimeHttpServiceError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "product_update_failed",
        message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_initiator_freezes_the_authorized_resume_surface() {
        for (initiator, expected) in [
            (ProductUpdateInitiator::Desktop, ResumeIntent::Desktop),
            (ProductUpdateInitiator::Browser, ResumeIntent::Browser),
        ] {
            assert_eq!(RuntimeProductService::resume_intent(initiator), expected);
        }
    }

    #[test]
    fn update_transition_stages_serialize_to_the_closed_product_contract() {
        let preparing = serde_json::to_value(UpdateState::Preparing {
            current_version: "0.2.0".to_owned(),
            update_version: "0.3.0".to_owned(),
            stage: PreparingStage::ClosingNewWork,
        })
        .unwrap();
        let committing = serde_json::to_value(UpdateState::Committing {
            current_version: "0.2.0".to_owned(),
            update_version: "0.3.0".to_owned(),
            stage: CommittingStage::InstallingAndSelecting,
        })
        .unwrap();
        assert_eq!(preparing["type"], "preparing");
        assert_eq!(preparing["stage"], "closing_new_work");
        assert_eq!(committing["type"], "committing");
        assert_eq!(committing["stage"], "installing_and_selecting");
    }
}
