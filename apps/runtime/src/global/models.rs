use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::store::{GlobalConfigSnapshot, ModelConfig};

const BUNDLED_MODEL_CATALOG: &str = include_str!("../../../../assets/runtime-model-catalog.json");
const API_KEY_PREVIEW_MASK: &str = "****************************";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageModelCatalogEntry {
    pub debrute_model_id: String,
    pub summary: String,
    pub choose_when: String,
    pub avoid_when: String,
    pub supports_editing: bool,
    pub supports_text_rendering: bool,
    pub default_base_url: String,
    pub default_request_model_id: String,
    pub list_parameters: BTreeMap<String, String>,
    pub capabilities: serde_json::Value,
    pub arguments_schema: serde_json::Value,
    pub request_example: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the fields mirror the closed TypeScript model catalog contract"
)]
pub struct VideoModelCatalogEntry {
    pub debrute_model_id: String,
    pub summary: String,
    pub choose_when: String,
    pub avoid_when: String,
    pub supports_text_to_video: bool,
    pub supports_image_references: bool,
    pub supports_video_references: bool,
    pub supports_audio_references: bool,
    pub supports_generated_audio: bool,
    pub default_base_url: String,
    pub default_request_model_id: String,
    pub list_parameters: BTreeMap<String, String>,
    pub capabilities: serde_json::Value,
    pub arguments_schema: serde_json::Value,
    pub usage_notes: String,
    pub request_example: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioModelKind {
    Tts,
    Music,
    SoundEffect,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioModelCatalogEntry {
    pub debrute_model_id: String,
    pub kind: AudioModelKind,
    pub summary: String,
    pub choose_when: String,
    pub avoid_when: String,
    pub default_base_url: String,
    pub default_request_model_id: String,
    pub list_parameters: BTreeMap<String, String>,
    pub capabilities: serde_json::Value,
    pub arguments_schema: serde_json::Value,
    pub usage_notes: String,
    pub request_example: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelCatalog {
    image: Vec<ImageModelCatalogEntry>,
    video: Vec<VideoModelCatalogEntry>,
    audio: Vec<AudioModelCatalogEntry>,
}

impl ModelCatalog {
    /// Loads the strictly versioned catalog embedded in the Runtime binary.
    ///
    /// # Errors
    ///
    /// Returns a JSON error when the Product catalog is malformed.
    pub fn bundled() -> Result<Self, serde_json::Error> {
        let catalog: Self = serde_json::from_str(BUNDLED_MODEL_CATALOG)?;
        catalog.validate().map_err(serde_json::Error::io)?;
        Ok(catalog)
    }

    #[must_use]
    pub fn images(&self) -> &[ImageModelCatalogEntry] {
        &self.image
    }

    #[must_use]
    pub fn videos(&self) -> &[VideoModelCatalogEntry] {
        &self.video
    }

    #[must_use]
    pub fn audio(&self) -> &[AudioModelCatalogEntry] {
        &self.audio
    }

    #[must_use]
    pub fn tts(&self) -> Vec<&AudioModelCatalogEntry> {
        self.audio_kind(AudioModelKind::Tts)
    }

    #[must_use]
    pub fn music(&self) -> Vec<&AudioModelCatalogEntry> {
        self.audio_kind(AudioModelKind::Music)
    }

    #[must_use]
    pub fn sound_effects(&self) -> Vec<&AudioModelCatalogEntry> {
        self.audio_kind(AudioModelKind::SoundEffect)
    }

    #[must_use]
    pub fn contains_image(&self, model_id: &str) -> bool {
        self.image
            .iter()
            .any(|entry| entry.debrute_model_id == model_id)
    }

    #[must_use]
    pub fn contains_video(&self, model_id: &str) -> bool {
        self.video
            .iter()
            .any(|entry| entry.debrute_model_id == model_id)
    }

    #[must_use]
    pub fn contains_audio(&self, model_id: &str) -> bool {
        self.audio
            .iter()
            .any(|entry| entry.debrute_model_id == model_id)
    }

    fn audio_kind(&self, kind: AudioModelKind) -> Vec<&AudioModelCatalogEntry> {
        self.audio
            .iter()
            .filter(|entry| entry.kind == kind)
            .collect()
    }

    fn validate(&self) -> Result<(), std::io::Error> {
        let mut ids = std::collections::BTreeSet::new();
        for id in self
            .image
            .iter()
            .map(|entry| entry.debrute_model_id.as_str())
            .chain(
                self.video
                    .iter()
                    .map(|entry| entry.debrute_model_id.as_str()),
            )
            .chain(
                self.audio
                    .iter()
                    .map(|entry| entry.debrute_model_id.as_str()),
            )
        {
            if id.trim().is_empty() || !ids.insert(id) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Runtime model catalog contains an empty or duplicate id: {id}"),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeySettingState {
    pub api_key_set: bool,
    pub api_key_preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageModelSettingRecord {
    pub debrute_model_id: String,
    pub summary: String,
    pub supports_editing: bool,
    pub supports_text_rendering: bool,
    pub default_base_url: String,
    pub default_request_model_id: String,
    pub base_url_override: Option<String>,
    pub request_model_id_override: Option<String>,
    pub api_key_set: bool,
    pub api_key_preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the fields mirror the public model settings protocol"
)]
pub struct VideoModelSettingRecord {
    pub debrute_model_id: String,
    pub summary: String,
    pub supports_text_to_video: bool,
    pub supports_image_references: bool,
    pub supports_video_references: bool,
    pub supports_audio_references: bool,
    pub supports_generated_audio: bool,
    pub default_base_url: String,
    pub default_request_model_id: String,
    pub base_url_override: Option<String>,
    pub request_model_id_override: Option<String>,
    pub api_key_set: bool,
    pub api_key_preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioModelSettingRecord {
    pub debrute_model_id: String,
    pub kind: AudioModelKind,
    pub summary: String,
    pub default_base_url: String,
    pub default_request_model_id: String,
    pub base_url_override: Option<String>,
    pub request_model_id_override: Option<String>,
    pub api_key_set: bool,
    pub api_key_preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImageModelSettingsView {
    pub models: Vec<ImageModelSettingRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VideoModelSettingsView {
    pub models: Vec<VideoModelSettingRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AudioModelSettingsView {
    pub models: Vec<AudioModelSettingRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelSettingsView {
    pub image: ImageModelSettingsView,
    pub video: VideoModelSettingsView,
    pub audio: AudioModelSettingsView,
}

pub(crate) fn settings_view(
    snapshot: &GlobalConfigSnapshot,
    catalog: &ModelCatalog,
) -> ModelSettingsView {
    ModelSettingsView {
        image: ImageModelSettingsView {
            models: catalog
                .image
                .iter()
                .map(|entry| {
                    let configured = find_config(
                        &snapshot.settings.models.image.image_models,
                        &entry.debrute_model_id,
                    );
                    let key = preview_state(
                        snapshot
                            .secrets
                            .image_model_api_keys
                            .get(&entry.debrute_model_id),
                    );
                    ImageModelSettingRecord {
                        debrute_model_id: entry.debrute_model_id.clone(),
                        summary: entry.summary.clone(),
                        supports_editing: entry.supports_editing,
                        supports_text_rendering: entry.supports_text_rendering,
                        default_base_url: entry.default_base_url.clone(),
                        default_request_model_id: entry.default_request_model_id.clone(),
                        base_url_override: configured
                            .and_then(|value| value.base_url_override.clone()),
                        request_model_id_override: configured
                            .and_then(|value| value.request_model_id_override.clone()),
                        api_key_set: key.api_key_set,
                        api_key_preview: key.api_key_preview,
                    }
                })
                .collect(),
        },
        video: VideoModelSettingsView {
            models: catalog
                .video
                .iter()
                .map(|entry| {
                    let configured = find_config(
                        &snapshot.settings.models.video.video_models,
                        &entry.debrute_model_id,
                    );
                    let key = preview_state(
                        snapshot
                            .secrets
                            .video_model_api_keys
                            .get(&entry.debrute_model_id),
                    );
                    VideoModelSettingRecord {
                        debrute_model_id: entry.debrute_model_id.clone(),
                        summary: entry.summary.clone(),
                        supports_text_to_video: entry.supports_text_to_video,
                        supports_image_references: entry.supports_image_references,
                        supports_video_references: entry.supports_video_references,
                        supports_audio_references: entry.supports_audio_references,
                        supports_generated_audio: entry.supports_generated_audio,
                        default_base_url: entry.default_base_url.clone(),
                        default_request_model_id: entry.default_request_model_id.clone(),
                        base_url_override: configured
                            .and_then(|value| value.base_url_override.clone()),
                        request_model_id_override: configured
                            .and_then(|value| value.request_model_id_override.clone()),
                        api_key_set: key.api_key_set,
                        api_key_preview: key.api_key_preview,
                    }
                })
                .collect(),
        },
        audio: AudioModelSettingsView {
            models: catalog
                .audio
                .iter()
                .map(|entry| {
                    let configured = find_config(
                        &snapshot.settings.models.audio.audio_models,
                        &entry.debrute_model_id,
                    );
                    let key = preview_state(
                        snapshot
                            .secrets
                            .audio_model_api_keys
                            .get(&entry.debrute_model_id),
                    );
                    AudioModelSettingRecord {
                        debrute_model_id: entry.debrute_model_id.clone(),
                        kind: entry.kind,
                        summary: entry.summary.clone(),
                        default_base_url: entry.default_base_url.clone(),
                        default_request_model_id: entry.default_request_model_id.clone(),
                        base_url_override: configured
                            .and_then(|value| value.base_url_override.clone()),
                        request_model_id_override: configured
                            .and_then(|value| value.request_model_id_override.clone()),
                        api_key_set: key.api_key_set,
                        api_key_preview: key.api_key_preview,
                    }
                })
                .collect(),
        },
    }
}

fn find_config<'a>(configs: &'a [ModelConfig], model_id: &str) -> Option<&'a ModelConfig> {
    configs
        .iter()
        .find(|config| config.debrute_model_id == model_id)
}

fn preview_state(api_key: Option<&String>) -> ApiKeySettingState {
    let (api_key_set, api_key_preview) = api_key_preview(api_key.map(String::as_str));
    ApiKeySettingState {
        api_key_set,
        api_key_preview,
    }
}

#[must_use]
pub fn api_key_preview(api_key: Option<&str>) -> (bool, Option<String>) {
    let trimmed = api_key.map(str::trim).unwrap_or_default();
    if trimmed.is_empty() {
        return (false, None);
    }
    if trimmed.len() < 8 {
        return (true, Some("****".to_owned()));
    }
    let prefix = trimmed.chars().take(2).collect::<String>();
    let suffix = trimmed
        .chars()
        .rev()
        .take(2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    (
        true,
        Some(format!("{prefix}{API_KEY_PREVIEW_MASK}{suffix}")),
    )
}

pub(crate) fn empty_secret_map() -> BTreeMap<String, String> {
    BTreeMap::new()
}
