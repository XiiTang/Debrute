use std::{collections::BTreeMap, time::Duration};

use serde_json::{Value, json};

use crate::project::GeneratedArtifactRole;

use super::{
    common::{ExecutionContext, authorization, execute_result, extension_for_mime},
    types::{GeneratedPayload, GenerationError, ModelExecution},
};

mod elevenlabs_multilingual_v2;
mod elevenlabs_music_v2;
mod elevenlabs_sound_effects_v2;
mod elevenlabs_v3_tts;
mod fal_stable_audio_2_5;
mod fal_stable_audio_3_small_sfx;
mod gemini_3_1_flash_tts_preview;
mod lyria_3_clip_preview;
mod lyria_3_pro_preview;
mod minimax_music_3_0;
mod minimax_speech_2_8_hd;
mod openai_gpt_4o_mini_tts;
mod openai_tts_1;
mod openai_tts_1_hd;
mod qwen3_tts_flash;
mod seed_tts_2_0;

const POLL_INTERVAL: Duration = Duration::from_secs(1);

pub(crate) fn execute(
    mut context: ExecutionContext<'_>,
) -> Result<ModelExecution, GenerationError> {
    let result = match context.model.model_id.as_str() {
        "openai-gpt-4o-mini-tts" => openai_gpt_4o_mini_tts::execute(&mut context),
        "openai-tts-1" => openai_tts_1::execute(&mut context),
        "openai-tts-1-hd" => openai_tts_1_hd::execute(&mut context),
        "elevenlabs-v3-tts" => elevenlabs_v3_tts::execute(&mut context),
        "elevenlabs-multilingual-v2" => elevenlabs_multilingual_v2::execute(&mut context),
        "gemini-3-1-flash-tts-preview" => gemini_3_1_flash_tts_preview::execute(&mut context),
        "minimax-speech-2-8-hd" => minimax_speech_2_8_hd::execute(&mut context),
        "dashscope-qwen3-tts-flash" => qwen3_tts_flash::execute(&mut context),
        "doubao-seed-tts-2-0" => seed_tts_2_0::execute(&mut context),
        "elevenlabs-music" => elevenlabs_music_v2::execute(&mut context),
        "google-lyria-3-clip-preview" => lyria_3_clip_preview::execute(&mut context),
        "google-lyria-3-pro-preview" => lyria_3_pro_preview::execute(&mut context),
        "minimax-music-3-0" => minimax_music_3_0::execute(&mut context),
        "fal-stable-audio-text-to-audio" => fal_stable_audio_2_5::execute(&mut context),
        "fal-stable-audio-3-small-sfx" => fal_stable_audio_3_small_sfx::execute(&mut context),
        "elevenlabs-sound-effects" => elevenlabs_sound_effects_v2::execute(&mut context),
        model => Err(GenerationError::new(
            "audio_model_unavailable",
            format!("Audio model adapter is unavailable: {model}"),
        )),
    }?;
    execute_result(result.payloads, result.safe_request, context)
}

struct AudioResult {
    payloads: Vec<GeneratedPayload>,
    safe_request: Value,
}

fn audio_payload(
    bytes: Vec<u8>,
    mime: &str,
    context: &ExecutionContext<'_>,
) -> Result<GeneratedPayload, GenerationError> {
    if !mime.starts_with("audio/") {
        return Err(GenerationError::new(
            "generated_artifact_type_unsupported",
            format!("Generated audio has non-audio MIME type: {mime}"),
        ));
    }
    let role = audio_role(context)?;
    extension_for_mime(mime)?;
    Ok(GeneratedPayload {
        bytes,
        mime_type: mime.to_owned(),
        role,
        model_output: Value::Null,
    })
}

fn single_audio_result(
    bytes: Vec<u8>,
    mime: &str,
    context: &ExecutionContext<'_>,
    url: &str,
    body: &Value,
) -> Result<AudioResult, GenerationError> {
    single_audio_result_with_headers(
        bytes,
        mime,
        audio_role(context)?,
        &authorization(&context.model.api_key),
        url,
        body,
    )
}

fn single_audio_result_with_headers(
    bytes: Vec<u8>,
    mime: &str,
    role: GeneratedArtifactRole,
    headers: &BTreeMap<String, String>,
    url: &str,
    body: &Value,
) -> Result<AudioResult, GenerationError> {
    extension_for_mime(mime)?;
    Ok(AudioResult {
        payloads: vec![GeneratedPayload {
            bytes,
            mime_type: mime.to_owned(),
            role,
            model_output: Value::Null,
        }],
        safe_request: json!({"method": "POST", "url": url, "headers": headers, "body": body}),
    })
}

fn audio_role(context: &ExecutionContext<'_>) -> Result<GeneratedArtifactRole, GenerationError> {
    match context.model.kind {
        crate::model_operation::ModelKind::Tts => Ok(GeneratedArtifactRole::TtsAudio),
        crate::model_operation::ModelKind::Music => Ok(GeneratedArtifactRole::MusicAudio),
        crate::model_operation::ModelKind::SoundEffect => {
            Ok(GeneratedArtifactRole::SoundEffectAudio)
        }
        _ => Err(GenerationError::new(
            "model_catalog_invalid",
            "Audio adapter received a non-audio generation kind.",
        )),
    }
}

fn decode_hex(value: &str) -> Result<Vec<u8>, GenerationError> {
    if !value.len().is_multiple_of(2) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GenerationError::new(
            "model_response_invalid",
            "MiniMax audio was not an even-length hexadecimal string.",
        ));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).map_err(|error| {
                GenerationError::new("model_response_invalid", error.to_string())
            })?;
            u8::from_str_radix(text, 16)
                .map_err(|error| GenerationError::new("model_response_invalid", error.to_string()))
        })
        .collect()
}

fn assert_same_origin(base: &str, candidate: &str) -> Result<(), GenerationError> {
    let base = url::Url::parse(base)
        .map_err(|error| GenerationError::new("model_configuration_invalid", error.to_string()))?;
    let candidate = url::Url::parse(candidate)
        .map_err(|error| GenerationError::new("model_response_invalid", error.to_string()))?;
    if base.scheme() == candidate.scheme()
        && base.host_str() == candidate.host_str()
        && base.port_or_known_default() == candidate.port_or_known_default()
    {
        Ok(())
    } else {
        Err(GenerationError::new(
            "model_response_invalid",
            "Model task URL changed origin.",
        ))
    }
}
