use serde_json::{Map, Value, json};

use super::{AudioResult, single_audio_result};
use crate::generation::{
    common::{
        ExecutionContext, authorization, join_url, mime_from_path_or_bytes, mime_from_response,
    },
    types::{GenerationError, HttpBody, HttpMethod},
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<AudioResult, GenerationError> {
    let mut arguments = context.arguments.clone();
    let text = arguments.remove("text").ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "dashscope-qwen3-tts-flash requires text.",
        )
    })?;
    let voice = arguments.remove("voice").ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "dashscope-qwen3-tts-flash requires voice.",
        )
    })?;
    let mut input = Map::from_iter([("text".to_owned(), text), ("voice".to_owned(), voice)]);
    if let Some(language_type) = arguments.remove("language_type") {
        input.insert("language_type".to_owned(), language_type);
    }
    input.extend(arguments);
    let body = json!({
        "model": context.model.request_model_id,
        "input": input,
    });
    let url = join_url(
        &context.model.base_url,
        "services/aigc/multimodal-generation/generation",
    )?;
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(body.clone()),
    )?;
    let audio_url = response
        .pointer("/output/audio/url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "dashscope-qwen3-tts-flash response omitted output.audio.url.",
            )
        })?;
    let audio = context.download_generated_media(audio_url)?;
    let mime = mime_from_response(&audio)
        .filter(|mime| mime.starts_with("audio/"))
        .or_else(|| mime_from_path_or_bytes(audio_url, &audio.body).map(str::to_owned))
        .ok_or_else(|| {
            GenerationError::new(
                "generated_artifact_type_unsupported",
                "dashscope-qwen3-tts-flash output audio type could not be identified.",
            )
        })?;
    single_audio_result(audio.body, &mime, context, &url, &body)
}
