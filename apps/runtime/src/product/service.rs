use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, PoisonError},
};

use semver::Version;
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    control::RuntimeControlState,
    workbench::{
        ProductUpdateInitiator, RuntimeHttpServiceError, RuntimeProductHttpService,
        WorkbenchRuntimeServices,
    },
};

use super::{
    NativeUpdatePlatform, ProductCommitCoordinator, ProductStore, ReleaseArchitecture,
    ReleaseAssetKind, ReleasePlatform, ResumeIntent, ResumeTarget, TrustedReleaseManifest,
    extract_product_archive,
    release::{GitHubProductReleaseSource, ProductReleaseSource},
};

pub struct RuntimeProductService {
    current_version: String,
    platform: ReleasePlatform,
    architecture: ReleaseArchitecture,
    debrute_home: PathBuf,
    store: Arc<ProductStore>,
    native: NativeUpdatePlatform,
    runtime: Arc<RuntimeControlState>,
    services: Arc<WorkbenchRuntimeServices>,
    source: Arc<dyn ProductReleaseSource>,
    operation: Mutex<()>,
    projection: Arc<Mutex<ProductProjection>>,
}

#[derive(Clone)]
struct ProductProjection {
    update: UpdateState,
    available: Option<TrustedReleaseManifest>,
}

enum ProductResumeSource {
    Desktop { target: ResumeTarget },
    Browser { target: ResumeTarget },
    Cli,
    Bootstrap,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum UpdateState {
    Idle {
        #[serde(rename = "currentVersion")]
        current_version: String,
        #[serde(rename = "lastCheckedAt", skip_serializing_if = "Option::is_none")]
        last_checked_at: Option<String>,
        #[serde(rename = "updateAvailable")]
        update_available: bool,
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
    Installing {
        #[serde(rename = "currentVersion")]
        current_version: String,
        #[serde(rename = "updateVersion")]
        update_version: String,
    },
    Error {
        #[serde(rename = "currentVersion")]
        current_version: String,
        operation: &'static str,
        message: String,
        #[serde(rename = "updateVersion", skip_serializing_if = "Option::is_none")]
        update_version: Option<String>,
    },
}

impl RuntimeProductService {
    /// Creates the single Runtime-owned Product status and update capability.
    ///
    /// # Errors
    ///
    /// Returns [`RuntimeHttpServiceError`] if the fixed official release client
    /// cannot be initialized.
    #[allow(clippy::too_many_arguments)]
    pub fn official(
        current_version: String,
        platform: ReleasePlatform,
        architecture: ReleaseArchitecture,
        debrute_home: PathBuf,
        store: Arc<ProductStore>,
        native: NativeUpdatePlatform,
        runtime: Arc<RuntimeControlState>,
        services: Arc<WorkbenchRuntimeServices>,
    ) -> Result<Arc<Self>, RuntimeHttpServiceError> {
        let source = Arc::new(GitHubProductReleaseSource::new().map_err(|error| {
            RuntimeHttpServiceError::new(500, "product_update_unavailable", error.to_string())
        })?);
        let initial_update = match store.pending().map_err(|error| {
            RuntimeHttpServiceError::new(500, "product_update_unavailable", error.to_string())
        })? {
            Some(pending) => UpdateState::Error {
                current_version: current_version.clone(),
                operation: "apply",
                message: "A previously interrupted Product update requires explicit continuation."
                    .to_owned(),
                update_version: Some(pending.target_version),
            },
            None => UpdateState::Idle {
                current_version: current_version.clone(),
                last_checked_at: None,
                update_available: false,
            },
        };
        Ok(Self::new(
            current_version,
            platform,
            architecture,
            debrute_home,
            store,
            native,
            runtime,
            services,
            source,
            initial_update,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn new(
        current_version: String,
        platform: ReleasePlatform,
        architecture: ReleaseArchitecture,
        debrute_home: PathBuf,
        store: Arc<ProductStore>,
        native: NativeUpdatePlatform,
        runtime: Arc<RuntimeControlState>,
        services: Arc<WorkbenchRuntimeServices>,
        source: Arc<dyn ProductReleaseSource>,
        initial_update: UpdateState,
    ) -> Arc<Self> {
        Arc::new(Self {
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
            services,
            source,
            operation: Mutex::new(()),
        })
    }

    fn product_state(&self) -> Value {
        product_state_value(
            &self.current_version,
            self.platform,
            &self.debrute_home,
            &self
                .projection
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .update,
        )
    }

    fn publish_state(&self) -> Value {
        let state = self.product_state();
        let _ = self
            .services
            .global()
            .publish_product_changed(state.clone());
        state
    }

    fn perform_check(&self) -> Value {
        {
            let mut projection = self
                .projection
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            projection.available = None;
            projection.update = UpdateState::Checking {
                current_version: self.current_version.clone(),
            };
        }
        self.publish_state();
        let result = self.source.latest();
        let mut projection = self
            .projection
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
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
                            projection.update = UpdateState::Error {
                                current_version: self.current_version.clone(),
                                operation: "check",
                                message: "The release does not contain the complete matching Desktop and Product pair."
                                    .to_owned(),
                                update_version: Some(release.version().to_owned()),
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
                        projection.update = UpdateState::Idle {
                            current_version: self.current_version.clone(),
                            last_checked_at: Some(now()),
                            update_available: false,
                        };
                    }
                    _ => {
                        projection.update = UpdateState::Error {
                            current_version: self.current_version.clone(),
                            operation: "check",
                            message: "Product version comparison failed.".to_owned(),
                            update_version: Some(release.version().to_owned()),
                        };
                    }
                }
            }
            Ok(None) => {
                projection.update = UpdateState::Idle {
                    current_version: self.current_version.clone(),
                    last_checked_at: Some(now()),
                    update_available: false,
                };
            }
            Err(error) => {
                projection.update = UpdateState::Error {
                    current_version: self.current_version.clone(),
                    operation: "check",
                    message: error.to_string(),
                    update_version: None,
                };
            }
        }
        drop(projection);
        self.publish_state()
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

    fn resolve_resume_source(
        &self,
        initiator: ProductUpdateInitiator,
    ) -> Result<ProductResumeSource, RuntimeHttpServiceError> {
        match initiator {
            ProductUpdateInitiator::Cli => Ok(ProductResumeSource::Cli),
            ProductUpdateInitiator::Bootstrap => Ok(ProductResumeSource::Bootstrap),
            ProductUpdateInitiator::Frontend { browser_session }
                if self.services.is_desktop_browser_session(&browser_session) =>
            {
                Ok(ProductResumeSource::Desktop {
                    target: self.services.resume_target_for_browser(&browser_session)?,
                })
            }
            ProductUpdateInitiator::Frontend { browser_session } => {
                Ok(ProductResumeSource::Browser {
                    target: self.services.resume_target_for_browser(&browser_session)?,
                })
            }
        }
    }

    fn resume_intent(source: ProductResumeSource) -> ResumeIntent {
        match source {
            ProductResumeSource::Cli => ResumeIntent::Cli,
            ProductResumeSource::Bootstrap => ResumeIntent::Bootstrap {
                target: ResumeTarget::Root,
            },
            ProductResumeSource::Desktop { target } => ResumeIntent::Desktop { target },
            ProductResumeSource::Browser { target } => ResumeIntent::Browser { target },
        }
    }

    fn set_apply_error(&self, message: String, update_version: Option<String>) -> Value {
        self.projection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .update = UpdateState::Error {
            current_version: self.current_version.clone(),
            operation: "apply",
            message,
            update_version,
        };
        self.publish_state()
    }

    fn reject_active_install(&self) -> Result<(), RuntimeHttpServiceError> {
        if matches!(
            self.projection
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .update,
            UpdateState::Installing { .. }
        ) {
            Err(RuntimeHttpServiceError::new(
                409,
                "product_update_busy",
                "A Product update transition is active.",
            ))
        } else {
            Ok(())
        }
    }

    fn start_transition(
        &self,
        target_version: String,
        commit: Box<dyn FnOnce() -> Result<(), String> + Send>,
    ) -> Result<Value, RuntimeHttpServiceError> {
        self.projection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .update = UpdateState::Installing {
            current_version: self.current_version.clone(),
            update_version: target_version.clone(),
        };
        self.publish_state();
        let transition_id = Uuid::new_v4().to_string();
        let services = Arc::clone(&self.services);
        let cancel_projection = Arc::clone(&self.projection);
        let cancel_current_version = self.current_version.clone();
        let cancel_platform = self.platform;
        let cancel_debrute_home = self.debrute_home.clone();
        let cancel_update_version = target_version.clone();
        let cancel_services = Arc::clone(&services);
        let accepted = self.runtime.request_product_update(
            &transition_id,
            commit,
            Box::new(move |message| {
                cancel_projection
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .update = UpdateState::Error {
                    current_version: cancel_current_version.clone(),
                    operation: "apply",
                    message: message.to_owned(),
                    update_version: Some(cancel_update_version.clone()),
                };
                let state = product_state_value(
                    &cancel_current_version,
                    cancel_platform,
                    &cancel_debrute_home,
                    &cancel_projection
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .update,
                );
                let _ = cancel_services.global().publish_product_changed(state);
            }),
        );
        if !accepted {
            self.set_apply_error(
                "Runtime cannot enter the Product update transition.".to_owned(),
                Some(target_version),
            );
            return Err(RuntimeHttpServiceError::new(
                409,
                "product_update_busy",
                "Runtime cannot enter the Product update transition.",
            ));
        }
        Ok(json!({ "state": self.product_state() }))
    }
}

impl RuntimeProductHttpService for RuntimeProductService {
    fn state(&self) -> Result<Value, RuntimeHttpServiceError> {
        Ok(self.product_state())
    }

    fn check(&self) -> Result<Value, RuntimeHttpServiceError> {
        let _operation = self.operation.try_lock().map_err(|_| {
            RuntimeHttpServiceError::new(
                409,
                "product_update_busy",
                "A Product operation is active.",
            )
        })?;
        self.reject_active_install()?;
        Ok(self.perform_check())
    }

    #[allow(clippy::too_many_lines)]
    fn apply(
        &self,
        input: &Value,
        initiator: ProductUpdateInitiator,
    ) -> Result<Value, RuntimeHttpServiceError> {
        require_empty_object(input)?;
        let _operation = self.operation.try_lock().map_err(|_| {
            RuntimeHttpServiceError::new(
                409,
                "product_update_busy",
                "A Product operation is active.",
            )
        })?;
        self.reject_active_install()?;
        if let Some(pending) = self
            .store
            .pending()
            .map_err(|error| update_error(&error.to_string()))?
        {
            let store = Arc::clone(&self.store);
            let native = self.native.clone();
            return self.start_transition(
                pending.target_version,
                Box::new(move || {
                    ProductCommitCoordinator::new(store, native)
                        .continue_commit()
                        .map_err(|error| error.to_string())
                }),
            );
        }
        let needs_check = !matches!(
            self.projection
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .update,
            UpdateState::Available { .. }
        );
        if needs_check {
            self.perform_check();
        }
        let release = self
            .projection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .available
            .clone();
        let Some(release) = release else {
            return Ok(json!({ "state": self.product_state() }));
        };
        let resume_source = self.resolve_resume_source(initiator)?;
        let target_version = release.version().to_owned();
        self.projection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .update = UpdateState::Installing {
            current_version: self.current_version.clone(),
            update_version: target_version.clone(),
        };
        self.publish_state();
        let (materialized, desktop_asset) = match self.stage_available(&release) {
            Ok(staged) => staged,
            Err(error) => {
                let state = self.set_apply_error(error.message, Some(target_version));
                return Ok(json!({ "state": state }));
            }
        };
        let resume_intent = Self::resume_intent(resume_source);
        let store = Arc::clone(&self.store);
        let native = self.native.clone();
        self.start_transition(
            target_version,
            Box::new(move || {
                let coordinator = ProductCommitCoordinator::new(store, native);
                coordinator
                    .begin(&materialized, desktop_asset, resume_intent)
                    .and_then(|_| coordinator.continue_commit())
                    .map_err(|error| error.to_string())
            }),
        )
    }

    fn quit(&self, input: &Value) -> Result<Value, RuntimeHttpServiceError> {
        require_empty_object(input)?;
        self.runtime
            .request_product_quit()
            .map(|()| json!({ "accepted": true }))
            .map_err(|code| {
                RuntimeHttpServiceError::new(
                    409,
                    match code {
                        crate::control::ControlErrorCode::UpdateCommitInProgress => {
                            "update_commit_in_progress"
                        }
                        _ => "product_quit_failed",
                    },
                    "Runtime cannot enter Product Quit.",
                )
            })
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
            400,
            "invalid_product_request",
            "Product request contains unsupported fields.",
        ))
    }
}

fn update_error(message: &str) -> RuntimeHttpServiceError {
    RuntimeHttpServiceError::new(500, "product_update_failed", message)
}

fn now() -> String {
    crate::now_rfc3339()
}
