//! Runtime-owned global settings, recent Projects, and bundled model catalog.

mod models;
mod root_state;
mod runtime;
mod store;

pub(crate) use root_state::{root_cache_directory, root_state_directory};

pub use models::{
    AudioModelCatalogEntry, AudioModelKind, AudioModelSettingRecord, ImageModelCatalogEntry,
    ImageModelSettingRecord, ModelCatalog, ModelRequestExample, ModelSettingsView,
    VideoModelCatalogEntry, VideoModelSettingRecord,
};
pub use runtime::{
    DebruteGlobalSettingsView, GlobalRuntimeChange, GlobalRuntimeEvent, GlobalRuntimeObserver,
    GlobalRuntimeService,
};
pub use store::{
    CanvasFontId, CanvasSettings, CanvasTextAppearance, ChromeSettings, GlobalConfigSnapshot,
    GlobalConfigStore, GlobalMutationResult, GlobalSettingsConfig, GlobalSettingsError,
    GlobalSettingsView, ModelConfig, RecentProjectsMutationResult, SecretsConfig,
    WorkbenchSettings,
};
