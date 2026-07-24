use std::{collections::BTreeMap, time::Duration};

use serde_json::{Map, Value, json};

use crate::project::GeneratedArtifactRole;

use super::{
    common::{
        ExecutionContext, authorization, decode_base64, execute_result, extension_for_mime,
        join_url, mime_from_response, required_string,
    },
    types::{GeneratedPayload, GenerationError, HttpBody, HttpMethod, ModelExecution},
};

const POLL_INTERVAL: Duration = Duration::from_secs(1);

pub(crate) fn execute(
    mut context: ExecutionContext<'_>,
) -> Result<ModelExecution, GenerationError> {
    let result = match context.model.model_id.as_str() {
        "openai-gpt-4o-mini-tts" | "openai-tts-1" | "openai-tts-1-hd" => {
            execute_openai_tts(&mut context)
        }
        "elevenlabs-v3-tts" | "elevenlabs-multilingual-v2" => execute_elevenlabs_tts(&mut context),
        "gemini-tts" => execute_gemini_tts(&mut context),
        "minimax-speech-2-8-hd" => execute_minimax_tts(&mut context),
        "dashscope-qwen3-tts-flash" => execute_dashscope_tts(&mut context),
        "doubao-seed-tts-2-0" => execute_doubao_tts(&mut context),
        "elevenlabs-music" => execute_elevenlabs_music(&mut context),
        "google-lyria-3-clip-preview" | "google-lyria-3-pro-preview" => {
            execute_google_lyria(&mut context)
        }
        "minimax-music-2-6" => execute_minimax_music(&mut context),
        "fal-stable-audio-text-to-audio" | "fal-stable-audio-sfx" => execute_fal(&mut context),
        "elevenlabs-sound-effects" => execute_elevenlabs_sound_effects(&mut context),
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

fn execute_openai_tts(context: &mut ExecutionContext<'_>) -> Result<AudioResult, GenerationError> {
    let format = string_arg(context.arguments, "format").unwrap_or_else(|| "mp3".to_owned());
    let mut body = Map::from_iter([
        (
            "model".to_owned(),
            Value::String(context.model.request_model_id.clone()),
        ),
        (
            "input".to_owned(),
            required_argument(context.arguments, "text")?.clone(),
        ),
        (
            "voice".to_owned(),
            Value::String(
                string_arg(context.arguments, "voice").unwrap_or_else(|| "alloy".to_owned()),
            ),
        ),
        ("response_format".to_owned(), Value::String(format.clone())),
    ]);
    copy_if_present(context.arguments, &mut body, "speed");
    if context.model.request_model_id == "gpt-4o-mini-tts" {
        copy_if_present(context.arguments, &mut body, "instructions");
    }
    let url = join_url(&context.model.base_url, "audio/speech")?;
    let response = context.bytes(
        HttpMethod::Post,
        url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let mime = mime_from_response(&response).unwrap_or(mime_for_audio_format(&format)?.to_owned());
    let (bytes, mime) = if format == "pcm" {
        (
            wrap_pcm_as_wav(&response.body, 24_000, 1, 16)?,
            "audio/wav".to_owned(),
        )
    } else {
        (response.body, mime)
    };
    single_audio_result(bytes, &mime, context, &url, &Value::Object(body))
}

fn execute_elevenlabs_tts(
    context: &mut ExecutionContext<'_>,
) -> Result<AudioResult, GenerationError> {
    let voice = string_arg(context.arguments, "voice_id").ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "ElevenLabs TTS requires voice_id.",
        )
    })?;
    let format = string_arg(context.arguments, "format").unwrap_or_else(|| "mp3".to_owned());
    let output_format = elevenlabs_output_format(&format)?;
    let mut url = url::Url::parse(&format!(
        "{}/",
        context.model.base_url.trim_end_matches('/')
    ))
    .map_err(|error| GenerationError::new("model_configuration_invalid", error.to_string()))?;
    url.path_segments_mut()
        .map_err(|()| {
            GenerationError::new(
                "model_configuration_invalid",
                "ElevenLabs base URL cannot contain path segments.",
            )
        })?
        .extend(["text-to-speech", voice.as_str()]);
    url.query_pairs_mut()
        .append_pair("output_format", output_format);
    let mut settings = Map::new();
    for key in [
        "stability",
        "similarity_boost",
        "style",
        "speed",
        "use_speaker_boost",
    ] {
        copy_if_present(context.arguments, &mut settings, key);
    }
    let mut body = Map::from_iter([
        (
            "text".to_owned(),
            required_argument(context.arguments, "text")?.clone(),
        ),
        (
            "model_id".to_owned(),
            Value::String(context.model.request_model_id.clone()),
        ),
    ]);
    if !settings.is_empty() {
        body.insert("voice_settings".to_owned(), Value::Object(settings));
    }
    execute_elevenlabs_bytes(context, url.as_str(), &Value::Object(body), &format)
}

fn execute_elevenlabs_music(
    context: &mut ExecutionContext<'_>,
) -> Result<AudioResult, GenerationError> {
    let format = string_arg(context.arguments, "format").unwrap_or_else(|| "mp3".to_owned());
    let mut url = url::Url::parse(&join_url(&context.model.base_url, "music")?)
        .map_err(|error| GenerationError::new("model_configuration_invalid", error.to_string()))?;
    url.query_pairs_mut()
        .append_pair("output_format", elevenlabs_output_format(&format)?);
    let mut body = Map::from_iter([
        (
            "prompt".to_owned(),
            required_argument(context.arguments, "prompt")?.clone(),
        ),
        (
            "model_id".to_owned(),
            Value::String(context.model.request_model_id.clone()),
        ),
    ]);
    if let Some(duration) = context
        .arguments
        .get("duration_seconds")
        .and_then(Value::as_f64)
    {
        body.insert(
            "music_length_ms".to_owned(),
            json!((duration * 1_000.0).round()),
        );
    }
    if let Some(seed) = context.arguments.get("seed") {
        body.insert("seed".to_owned(), seed.clone());
    }
    if let Some(instrumental) = context.arguments.get("instrumental") {
        body.insert("force_instrumental".to_owned(), instrumental.clone());
    }
    execute_elevenlabs_bytes(context, url.as_str(), &Value::Object(body), &format)
}

fn execute_elevenlabs_sound_effects(
    context: &mut ExecutionContext<'_>,
) -> Result<AudioResult, GenerationError> {
    let format = string_arg(context.arguments, "format").unwrap_or_else(|| "mp3".to_owned());
    let mut url = url::Url::parse(&join_url(&context.model.base_url, "sound-generation")?)
        .map_err(|error| GenerationError::new("model_configuration_invalid", error.to_string()))?;
    url.query_pairs_mut()
        .append_pair("output_format", elevenlabs_output_format(&format)?);
    let mut body = Map::from_iter([
        (
            "text".to_owned(),
            required_argument(context.arguments, "prompt")?.clone(),
        ),
        (
            "model_id".to_owned(),
            Value::String(context.model.request_model_id.clone()),
        ),
    ]);
    copy_if_present(context.arguments, &mut body, "duration_seconds");
    copy_if_present(context.arguments, &mut body, "loop");
    execute_elevenlabs_bytes(context, url.as_str(), &Value::Object(body), &format)
}

fn execute_elevenlabs_bytes(
    context: &mut ExecutionContext<'_>,
    url: &str,
    body: &Value,
    format: &str,
) -> Result<AudioResult, GenerationError> {
    let headers = BTreeMap::from([
        ("xi-api-key".to_owned(), context.model.api_key.clone()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]);
    let response = context.bytes(
        HttpMethod::Post,
        url.to_owned(),
        headers.clone(),
        HttpBody::Json(body.clone()),
    )?;
    let mime = mime_from_response(&response)
        .filter(|value| value.starts_with("audio/"))
        .unwrap_or(mime_for_audio_format(format)?.to_owned());
    single_audio_result_with_headers(
        response.body,
        &mime,
        audio_role(context)?,
        &headers,
        url,
        body,
    )
}

fn execute_gemini_tts(context: &mut ExecutionContext<'_>) -> Result<AudioResult, GenerationError> {
    let text = required_argument(context.arguments, "text")?
        .as_str()
        .unwrap_or_default();
    let input = string_arg(context.arguments, "instructions").map_or_else(
        || text.to_owned(),
        |instructions| format!("{instructions}\n\n{text}"),
    );
    let body = json!({
        "model": context.model.request_model_id,
        "input": input,
        "response_format": {"type": "audio"},
        "generation_config": {"speech_config": [{
            "voice": string_arg(context.arguments, "voice").unwrap_or_else(|| "Kore".to_owned())
        }]}
    });
    execute_gemini_audio(context, &body, true)
}

fn execute_google_lyria(
    context: &mut ExecutionContext<'_>,
) -> Result<AudioResult, GenerationError> {
    let format = string_arg(context.arguments, "format").unwrap_or_else(|| "mp3".to_owned());
    let mut body = Map::from_iter([
        (
            "model".to_owned(),
            Value::String(context.model.request_model_id.clone()),
        ),
        (
            "input".to_owned(),
            required_argument(context.arguments, "prompt")?.clone(),
        ),
    ]);
    if format == "wav" {
        body.insert("response_format".to_owned(), json!({"type": "audio"}));
    }
    execute_gemini_audio(context, &Value::Object(body), false)
}

fn execute_gemini_audio(
    context: &mut ExecutionContext<'_>,
    body: &Value,
    pcm_defaults: bool,
) -> Result<AudioResult, GenerationError> {
    let url = join_url(&context.model.base_url, "interactions")?;
    let headers = BTreeMap::from([
        ("x-goog-api-key".to_owned(), context.model.api_key.clone()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]);
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        headers.clone(),
        HttpBody::Json(body.clone()),
    )?;
    let audio = response
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|step| step.get("type").and_then(Value::as_str) == Some("model_output"))
        .flat_map(|step| {
            step.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .find(|item| item.get("type").and_then(Value::as_str) == Some("audio"))
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "Gemini response omitted model_output audio content.",
            )
        })?;
    let encoded = audio.get("data").and_then(Value::as_str).ok_or_else(|| {
        GenerationError::new("model_response_invalid", "Gemini audio omitted data.")
    })?;
    let mime = audio
        .get("mime_type")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GenerationError::new("model_response_invalid", "Gemini audio omitted mime_type.")
        })?;
    let mut bytes = decode_base64(encoded, "Gemini audio")?;
    let mut stored_mime = mime.to_owned();
    if mime.starts_with("audio/pcm") || mime.starts_with("audio/l16") {
        let (rate, channels, bits) = pcm_parameters(mime, pcm_defaults)?;
        bytes = wrap_pcm_as_wav(&bytes, rate, channels, bits)?;
        "audio/wav".clone_into(&mut stored_mime);
    }
    single_audio_result_with_headers(
        bytes,
        &stored_mime,
        audio_role(context)?,
        &headers,
        &url,
        body,
    )
}

fn execute_minimax_tts(context: &mut ExecutionContext<'_>) -> Result<AudioResult, GenerationError> {
    let format = string_arg(context.arguments, "format").unwrap_or_else(|| "mp3".to_owned());
    let mut voice_setting = Map::from_iter([(
        "voice_id".to_owned(),
        Value::String(
            string_arg(context.arguments, "voice").unwrap_or_else(|| "male-qn-qingse".to_owned()),
        ),
    )]);
    copy_if_present(context.arguments, &mut voice_setting, "speed");
    copy_if_present(context.arguments, &mut voice_setting, "pitch");
    let body = Value::Object(Map::from_iter([
        (
            "model".to_owned(),
            Value::String(context.model.request_model_id.clone()),
        ),
        (
            "text".to_owned(),
            required_argument(context.arguments, "text")?.clone(),
        ),
        ("stream".to_owned(), Value::Bool(false)),
        ("output_format".to_owned(), Value::String("hex".to_owned())),
        ("voice_setting".to_owned(), Value::Object(voice_setting)),
        (
            "audio_setting".to_owned(),
            json!({
                "sample_rate": context.arguments.get("sample_rate").cloned().unwrap_or(json!(32000)),
                "bitrate": context.arguments.get("bitrate").cloned().unwrap_or(json!(128_000)),
                "format": format,
                "channel": 1,
            }),
        ),
    ]));
    execute_minimax_hex(context, "v1/t2a_v2", &body, &format)
}

fn execute_minimax_music(
    context: &mut ExecutionContext<'_>,
) -> Result<AudioResult, GenerationError> {
    let format = string_arg(context.arguments, "format").unwrap_or_else(|| "mp3".to_owned());
    let lyrics = string_arg(context.arguments, "lyrics");
    let mut body = Map::from_iter([
        (
            "model".to_owned(),
            Value::String(context.model.request_model_id.clone()),
        ),
        (
            "prompt".to_owned(),
            required_argument(context.arguments, "prompt")?.clone(),
        ),
        ("output_format".to_owned(), Value::String("hex".to_owned())),
        (
            "is_instrumental".to_owned(),
            Value::Bool(
                context
                    .arguments
                    .get("instrumental")
                    .and_then(Value::as_bool)
                    .unwrap_or(lyrics.is_none()),
            ),
        ),
        (
            "audio_setting".to_owned(),
            json!({
                "sample_rate": context.arguments.get("sample_rate").cloned().unwrap_or(json!(44100)),
                "bitrate": context.arguments.get("bitrate").cloned().unwrap_or(json!(256_000)),
                "format": format,
            }),
        ),
    ]);
    if let Some(lyrics) = lyrics {
        body.insert("lyrics".to_owned(), Value::String(lyrics));
    }
    execute_minimax_hex(
        context,
        "v1/music_generation",
        &Value::Object(body),
        &format,
    )
}

fn execute_minimax_hex(
    context: &mut ExecutionContext<'_>,
    endpoint: &str,
    body: &Value,
    requested_format: &str,
) -> Result<AudioResult, GenerationError> {
    let url = join_url(&context.model.base_url, endpoint)?;
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(body.clone()),
    )?;
    if response
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        .is_some_and(|code| code != 0)
    {
        return Err(GenerationError::new(
            "generation_task_failed",
            "MiniMax audio request returned a business error.",
        ));
    }
    let hex = required_string(&response, "/data/audio")?;
    let format = response
        .pointer("/extra_info/audio_format")
        .and_then(Value::as_str)
        .unwrap_or(requested_format);
    single_audio_result(
        decode_hex(&hex)?,
        mime_for_audio_format(format)?,
        context,
        &url,
        body,
    )
}

fn execute_dashscope_tts(
    context: &mut ExecutionContext<'_>,
) -> Result<AudioResult, GenerationError> {
    let mut input = Map::from_iter([
        (
            "text".to_owned(),
            required_argument(context.arguments, "text")?.clone(),
        ),
        (
            "voice".to_owned(),
            Value::String(
                string_arg(context.arguments, "voice").unwrap_or_else(|| "Cherry".to_owned()),
            ),
        ),
    ]);
    if let Some(language) = string_arg(context.arguments, "language") {
        input.insert("language_type".to_owned(), Value::String(language));
    }
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
    let artifact_url = required_string(&response, "/output/audio/url")?;
    let artifact = context.download(&artifact_url)?;
    let mime = mime_from_response(&artifact).unwrap_or_else(|| "audio/wav".to_owned());
    single_audio_result(artifact.body, &mime, context, &url, &body)
}

fn execute_doubao_tts(context: &mut ExecutionContext<'_>) -> Result<AudioResult, GenerationError> {
    let format = string_arg(context.arguments, "format").unwrap_or_else(|| "mp3".to_owned());
    let sample_rate = context
        .arguments
        .get("sample_rate")
        .and_then(Value::as_u64)
        .unwrap_or(24_000);
    let body = json!({
        "user": {"uid": "debrute"},
        "req_params": {
            "text": required_argument(context.arguments, "text")?,
            "speaker": string_arg(context.arguments, "voice").unwrap_or_else(|| "BV700_V2_streaming".to_owned()),
            "audio_params": {"format": format, "sample_rate": sample_rate},
        }
    });
    let url = join_url(&context.model.base_url, "tts/unidirectional")?;
    let headers = BTreeMap::from([
        ("x-api-key".to_owned(), context.model.api_key.clone()),
        (
            "x-api-resource-id".to_owned(),
            context.model.request_model_id.clone(),
        ),
        (
            "x-api-request-id".to_owned(),
            uuid::Uuid::new_v4().to_string(),
        ),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]);
    let response = context.bytes(
        HttpMethod::Post,
        url.clone(),
        headers.clone(),
        HttpBody::Json(body.clone()),
    )?;
    let text = String::from_utf8(response.body)
        .map_err(|error| GenerationError::new("model_response_invalid", error.to_string()))?;
    let frames = split_json_objects(&text)?;
    let mut bytes = Vec::new();
    for frame in frames {
        if frame
            .get("code")
            .and_then(Value::as_i64)
            .is_some_and(|code| code != 20_000_000)
        {
            return Err(GenerationError::new(
                "generation_task_failed",
                "Doubao TTS response contained an error frame.",
            ));
        }
        if let Some(data) = frame.get("data").and_then(Value::as_str) {
            bytes.extend(decode_base64(data, "Doubao TTS frame")?);
        }
    }
    if bytes.is_empty() {
        return Err(GenerationError::new(
            "model_response_invalid",
            "Doubao TTS response omitted audio frames.",
        ));
    }
    let (bytes, mime) = if format == "pcm" {
        (
            wrap_pcm_as_wav(&bytes, u32::try_from(sample_rate).unwrap_or(24_000), 1, 16)?,
            "audio/wav",
        )
    } else {
        (bytes, mime_for_audio_format(&format)?)
    };
    single_audio_result_with_headers(bytes, mime, audio_role(context)?, &headers, &url, &body)
}

#[allow(
    clippy::too_many_lines,
    reason = "one exact fal submit-poll-result adapter is clearer as a single no-retry flow"
)]
fn execute_fal(context: &mut ExecutionContext<'_>) -> Result<AudioResult, GenerationError> {
    let stable_25 = context.model.model_id == "fal-stable-audio-text-to-audio";
    let mut body = Map::from_iter([(
        "prompt".to_owned(),
        required_argument(context.arguments, "prompt")?.clone(),
    )]);
    if let Some(duration) = context.arguments.get("duration_seconds") {
        body.insert(
            if stable_25 {
                "seconds_total"
            } else {
                "duration"
            }
            .to_owned(),
            duration.clone(),
        );
    }
    for key in ["seed", "negative_prompt"] {
        copy_if_present(context.arguments, &mut body, key);
    }
    if !stable_25 {
        copy_if_present(context.arguments, &mut body, "format");
        if let Some(format) = body.remove("format") {
            body.insert("output_format".to_owned(), format);
        }
    }
    let url = join_url(&context.model.base_url, &context.model.request_model_id)?;
    let headers = BTreeMap::from([
        (
            "authorization".to_owned(),
            format!("Key {}", context.model.api_key),
        ),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]);
    let submit = context.json(
        HttpMethod::Post,
        url.clone(),
        headers.clone(),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let task_id = required_string(&submit, "/request_id")?;
    let status_url = required_string(&submit, "/status_url")?;
    assert_same_origin(&context.model.base_url, &status_url)?;
    let result = loop {
        let status = context.json(
            HttpMethod::Get,
            status_url.clone(),
            headers.clone(),
            HttpBody::Empty,
        )?;
        match status.get("status").and_then(Value::as_str) {
            Some("COMPLETED") => {
                if let Some(error) = status.get("error").and_then(Value::as_str) {
                    return Err(GenerationError::new(
                        "generation_task_failed",
                        format!("fal audio task failed: {error}"),
                    ));
                }
                let result_url = required_string(&status, "/response_url")?;
                assert_same_origin(&context.model.base_url, &result_url)?;
                break context.json(
                    HttpMethod::Get,
                    result_url,
                    headers.clone(),
                    HttpBody::Empty,
                )?;
            }
            Some("IN_QUEUE" | "IN_PROGRESS") => context.sleep(POLL_INTERVAL)?,
            Some(status) => {
                return Err(GenerationError::new(
                    "model_response_invalid",
                    format!("fal audio task returned unknown status: {status}"),
                ));
            }
            None => {
                return Err(GenerationError::new(
                    "model_response_invalid",
                    "fal audio status omitted status.",
                ));
            }
        }
    };
    let (artifact_url, declared_mime) = if stable_25 {
        (required_string(&result, "/audio")?, "audio/wav".to_owned())
    } else {
        (
            required_string(&result, "/audio/url")?,
            required_string(&result, "/audio/content_type")?,
        )
    };
    let artifact = context.download(&artifact_url)?;
    let mime = mime_from_response(&artifact).unwrap_or(declared_mime);
    let safe_request = json!({
        "method": "POST",
        "url": url,
        "headers": headers,
        "body": body,
        "taskId": task_id,
    });
    Ok(AudioResult {
        payloads: vec![audio_payload(artifact.body, &mime, context)?],
        safe_request,
    })
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
    Ok(GeneratedPayload {
        bytes,
        mime_type: mime.to_owned(),
        role,
        suggested_extension: extension_for_mime(mime)?,
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
    Ok(AudioResult {
        payloads: vec![GeneratedPayload {
            bytes,
            mime_type: mime.to_owned(),
            role,
            suggested_extension: extension_for_mime(mime)?,
            model_output: Value::Null,
        }],
        safe_request: json!({"method": "POST", "url": url, "headers": headers, "body": body}),
    })
}

fn audio_role(context: &ExecutionContext<'_>) -> Result<GeneratedArtifactRole, GenerationError> {
    match context.model.kind {
        super::types::GenerationKind::Tts => Ok(GeneratedArtifactRole::TtsAudio),
        super::types::GenerationKind::Music => Ok(GeneratedArtifactRole::MusicAudio),
        super::types::GenerationKind::SoundEffect => Ok(GeneratedArtifactRole::SoundEffectAudio),
        _ => Err(GenerationError::new(
            "model_catalog_invalid",
            "Audio adapter received a non-audio generation kind.",
        )),
    }
}

fn required_argument<'a>(
    arguments: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a Value, GenerationError> {
    arguments.get(key).ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            format!("Audio generation requires argument: {key}."),
        )
    })
}

fn string_arg(arguments: &Map<String, Value>, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn copy_if_present(from: &Map<String, Value>, to: &mut Map<String, Value>, key: &str) {
    if let Some(value) = from.get(key) {
        to.insert(key.to_owned(), value.clone());
    }
}

fn elevenlabs_output_format(format: &str) -> Result<&'static str, GenerationError> {
    match format {
        "mp3" => Ok("mp3_44100_128"),
        "wav" => Ok("wav_44100_16"),
        _ => Err(GenerationError::new(
            "generation_argument_invalid",
            format!("ElevenLabs audio format is unsupported: {format}"),
        )),
    }
}

fn mime_for_audio_format(format: &str) -> Result<&'static str, GenerationError> {
    match format {
        "mp3" => Ok("audio/mpeg"),
        "wav" => Ok("audio/wav"),
        "flac" => Ok("audio/flac"),
        "aac" => Ok("audio/aac"),
        "opus" | "ogg" => Ok("audio/ogg"),
        "pcm" => Ok("audio/pcm"),
        _ => Err(GenerationError::new(
            "generation_argument_invalid",
            format!("Audio format is unsupported: {format}"),
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

fn split_json_objects(text: &str) -> Result<Vec<Value>, GenerationError> {
    let mut values = Vec::new();
    let mut start = None;
    let mut depth = 0_usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, byte) in text.bytes().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => {
                if depth == 0 {
                    start = Some(index);
                }
                depth += 1;
            }
            b'}' if depth > 0 => {
                depth -= 1;
                if depth == 0
                    && let Some(start) = start.take()
                {
                    values.push(serde_json::from_str(&text[start..=index]).map_err(|error| {
                        GenerationError::new("model_response_invalid", error.to_string())
                    })?);
                }
            }
            _ => {}
        }
    }
    if depth != 0 || values.is_empty() {
        return Err(GenerationError::new(
            "model_response_invalid",
            "Doubao TTS response did not contain complete JSON frames.",
        ));
    }
    Ok(values)
}

fn pcm_parameters(mime: &str, defaults: bool) -> Result<(u32, u16, u16), GenerationError> {
    let mut rate = None;
    let mut channels = None;
    let mut bits = if mime.starts_with("audio/l16") {
        Some(16)
    } else {
        None
    };
    for parameter in mime.split(';').skip(1) {
        let Some((key, value)) = parameter.trim().split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "rate" => rate = value.trim().parse().ok(),
            "channels" => channels = value.trim().parse().ok(),
            "bits" => bits = value.trim().parse().ok(),
            _ => {}
        }
    }
    if defaults {
        rate = rate.or(Some(24_000));
        channels = channels.or(Some(1));
        bits = bits.or(Some(16));
    }
    match (rate, channels, bits) {
        (Some(rate), Some(channels), Some(bits)) => Ok((rate, channels, bits)),
        _ => Err(GenerationError::new(
            "generated_artifact_type_unsupported",
            "PCM audio omitted rate, channels, or bits parameters.",
        )),
    }
}

fn wrap_pcm_as_wav(
    bytes: &[u8],
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
) -> Result<Vec<u8>, GenerationError> {
    let data_length = u32::try_from(bytes.len()).map_err(|_| {
        GenerationError::new(
            "model_response_too_large",
            "PCM audio is too large for WAV.",
        )
    })?;
    let byte_rate = sample_rate
        .checked_mul(u32::from(channels))
        .and_then(|value| value.checked_mul(u32::from(bits_per_sample)))
        .and_then(|value| value.checked_div(8))
        .ok_or_else(|| {
            GenerationError::new("model_response_invalid", "PCM parameters overflow WAV.")
        })?;
    let block_align = channels
        .checked_mul(bits_per_sample)
        .and_then(|value| value.checked_div(8))
        .ok_or_else(|| {
            GenerationError::new("model_response_invalid", "PCM parameters overflow WAV.")
        })?;
    let mut output = Vec::with_capacity(bytes.len().saturating_add(44));
    output.extend_from_slice(b"RIFF");
    output.extend_from_slice(&data_length.saturating_add(36).to_le_bytes());
    output.extend_from_slice(b"WAVEfmt ");
    output.extend_from_slice(&16_u32.to_le_bytes());
    output.extend_from_slice(&1_u16.to_le_bytes());
    output.extend_from_slice(&channels.to_le_bytes());
    output.extend_from_slice(&sample_rate.to_le_bytes());
    output.extend_from_slice(&byte_rate.to_le_bytes());
    output.extend_from_slice(&block_align.to_le_bytes());
    output.extend_from_slice(&bits_per_sample.to_le_bytes());
    output.extend_from_slice(b"data");
    output.extend_from_slice(&data_length.to_le_bytes());
    output.extend_from_slice(bytes);
    Ok(output)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_is_wrapped_as_wav() {
        let wav = wrap_pcm_as_wav(&[0, 1, 2, 3], 24_000, 1, 16).unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[44..], &[0, 1, 2, 3]);
    }

    #[test]
    fn concatenated_doubao_frames_are_parsed() {
        let values = split_json_objects("event:{\"code\":20000000}{\"data\":\"AA==\"}").unwrap();
        assert_eq!(values.len(), 2);
    }
}
