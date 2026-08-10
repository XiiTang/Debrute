use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;

use crate::models::ModelCatalog;
use crate::photoshop::PhotoshopStateView;

use super::{
    models::ModelSettingsView,
    store::{
        ChromeSettings, FeedbackSettings, GlobalConfigStore, GlobalSettingsError,
        GlobalSettingsMutation, GlobalSettingsView, PluginSettings, WorkbenchSettings,
    },
};

pub type GlobalRuntimeObserver = Arc<dyn Fn(GlobalRuntimeEvent) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebruteGlobalSettingsView {
    pub workbench: WorkbenchSettings,
    pub canvas: super::store::CanvasSettings,
    pub chrome: ChromeSettings,
    pub plugins: PluginSettings,
    pub feedback: FeedbackSettings,
    pub models: ModelSettingsView,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GlobalRuntimeEvent {
    pub revision: u64,
    pub change: GlobalRuntimeChange,
}

#[derive(Debug, Clone, PartialEq)]
pub enum GlobalRuntimeChange {
    GlobalSettingsChanged(Box<DebruteGlobalSettingsView>),
    RecentProjectsChanged(Vec<String>),
    PhotoshopChanged(PhotoshopStateView),
    ProductChanged(Value),
}

pub struct GlobalRuntimeService {
    store: Arc<GlobalConfigStore>,
    catalog: Arc<ModelCatalog>,
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

impl GlobalRuntimeService {
    #[must_use]
    pub fn new(
        store: impl Into<Arc<GlobalConfigStore>>,
        catalog: impl Into<Arc<ModelCatalog>>,
    ) -> Self {
        Self {
            store: store.into(),
            catalog: catalog.into(),
            commit: Mutex::new(()),
            delivery: Mutex::new(()),
            events: Mutex::new(GlobalEventState::default()),
        }
    }

    /// Publishes the Runtime-owned Product projection through the same ordered
    /// Global stream as settings and other Runtime-owned projections.
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

    /// Reads the native Desktop presentation.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] when persisted global state is invalid.
    pub fn desktop_presentation_snapshot(
        &self,
    ) -> Result<(Vec<String>, String), GlobalSettingsError> {
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

    /// Returns the complete persisted Global Settings view without probing
    /// optional Photoshop plugin support.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] when persisted settings cannot be read.
    pub fn settings_get(&self) -> Result<DebruteGlobalSettingsView, GlobalSettingsError> {
        let _commit = self.lock_commit();
        let projection = self.store.read_view(&self.catalog)?;
        Ok(complete_view(projection))
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

    /// Applies one settings intent and publishes exactly one revision only when
    /// persisted public or secret state changed.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] for invalid input or state failures.
    pub fn settings_mutate(
        &self,
        input: &GlobalSettingsMutation,
    ) -> Result<DebruteGlobalSettingsView, GlobalSettingsError> {
        let _delivery = self.lock_delivery();
        let (view, change) = {
            let _commit = self.lock_commit();
            let result = self.store.mutate(input, &self.catalog)?;
            let view = complete_view(result.view);
            let change = result
                .changed
                .then(|| GlobalRuntimeChange::GlobalSettingsChanged(Box::new(view.clone())));
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
        canonical_root: &str,
    ) -> Result<bool, GlobalSettingsError> {
        let _delivery = self.lock_delivery();
        let (changed, change) = {
            let _commit = self.lock_commit();
            let result = self
                .store
                .remember_recent_project(canonical_root, &self.catalog)?;
            let change = result
                .changed
                .then_some(GlobalRuntimeChange::RecentProjectsChanged(
                    result.recent_project_roots,
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
                    result.recent_project_roots,
                ));
            (result.changed, change)
        };
        if let Some(change) = change {
            self.publish(change);
        }
        Ok(changed)
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

fn complete_view(projection: GlobalSettingsView) -> DebruteGlobalSettingsView {
    DebruteGlobalSettingsView {
        workbench: projection.workbench,
        canvas: projection.canvas,
        chrome: projection.chrome,
        plugins: projection.plugins,
        feedback: projection.feedback,
        models: projection.models,
    }
}
