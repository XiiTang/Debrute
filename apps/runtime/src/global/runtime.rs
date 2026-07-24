use std::{
    error::Error,
    fmt,
    sync::{Arc, Mutex, PoisonError},
};

use serde::Serialize;
use serde_json::Value;

use crate::integrations::{
    IntegrationError, IntegrationObservationError, IntegrationOperation,
    IntegrationOperationResult, IntegrationService, IntegrationSettingsView,
};
use crate::photoshop::PhotoshopBridgeStateView;

use super::{
    models::{ModelCatalog, ModelSettingsView},
    store::{
        AdobeBridgeSettings, ChromeSettings, GlobalConfigStore, GlobalSettingsError,
        GlobalSettingsView, RecentProjectEntry, WorkbenchSettings,
    },
};

pub type GlobalRuntimeObserver = Arc<dyn Fn(GlobalRuntimeEvent) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebruteGlobalSettingsView {
    pub workbench: WorkbenchSettings,
    pub chrome: ChromeSettings,
    pub models: ModelSettingsView,
    pub integrations: IntegrationSettingsView,
    pub adobe_bridge: AdobeBridgeSettings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalRuntimeEvent {
    pub revision: u64,
    pub change: GlobalRuntimeChange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GlobalRuntimeChange {
    GlobalSettingsChanged(DebruteGlobalSettingsView),
    RecentProjectsChanged(Vec<RecentProjectEntry>),
    IntegrationsChanged(IntegrationSettingsView),
    PhotoshopBridgeChanged(PhotoshopBridgeStateView),
    ProductChanged(Value),
}

pub struct GlobalRuntimeService {
    store: Arc<GlobalConfigStore>,
    catalog: Arc<ModelCatalog>,
    integrations: IntegrationService,
    integration_projection: Mutex<IntegrationProjectionState>,
    commit: Mutex<()>,
    delivery: Mutex<()>,
    events: Mutex<GlobalEventState>,
}

#[derive(Default)]
struct GlobalEventState {
    revision: u64,
    observer: Option<GlobalRuntimeObserver>,
}

#[derive(Default)]
struct IntegrationProjectionState {
    generation: u64,
    view: Option<IntegrationSettingsView>,
}

impl GlobalRuntimeService {
    #[must_use]
    pub fn new(
        store: impl Into<Arc<GlobalConfigStore>>,
        catalog: impl Into<Arc<ModelCatalog>>,
        integrations: IntegrationService,
    ) -> Self {
        Self {
            store: store.into(),
            catalog: catalog.into(),
            integrations,
            integration_projection: Mutex::new(IntegrationProjectionState::default()),
            commit: Mutex::new(()),
            delivery: Mutex::new(()),
            events: Mutex::new(GlobalEventState::default()),
        }
    }

    /// Publishes the Runtime-owned Product projection through the same ordered
    /// Global stream as settings and integration changes.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalRuntimeError`] if the event revision is exhausted or the
    /// event state is unavailable.
    pub fn publish_product_changed(&self, product: Value) -> Result<(), GlobalRuntimeError> {
        let _delivery = self.lock_delivery()?;
        self.publish(GlobalRuntimeChange::ProductChanged(product))
    }

    pub fn install_observer(&self, observer: GlobalRuntimeObserver) -> bool {
        let mut events = self.events.lock().unwrap_or_else(PoisonError::into_inner);
        if events.observer.is_some() {
            return false;
        }
        events.observer = Some(observer);
        true
    }

    #[must_use]
    pub fn revision(&self) -> u64 {
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .revision
    }

    /// Reads the native launcher's recent-Project projection without probing
    /// optional integration tools.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalRuntimeError`] when persisted global state is invalid.
    pub fn recent_projects_snapshot(&self) -> Result<Vec<RecentProjectEntry>, GlobalRuntimeError> {
        Ok(self.store.read_recent_projects()?)
    }

    /// Captures a complete settings projection and its exact event barrier.
    ///
    /// The delivery lock prevents a mutation from publishing between the view
    /// and revision reads, allowing the HTTP adapter to register first, emit one
    /// snapshot, then discard buffered events at or before this revision.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalRuntimeError`] when settings, integrations, or in-process
    /// synchronization state cannot be read.
    pub fn sync_snapshot(&self) -> Result<(u64, DebruteGlobalSettingsView), GlobalRuntimeError> {
        let _delivery = self.lock_delivery()?;
        let view = self.settings_get()?;
        Ok((self.revision(), view))
    }

    /// Publishes one Runtime-owned projection that is not stored by the global
    /// settings module, while retaining the same monotonic Global revision.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalRuntimeError`] when revision or delivery state is
    /// unavailable.
    pub fn publish_external(&self, change: GlobalRuntimeChange) -> Result<(), GlobalRuntimeError> {
        let _delivery = self.lock_delivery()?;
        let _commit = self.lock_commit()?;
        self.ensure_revision_available()?;
        self.publish(change)
    }

    /// Returns the complete settings view with a cached or freshly scanned
    /// integration projection.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalRuntimeError`] when persisted settings, catalog-backed
    /// projection, or integration state cannot be read.
    pub fn settings_get(&self) -> Result<DebruteGlobalSettingsView, GlobalRuntimeError> {
        let candidate = self.integration_candidate(false)?;
        let _commit = self.lock_commit()?;
        let integrations = self.adopt_integration_candidate(candidate)?;
        let projection = self.store.read_view(&self.catalog)?;
        Ok(complete_view(projection, integrations))
    }

    /// Applies one settings patch and publishes exactly one revision only when
    /// persisted public or secret state changed.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalRuntimeError`] for invalid input or state failures.
    pub fn settings_save(
        &self,
        input: &Value,
    ) -> Result<DebruteGlobalSettingsView, GlobalRuntimeError> {
        let candidate = self.integration_candidate(false)?;
        let _delivery = self.lock_delivery()?;
        let (view, change) = {
            let _commit = self.lock_commit()?;
            self.ensure_revision_available()?;
            let integrations = self.adopt_integration_candidate(candidate)?;
            let result = self.store.patch(input, &self.catalog)?;
            let view = complete_view(result.view, integrations);
            let change = result
                .changed
                .then(|| GlobalRuntimeChange::GlobalSettingsChanged(view.clone()));
            (view, change)
        };
        if let Some(change) = change {
            self.publish(change)?;
        }
        Ok(view)
    }

    /// Updates the recent Project MRU and its revisioned projections.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalRuntimeError`] for persistence or revision failures.
    pub fn remember_recent_project(
        &self,
        project_id: &str,
        project_root: &str,
    ) -> Result<bool, GlobalRuntimeError> {
        let _delivery = self.lock_delivery()?;
        let (changed, change) = {
            let _commit = self.lock_commit()?;
            self.ensure_revision_available()?;
            let result = self
                .store
                .remember_recent_project(project_id, project_root)?;
            let change = result
                .changed
                .then_some(GlobalRuntimeChange::RecentProjectsChanged(
                    result.recent_projects,
                ));
            (result.changed, change)
        };
        if let Some(change) = change {
            self.publish(change)?;
        }
        Ok(changed)
    }

    /// Clears the recent Project projection.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalRuntimeError`] for persistence or revision failures.
    pub fn clear_recent_projects(&self) -> Result<bool, GlobalRuntimeError> {
        let _delivery = self.lock_delivery()?;
        let (changed, change) = {
            let _commit = self.lock_commit()?;
            self.ensure_revision_available()?;
            let result = self.store.clear_recent_projects()?;
            let change = result
                .changed
                .then_some(GlobalRuntimeChange::RecentProjectsChanged(
                    result.recent_projects,
                ));
            (result.changed, change)
        };
        if let Some(change) = change {
            self.publish(change)?;
        }
        Ok(changed)
    }

    /// Forces one integration rescan and publishes its complete projection.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalRuntimeError`] when integration state cannot be read.
    pub fn integrations_rescan(&self) -> Result<IntegrationSettingsView, GlobalRuntimeError> {
        let candidate = self.integration_candidate(true)?;
        let _delivery = self.lock_delivery()?;
        let view = {
            let _commit = self.lock_commit()?;
            self.ensure_revision_available()?;
            self.adopt_integration_candidate(candidate)?
        };
        self.publish(GlobalRuntimeChange::IntegrationsChanged(view.clone()))?;
        Ok(view)
    }

    /// Runs one closed integration operation with start and settled revisions.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalRuntimeError`] for integration or revision-state failures.
    pub fn integrations_run_operation(
        &self,
        integration_id: &str,
        operation: IntegrationOperation,
    ) -> Result<IntegrationOperationResult, GlobalRuntimeError> {
        let observed = self
            .integrations
            .run_operation_observed(
                integration_id,
                operation,
                |started| self.commit_integration_view(started.clone()),
                |settled| self.commit_integration_view(settled.clone()),
            )
            .map_err(|error| match error {
                IntegrationObservationError::Service(error) => {
                    GlobalRuntimeError::Integrations(error)
                }
                IntegrationObservationError::Started(error) => error,
            })?;
        if let Some(error) = observed.settled_observer_error {
            eprintln!("Debrute integration settled event failed: {error}");
        }
        Ok(observed.result)
    }

    fn integration_candidate(
        &self,
        force: bool,
    ) -> Result<(u64, IntegrationSettingsView), GlobalRuntimeError> {
        let generation = self
            .integration_projection
            .lock()
            .map_err(|_| GlobalRuntimeError::StatePoisoned)?
            .generation;
        let view = if force {
            self.integrations.rescan()?
        } else {
            self.integrations.list_status()?
        };
        Ok((generation, view))
    }

    fn adopt_integration_candidate(
        &self,
        candidate: (u64, IntegrationSettingsView),
    ) -> Result<IntegrationSettingsView, GlobalRuntimeError> {
        let (generation, view) = candidate;
        let mut projection = self
            .integration_projection
            .lock()
            .map_err(|_| GlobalRuntimeError::StatePoisoned)?;
        if projection.generation == generation || projection.view.is_none() {
            projection.generation = projection
                .generation
                .checked_add(1)
                .ok_or(GlobalRuntimeError::IntegrationGenerationExhausted)?;
            projection.view = Some(view.clone());
            return Ok(view);
        }
        projection
            .view
            .clone()
            .ok_or(GlobalRuntimeError::StatePoisoned)
    }

    fn commit_integration_view(
        &self,
        view: IntegrationSettingsView,
    ) -> Result<(), GlobalRuntimeError> {
        let _delivery = self.lock_delivery()?;
        let change = {
            let _commit = self.lock_commit()?;
            self.ensure_revision_available()?;
            let mut projection = self
                .integration_projection
                .lock()
                .map_err(|_| GlobalRuntimeError::StatePoisoned)?;
            projection.generation = projection
                .generation
                .checked_add(1)
                .ok_or(GlobalRuntimeError::IntegrationGenerationExhausted)?;
            projection.view = Some(view.clone());
            drop(projection);
            GlobalRuntimeChange::IntegrationsChanged(view)
        };
        self.publish(change)?;
        Ok(())
    }

    fn lock_commit(&self) -> Result<std::sync::MutexGuard<'_, ()>, GlobalRuntimeError> {
        self.commit
            .lock()
            .map_err(|_| GlobalRuntimeError::StatePoisoned)
    }

    fn lock_delivery(&self) -> Result<std::sync::MutexGuard<'_, ()>, GlobalRuntimeError> {
        self.delivery
            .lock()
            .map_err(|_| GlobalRuntimeError::StatePoisoned)
    }

    fn ensure_revision_available(&self) -> Result<(), GlobalRuntimeError> {
        let events = self
            .events
            .lock()
            .map_err(|_| GlobalRuntimeError::StatePoisoned)?;
        if events.revision == u64::MAX {
            Err(GlobalRuntimeError::RevisionExhausted)
        } else {
            Ok(())
        }
    }

    fn publish(&self, change: GlobalRuntimeChange) -> Result<(), GlobalRuntimeError> {
        let mut events = self
            .events
            .lock()
            .map_err(|_| GlobalRuntimeError::StatePoisoned)?;
        events.revision = events
            .revision
            .checked_add(1)
            .ok_or(GlobalRuntimeError::RevisionExhausted)?;
        let event = GlobalRuntimeEvent {
            revision: events.revision,
            change,
        };
        let observer = events.observer.clone();
        drop(events);
        if let Some(observer) = observer {
            observer(event);
        }
        Ok(())
    }
}

fn complete_view(
    projection: GlobalSettingsView,
    integrations: IntegrationSettingsView,
) -> DebruteGlobalSettingsView {
    DebruteGlobalSettingsView {
        workbench: projection.workbench,
        chrome: projection.chrome,
        models: projection.models,
        integrations,
        adobe_bridge: projection.adobe_bridge,
    }
}

#[derive(Debug)]
pub enum GlobalRuntimeError {
    Settings(GlobalSettingsError),
    Integrations(IntegrationError),
    StatePoisoned,
    RevisionExhausted,
    IntegrationGenerationExhausted,
}

impl fmt::Display for GlobalRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Settings(error) => error.fmt(formatter),
            Self::Integrations(error) => error.fmt(formatter),
            Self::StatePoisoned => formatter.write_str("Global Runtime state lock is poisoned."),
            Self::RevisionExhausted => formatter.write_str("Global Runtime revision is exhausted."),
            Self::IntegrationGenerationExhausted => {
                formatter.write_str("Global Runtime integration generation is exhausted.")
            }
        }
    }
}

impl Error for GlobalRuntimeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Settings(error) => Some(error),
            Self::Integrations(error) => Some(error),
            Self::StatePoisoned
            | Self::RevisionExhausted
            | Self::IntegrationGenerationExhausted => None,
        }
    }
}

impl From<GlobalSettingsError> for GlobalRuntimeError {
    fn from(error: GlobalSettingsError) -> Self {
        Self::Settings(error)
    }
}

impl From<IntegrationError> for GlobalRuntimeError {
    fn from(error: IntegrationError) -> Self {
        Self::Integrations(error)
    }
}
