//! Runtime-owned global settings, recent Projects, and bundled model catalog.

mod models;
mod root_state;
mod runtime;
mod store;

pub(crate) use root_state::{root_cache_directory, root_state_directory};

pub use models::{AudioModelSettingRecord, ModelSettingRecord, ModelSettingsView};
pub use runtime::{
    DebruteGlobalSettingsView, GlobalRuntimeChange, GlobalRuntimeEvent, GlobalRuntimeObserver,
    GlobalRuntimeService,
};
pub use store::{
    CanvasFontId, CanvasSettings, CanvasTextAppearance, ChromeSettings, FeedbackCatalogEntry,
    FeedbackSettings, GlobalConfigSnapshot, GlobalConfigStore, GlobalMutationResult,
    GlobalSettingsConfig, GlobalSettingsError, GlobalSettingsMutation, GlobalSettingsView,
    ModelConfig, PhotoshopPluginSettings, PluginSettings, RecentProjectsMutationResult,
    SaveModelSettingMutation, SecretsConfig, WorkbenchSettings,
};
