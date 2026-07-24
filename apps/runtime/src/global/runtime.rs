use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;

use crate::integrations::{
    IntegrationOperation, IntegrationOperationResult, IntegrationService, IntegrationSettingsView,
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
    product: Option<Value>,
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
    pub fn publish_product_changed(&self, product: Value) {
        let _delivery = self.lock_delivery();
        self.publish(GlobalRuntimeChange::ProductChanged(product));
    }

    pub fn install_observer(&self, observer: GlobalRuntimeObserver) -> bool {
        let mut events = self.lock_events();
        if events.observer.is_some() {
            return false;
        }
        events.observer = Some(observer);
        true
    }

    #[must_use]
    pub fn revision(&self) -> u64 {
        self.lock_events().revision
    }

    /// Reads the native Desktop presentation without probing optional
    /// integration tools.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] when persisted global state is invalid.
    pub fn desktop_presentation_snapshot(
        &self,
    ) -> Result<(Vec<RecentProjectEntry>, String), GlobalSettingsError> {
        self.store.read_desktop_presentation(&self.catalog)
    }

    /// Captures a complete settings projection and its exact event barrier.
    ///
    /// The delivery lock prevents a mutation from publishing between the view
    /// and revision reads, allowing the HTTP adapter to register first, emit one
    /// snapshot, then discard buffered events at or before this revision.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] when persisted settings cannot be read.
    pub fn sync_snapshot(
        &self,
    ) -> Result<(u64, DebruteGlobalSettingsView, Option<Value>), GlobalSettingsError> {
        let _delivery = self.lock_delivery();
        let view = self.settings_get()?;
        let events = self.lock_events();
        Ok((events.revision, view, events.product.clone()))
    }

    /// Publishes one Runtime-owned projection that is not stored by the global
    /// settings module, while retaining the same monotonic Global revision.
    ///
    pub fn publish_external(&self, change: GlobalRuntimeChange) {
        let _delivery = self.lock_delivery();
        let _commit = self.lock_commit();
        self.publish(change);
    }

    /// Returns the complete settings view with a cached or freshly scanned
    /// integration projection.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] when persisted settings cannot be read.
    pub fn settings_get(&self) -> Result<DebruteGlobalSettingsView, GlobalSettingsError> {
        let candidate = self.integration_candidate(false);
        let _commit = self.lock_commit();
        let integrations = self.adopt_integration_candidate(candidate);
        let projection = self.store.read_view(&self.catalog)?;
        Ok(complete_view(projection, integrations))
    }

    /// Returns one exact configured Model API key without changing or
    /// publishing Global state.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] when the Model is unknown, has no key,
    /// or persisted Global state cannot be read.
    pub fn reveal_model_api_key(&self, model_id: &str) -> Result<String, GlobalSettingsError> {
        self.store.read_model_api_key(model_id, &self.catalog)
    }

    /// Applies one settings patch and publishes exactly one revision only when
    /// persisted public or secret state changed.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] for invalid input or state failures.
    pub fn settings_save(
        &self,
        input: &Value,
    ) -> Result<DebruteGlobalSettingsView, GlobalSettingsError> {
        let candidate = self.integration_candidate(false);
        let _delivery = self.lock_delivery();
        let (view, change) = {
            let _commit = self.lock_commit();
            let integrations = self.adopt_integration_candidate(candidate);
            let result = self.store.patch(input, &self.catalog)?;
            let view = complete_view(result.view, integrations);
            let change = result
                .changed
                .then(|| GlobalRuntimeChange::GlobalSettingsChanged(view.clone()));
            (view, change)
        };
        if let Some(change) = change {
            self.publish(change);
        }
        Ok(view)
    }

    /// Updates the recent Project MRU and its revisioned projections.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] for persistence failures.
    pub fn remember_recent_project(
        &self,
        project_id: &str,
        project_root: &str,
    ) -> Result<bool, GlobalSettingsError> {
        let _delivery = self.lock_delivery();
        let (changed, change) = {
            let _commit = self.lock_commit();
            let result =
                self.store
                    .remember_recent_project(project_id, project_root, &self.catalog)?;
            let change = result
                .changed
                .then_some(GlobalRuntimeChange::RecentProjectsChanged(
                    result.recent_projects,
                ));
            (result.changed, change)
        };
        if let Some(change) = change {
            self.publish(change);
        }
        Ok(changed)
    }

    /// Clears the recent Project projection.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] for persistence failures.
    pub fn clear_recent_projects(&self) -> Result<bool, GlobalSettingsError> {
        let _delivery = self.lock_delivery();
        let (changed, change) = {
            let _commit = self.lock_commit();
            let result = self.store.clear_recent_projects(&self.catalog)?;
            let change = result
                .changed
                .then_some(GlobalRuntimeChange::RecentProjectsChanged(
                    result.recent_projects,
                ));
            (result.changed, change)
        };
        if let Some(change) = change {
            self.publish(change);
        }
        Ok(changed)
    }

    /// Forces one integration rescan and publishes its complete projection.
    ///
    /// # Panics
    ///
    /// Panics when a monotonic Runtime ordering counter is exhausted.
    pub fn integrations_rescan(&self) {
        let candidate = self.integration_candidate(true);
        let _delivery = self.lock_delivery();
        let view = {
            let _commit = self.lock_commit();
            self.adopt_integration_candidate(candidate)
        };
        self.publish(GlobalRuntimeChange::IntegrationsChanged(view));
    }

    /// Runs one closed integration operation with start and settled revisions.
    ///
    #[must_use]
    pub fn integrations_run_operation(
        &self,
        integration_id: &str,
        operation: IntegrationOperation,
    ) -> IntegrationOperationResult {
        self.integrations.run_operation_observed(
            integration_id,
            operation,
            |started| self.commit_integration_view(started.clone()),
            |settled| self.commit_integration_view(settled.clone()),
        )
    }

    fn integration_candidate(&self, force: bool) -> (u64, IntegrationSettingsView) {
        let generation = self
            .integration_projection
            .lock()
            .expect("integration projection lock poisoned")
            .generation;
        let view = if force {
            self.integrations.rescan()
        } else {
            self.integrations.list_status()
        };
        (generation, view)
    }

    fn adopt_integration_candidate(
        &self,
        candidate: (u64, IntegrationSettingsView),
    ) -> IntegrationSettingsView {
        let (generation, view) = candidate;
        let mut projection = self
            .integration_projection
            .lock()
            .expect("integration projection lock poisoned");
        if projection.generation == generation || projection.view.is_none() {
            projection.generation = projection
                .generation
                .checked_add(1)
                .expect("Global integration projection generation exhausted");
            projection.view = Some(view.clone());
            return view;
        }
        projection
            .view
            .clone()
            .expect("integration projection must exist after adoption")
    }

    fn commit_integration_view(&self, view: IntegrationSettingsView) {
        let _delivery = self.lock_delivery();
        let change = {
            let _commit = self.lock_commit();
            let mut projection = self
                .integration_projection
                .lock()
                .expect("integration projection lock poisoned");
            projection.generation = projection
                .generation
                .checked_add(1)
                .expect("Global integration projection generation exhausted");
            projection.view = Some(view.clone());
            drop(projection);
            GlobalRuntimeChange::IntegrationsChanged(view)
        };
        self.publish(change);
    }

    fn lock_commit(&self) -> std::sync::MutexGuard<'_, ()> {
        self.commit.lock().expect("Global commit lock poisoned")
    }

    fn lock_delivery(&self) -> std::sync::MutexGuard<'_, ()> {
        self.delivery.lock().expect("Global delivery lock poisoned")
    }

    fn publish(&self, change: GlobalRuntimeChange) {
        let mut events = self
            .events
            .lock()
            .expect("Global event state lock poisoned");
        if let GlobalRuntimeChange::ProductChanged(product) = &change {
            events.product = Some(product.clone());
        }
        events.revision = events
            .revision
            .checked_add(1)
            .expect("Global Runtime revision exhausted");
        let event = GlobalRuntimeEvent {
            revision: events.revision,
            change,
        };
        let observer = events.observer.clone();
        drop(events);
        if let Some(observer) = observer {
            observer(event);
        }
    }

    fn lock_events(&self) -> std::sync::MutexGuard<'_, GlobalEventState> {
        self.events
            .lock()
            .expect("Global event state lock poisoned")
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
