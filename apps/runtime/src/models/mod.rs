use serde::Deserialize;

use crate::{model_operation::ModelKind, model_request::common::ModelExecutor};

mod dashscope_qwen3_tts_flash;
mod doubao_seed_tts_2_0;
mod doubao_seedance_2_0_260128;
mod doubao_seedance_2_0_fast_260128;
mod doubao_seedance_2_0_mini_260615;
mod doubao_seedream_5_0_lite_260128;
mod doubao_seedream_5_0_pro_260628;
mod elevenlabs_multilingual_v2;
mod elevenlabs_music;
mod elevenlabs_sound_effects;
mod elevenlabs_v3_tts;
mod fal_ai_flux_dev;
mod fal_ai_flux_dev_image_to_image;
mod fal_stable_audio_3_small_sfx;
mod fal_stable_audio_text_to_audio;
mod gemini_3_1_flash_image;
mod gemini_3_1_flash_tts_preview;
mod gemini_3_pro_image;
mod google_lyria_3_clip_preview;
mod google_lyria_3_pro_preview;
mod gpt_image_1;
mod gpt_image_2;
mod grok_imagine;
mod image_01;
mod minimax_h3;
mod minimax_music_3_0;
mod minimax_speech_2_8_hd;
mod openai_gpt_4o_mini_tts;
mod openai_tts_1;
mod openai_tts_1_hd;
mod qwen_image_2_0_2026_03_03;
mod qwen_image_2_0_pro_2026_06_22;
mod wan2_7_image;

#[cfg(test)]
pub(crate) mod testing;

type RegistrationFactory = fn() -> ModelDefinition;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DefinitionFile {
    id: String,
    kind: ModelKind,
    summary: String,
    default_base_url: String,
    default_request_model_id: String,
    arguments_schema: serde_json::Value,
}

pub struct ModelDefinition {
    data: DefinitionFile,
    manual: &'static str,
    executor: ModelExecutor,
}

pub struct ModelCatalog {
    definitions: Vec<ModelDefinition>,
}

impl ModelDefinition {
    #[must_use]
    pub fn id(&self) -> &str {
        &self.data.id
    }

    #[must_use]
    pub const fn kind(&self) -> ModelKind {
        self.data.kind
    }

    #[must_use]
    pub fn summary(&self) -> &str {
        &self.data.summary
    }

    #[must_use]
    pub fn default_base_url(&self) -> &str {
        &self.data.default_base_url
    }

    #[must_use]
    pub fn default_request_model_id(&self) -> &str {
        &self.data.default_request_model_id
    }

    #[must_use]
    pub const fn arguments_schema(&self) -> &serde_json::Value {
        &self.data.arguments_schema
    }

    #[must_use]
    pub const fn manual(&self) -> &'static str {
        self.manual
    }

    pub(crate) fn executor(&self) -> ModelExecutor {
        self.executor
    }
}

impl ModelCatalog {
    #[must_use]
    pub fn bundled() -> Self {
        let factories: &[RegistrationFactory] = &[
            doubao_seedream_5_0_lite_260128::registration,
            doubao_seedream_5_0_pro_260628::registration,
            fal_ai_flux_dev::registration,
            fal_ai_flux_dev_image_to_image::registration,
            gemini_3_1_flash_image::registration,
            gemini_3_pro_image::registration,
            gpt_image_1::registration,
            gpt_image_2::registration,
            grok_imagine::registration,
            image_01::registration,
            qwen_image_2_0_pro_2026_06_22::registration,
            qwen_image_2_0_2026_03_03::registration,
            wan2_7_image::registration,
            doubao_seedance_2_0_260128::registration,
            doubao_seedance_2_0_fast_260128::registration,
            doubao_seedance_2_0_mini_260615::registration,
            minimax_h3::registration,
            dashscope_qwen3_tts_flash::registration,
            doubao_seed_tts_2_0::registration,
            elevenlabs_multilingual_v2::registration,
            elevenlabs_music::registration,
            elevenlabs_sound_effects::registration,
            elevenlabs_v3_tts::registration,
            fal_stable_audio_3_small_sfx::registration,
            fal_stable_audio_text_to_audio::registration,
            gemini_3_1_flash_tts_preview::registration,
            google_lyria_3_clip_preview::registration,
            google_lyria_3_pro_preview::registration,
            minimax_music_3_0::registration,
            minimax_speech_2_8_hd::registration,
            openai_gpt_4o_mini_tts::registration,
            openai_tts_1::registration,
            openai_tts_1_hd::registration,
        ];
        let definitions = factories
            .iter()
            .map(|factory| factory())
            .collect::<Vec<_>>();
        Self { definitions }
    }

    #[must_use]
    pub fn all(&self) -> &[ModelDefinition] {
        &self.definitions
    }

    #[must_use]
    pub fn find(&self, id: &str) -> Option<&ModelDefinition> {
        self.definitions
            .iter()
            .find(|definition| definition.id() == id)
    }

    pub fn by_kind(&self, kind: ModelKind) -> impl Iterator<Item = &ModelDefinition> {
        self.definitions
            .iter()
            .filter(move |definition| definition.kind() == kind)
    }
}

fn bind(
    definition: &'static str,
    manual: &'static str,
    executor: ModelExecutor,
) -> ModelDefinition {
    let data = serde_json::from_str::<DefinitionFile>(definition)
        .expect("bundled exact Model definition must be valid");
    ModelDefinition {
        data,
        manual,
        executor,
    }
}
