use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;

use crate::login::{StartAtLoginSetting, StartAtLoginSnapshot};
use crate::models::ModelCatalog;
use crate::photoshop::PhotoshopStateView;

use super::{
    models::ModelSettingsView,
    store::{
        ChromeSettings, FeedbackSettings, GlobalConfigStore, GlobalSettingsError,
        GlobalSettingsMutation, GlobalSettingsView, IntegrationSettings, WorkbenchSettings,
    },
};

pub type GlobalRuntimeObserver = Arc<dyn Fn(GlobalRuntimeEvent) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettingsView {
    pub start_at_login: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebruteGlobalSettingsView {
    pub runtime: RuntimeSettingsView,
    pub workbench: WorkbenchSettings,
    pub canvas: super::store::CanvasSettings,
    pub chrome: ChromeSettings,
    pub integrations: IntegrationSettings,
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
    start_at_login: Arc<dyn StartAtLoginSetting>,
    commit: Mutex<()>,
    delivery: Mutex<()>,
    events: Mutex<GlobalEventState>,
}

#[derive(Default)]
struct GlobalEventState {
    revision: u64,
    observer: Option<GlobalRuntimeObserver>,
    product: Option<Value>,
    start_at_login: StartAtLoginSnapshot,
}

impl GlobalRuntimeService {
    #[must_use]
    pub fn new(
        store: impl Into<Arc<GlobalConfigStore>>,
        catalog: impl Into<Arc<ModelCatalog>>,
        start_at_login: Arc<dyn StartAtLoginSetting>,
    ) -> Arc<Self> {
        let start_at_login_snapshot = start_at_login.snapshot();
        let service = Arc::new(Self {
            store: store.into(),
            catalog: catalog.into(),
            start_at_login,
            commit: Mutex::new(()),
            delivery: Mutex::new(()),
            events: Mutex::new(GlobalEventState {
                start_at_login: start_at_login_snapshot,
                ..GlobalEventState::default()
            }),
        });
        let weak_service = Arc::downgrade(&service);
        assert!(
            service
                .start_at_login
                .install_observer(Arc::new(move |snapshot| {
                    let Some(service) = weak_service.upgrade() else {
                        return;
                    };
                    if let Err(error) = service.publish_start_at_login_changed(snapshot) {
                        eprintln!("Start at Login settings event could not be published: {error}");
                    }
                },))
        );
        service
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

    /// Returns the complete Runtime-owned Global Settings view without probing
    /// optional Photoshop plugin support.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] when persisted settings cannot be read.
    pub fn settings_get(&self) -> Result<DebruteGlobalSettingsView, GlobalSettingsError> {
        let _commit = self.lock_commit();
        let projection = self.store.read_view(&self.catalog)?;
        Ok(complete_view(projection, self.current_start_at_login()))
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
        if let GlobalSettingsMutation::SetStartAtLogin { enabled } = input {
            self.start_at_login
                .set_enabled(*enabled)
                .map_err(|error| GlobalSettingsError::Native(error.to_string()))?;
            return self.settings_get();
        }
        let _delivery = self.lock_delivery();
        let (view, change) = {
            let _commit = self.lock_commit();
            let result = self.store.mutate(input, &self.catalog)?;
            let view = complete_view(result.view, self.current_start_at_login());
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

    fn publish_start_at_login_changed(
        &self,
        snapshot: StartAtLoginSnapshot,
    ) -> Result<(), GlobalSettingsError> {
        let _delivery = self.lock_delivery();
        let view = {
            let _commit = self.lock_commit();
            self.lock_events().start_at_login = snapshot;
            complete_view(self.store.read_view(&self.catalog)?, snapshot)
        };
        self.publish(GlobalRuntimeChange::GlobalSettingsChanged(Box::new(view)));
        Ok(())
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

    fn current_start_at_login(&self) -> StartAtLoginSnapshot {
        self.lock_events().start_at_login
    }
}

fn complete_view(
    projection: GlobalSettingsView,
    start_at_login: StartAtLoginSnapshot,
) -> DebruteGlobalSettingsView {
    DebruteGlobalSettingsView {
        runtime: RuntimeSettingsView {
            start_at_login: start_at_login.enabled,
        },
        workbench: projection.workbench,
        canvas: projection.canvas,
        chrome: projection.chrome,
        integrations: projection.integrations,
        feedback: projection.feedback,
        models: projection.models,
    }
}
