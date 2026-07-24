use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::store::{GlobalConfigSnapshot, ModelConfig};

const BUNDLED_MODEL_CATALOG: &str = include_str!("../../../../assets/runtime-model-catalog.json");

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelRequestExample {
    pub command: String,
    pub input: serde_json::Value,
}

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
    pub request_example: ModelRequestExample,
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
    pub request_example: ModelRequestExample,
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
    pub request_example: ModelRequestExample,
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

    #[must_use]
    pub fn contains(&self, model_id: &str) -> bool {
        self.contains_image(model_id)
            || self.contains_video(model_id)
            || self.contains_audio(model_id)
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelSettingsView {
    pub image: Vec<ImageModelSettingRecord>,
    pub video: Vec<VideoModelSettingRecord>,
    pub audio: Vec<AudioModelSettingRecord>,
}

pub(crate) fn settings_view(
    snapshot: &GlobalConfigSnapshot,
    catalog: &ModelCatalog,
) -> ModelSettingsView {
    ModelSettingsView {
        image: catalog
            .image
            .iter()
            .map(|entry| {
                let configured = find_config(&snapshot.settings.models, &entry.debrute_model_id);
                ImageModelSettingRecord {
                    debrute_model_id: entry.debrute_model_id.clone(),
                    summary: entry.summary.clone(),
                    supports_editing: entry.supports_editing,
                    supports_text_rendering: entry.supports_text_rendering,
                    default_base_url: entry.default_base_url.clone(),
                    default_request_model_id: entry.default_request_model_id.clone(),
                    base_url_override: configured.and_then(|value| value.base_url_override.clone()),
                    request_model_id_override: configured
                        .and_then(|value| value.request_model_id_override.clone()),
                    api_key_set: api_key_is_set(snapshot, &entry.debrute_model_id),
                }
            })
            .collect(),
        video: catalog
            .video
            .iter()
            .map(|entry| {
                let configured = find_config(&snapshot.settings.models, &entry.debrute_model_id);
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
                    base_url_override: configured.and_then(|value| value.base_url_override.clone()),
                    request_model_id_override: configured
                        .and_then(|value| value.request_model_id_override.clone()),
                    api_key_set: api_key_is_set(snapshot, &entry.debrute_model_id),
                }
            })
            .collect(),
        audio: catalog
            .audio
            .iter()
            .map(|entry| {
                let configured = find_config(&snapshot.settings.models, &entry.debrute_model_id);
                AudioModelSettingRecord {
                    debrute_model_id: entry.debrute_model_id.clone(),
                    kind: entry.kind,
                    summary: entry.summary.clone(),
                    default_base_url: entry.default_base_url.clone(),
                    default_request_model_id: entry.default_request_model_id.clone(),
                    base_url_override: configured.and_then(|value| value.base_url_override.clone()),
                    request_model_id_override: configured
                        .and_then(|value| value.request_model_id_override.clone()),
                    api_key_set: api_key_is_set(snapshot, &entry.debrute_model_id),
                }
            })
            .collect(),
    }
}

fn find_config<'a>(configs: &'a [ModelConfig], model_id: &str) -> Option<&'a ModelConfig> {
    configs
        .iter()
        .find(|config| config.debrute_model_id == model_id)
}

fn api_key_is_set(snapshot: &GlobalConfigSnapshot, model_id: &str) -> bool {
    snapshot.secrets.model_api_keys.contains_key(model_id)
}
