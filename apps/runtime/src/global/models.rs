use serde::Serialize;

use crate::{
    model_operation::ModelKind,
    models::{ModelCatalog, ModelDefinition},
};

use super::store::{GlobalConfigSnapshot, ModelConfig};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettingRecord {
    pub debrute_model_id: String,
    pub summary: String,
    pub default_base_url: String,
    pub default_request_model_id: String,
    pub base_url_override: Option<String>,
    pub request_model_id_override: Option<String>,
    pub api_key_set: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioModelSettingRecord {
    pub kind: ModelKind,
    #[serde(flatten)]
    pub setting: ModelSettingRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelSettingsView {
    pub image: Vec<ModelSettingRecord>,
    pub video: Vec<ModelSettingRecord>,
    pub audio: Vec<AudioModelSettingRecord>,
}

pub(crate) fn settings_view(
    snapshot: &GlobalConfigSnapshot,
    catalog: &ModelCatalog,
) -> ModelSettingsView {
    ModelSettingsView {
        image: catalog
            .by_kind(ModelKind::Image)
            .map(|definition| model_setting(snapshot, definition))
            .collect(),
        video: catalog
            .by_kind(ModelKind::Video)
            .map(|definition| model_setting(snapshot, definition))
            .collect(),
        audio: catalog
            .all()
            .iter()
            .filter(|definition| is_audio_kind(definition.kind()))
            .map(|definition| audio_setting(snapshot, definition))
            .collect(),
    }
}

fn model_setting(
    snapshot: &GlobalConfigSnapshot,
    definition: &ModelDefinition,
) -> ModelSettingRecord {
    let configured = find_config(&snapshot.settings.models, definition.id());
    ModelSettingRecord {
        debrute_model_id: definition.id().to_owned(),
        summary: definition.summary().to_owned(),
        default_base_url: definition.default_base_url().to_owned(),
        default_request_model_id: definition.default_request_model_id().to_owned(),
        base_url_override: configured.and_then(|value| value.base_url_override.clone()),
        request_model_id_override: configured
            .and_then(|value| value.request_model_id_override.clone()),
        api_key_set: api_key_is_set(snapshot, definition.id()),
    }
}

fn audio_setting(
    snapshot: &GlobalConfigSnapshot,
    definition: &ModelDefinition,
) -> AudioModelSettingRecord {
    AudioModelSettingRecord {
        kind: definition.kind(),
        setting: model_setting(snapshot, definition),
    }
}

const fn is_audio_kind(kind: ModelKind) -> bool {
    matches!(
        kind,
        ModelKind::Tts | ModelKind::Music | ModelKind::SoundEffect
    )
}

fn find_config<'a>(configs: &'a [ModelConfig], model_id: &str) -> Option<&'a ModelConfig> {
    configs
        .iter()
        .find(|config| config.debrute_model_id == model_id)
}

fn api_key_is_set(snapshot: &GlobalConfigSnapshot, model_id: &str) -> bool {
    snapshot.secrets.model_api_keys.contains_key(model_id)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn settings_projection_serializes_the_current_shape_and_groups_catalog_models_dynamically() {
        let catalog = ModelCatalog::bundled();
        let view = settings_view(&GlobalConfigSnapshot::default(), &catalog);
        let mut image = Vec::new();
        let mut video = Vec::new();
        let mut audio = Vec::new();
        for definition in catalog.all() {
            let record = serialized_setting(definition);
            match definition.kind() {
                ModelKind::Image => image.push(record),
                ModelKind::Video => video.push(record),
                ModelKind::Tts | ModelKind::Music | ModelKind::SoundEffect => {
                    let mut record = record.as_object().expect("setting record").clone();
                    record.insert(
                        "kind".to_owned(),
                        serde_json::to_value(definition.kind())
                            .expect("Model kind should serialize"),
                    );
                    audio.push(Value::Object(record));
                }
            }
        }

        assert_eq!(
            serde_json::to_value(view).expect("settings view should serialize"),
            json!({ "image": image, "video": video, "audio": audio })
        );
    }

    fn serialized_setting(definition: &ModelDefinition) -> Value {
        json!({
            "debruteModelId": definition.id(),
            "summary": definition.summary(),
            "defaultBaseUrl": definition.default_base_url(),
            "defaultRequestModelId": definition.default_request_model_id(),
            "baseUrlOverride": null,
            "requestModelIdOverride": null,
            "apiKeySet": false
        })
    }
}
