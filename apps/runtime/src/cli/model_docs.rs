#![allow(clippy::too_many_lines)]

use serde_json::Value;

use super::service::CliFailure;

pub(super) struct ModelDocumentation {
    pub(super) source_urls: &'static [&'static str],
    pub(super) snapshot_path: &'static str,
    pub(super) captured_at: &'static str,
    pub(super) description_markdown: String,
}

struct DocSource {
    urls: &'static [&'static str],
    path: &'static str,
    captured_at: &'static str,
    snapshot: &'static str,
}

pub(super) fn describe_model(
    model_id: &str,
    command: &str,
    request_example: &Value,
) -> Result<ModelDocumentation, CliFailure> {
    let source = source_for(model_id).ok_or_else(|| {
        CliFailure::new(
            "runtime_config_error",
            format!("Official model documentation is missing: {model_id}"),
        )
        .with_field("model", model_id.to_owned())
    })?;
    let body = strip_frontmatter(source.snapshot).trim();
    let urls = source
        .urls
        .iter()
        .map(|url| format!("- {url}"))
        .collect::<Vec<_>>()
        .join("\n");
    let input = request_example
        .get("input")
        .cloned()
        .unwrap_or_else(|| request_example.clone());
    let example = serde_json::to_string(&input)
        .map_err(|error| CliFailure::new("runtime_config_error", error.to_string()))?;
    let command = match command {
        "models.image.describe" => "generate image",
        "models.video.describe" => "generate video",
        "models.tts.describe" => "generate tts",
        "models.music.describe" => "generate music",
        "models.sfx.describe" => "generate sfx",
        other => {
            return Err(CliFailure::new(
                "internal_error",
                format!("Model documentation command is unsupported: {other}"),
            ));
        }
    };
    let timeout_note = if command == "generate image" {
        "Single image generation timeout covers the complete request and artifact write."
    } else if command == "generate video" {
        "Video generation timeout covers task submission, polling, response reads, download, and artifact write."
    } else {
        "Audio generation timeout covers task submission, polling when applicable, response reads, download, and artifact write."
    };
    Ok(ModelDocumentation {
        source_urls: source.urls,
        snapshot_path: source.path,
        captured_at: source.captured_at,
        description_markdown: format!(
            "# {model_id}\n\nOfficial documentation:\n{urls}\n\nRepository snapshot:\n- {}\n\n{body}\n\n## Debrute command\n\n{timeout_note} Use `--timeout-ms <ms>` to override it for this command.\n\n```sh\ndebrute {command} <project> --input-json '{example}' --timeout-ms 600000\n```",
            source.path,
        ),
    })
}

fn strip_frontmatter(markdown: &str) -> &str {
    let Some(after_start) = markdown.strip_prefix("---\n") else {
        return markdown;
    };
    after_start
        .find("\n---\n")
        .map_or(markdown, |end| &after_start[end + 5..])
}

fn source_for(model_id: &str) -> Option<DocSource> {
    match model_id {
        "doubao-seedream-5-0-lite-260128" => Some(image_doc(
            "model-docs/snapshots/image/volcengine-ark/seedream-5-lite.md",
            &[
                "https://www.volcengine.com/docs/82379/1541523",
                "https://www.volcengine.com/docs/82379/1824692",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/image/volcengine-ark/seedream-5-lite.md"
            ),
        )),
        "fal-ai/flux/dev" => Some(image_doc(
            "model-docs/snapshots/image/fal/flux-dev.md",
            &["https://fal.ai/models/fal-ai/flux/dev/api"],
            include_str!("../../../../assets/model-docs/snapshots/image/fal/flux-dev.md"),
        )),
        "fal-ai/flux/dev/image-to-image" => Some(image_doc(
            "model-docs/snapshots/image/fal/flux-dev-image-to-image.md",
            &["https://fal.ai/models/fal-ai/flux/dev/image-to-image/api"],
            include_str!(
                "../../../../assets/model-docs/snapshots/image/fal/flux-dev-image-to-image.md"
            ),
        )),
        "gemini-3-pro-image-preview"
        | "gemini-3.1-flash-image"
        | "gemini-3.1-flash-image-preview" => Some(image_doc(
            "model-docs/snapshots/image/google-gemini/image-generation.md",
            &[
                "https://ai.google.dev/gemini-api/docs/image-generation",
                "https://deepmind.google/models/model-cards/gemini-3-1-flash-image/",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/image/google-gemini/image-generation.md"
            ),
        )),
        "gpt-image-1" | "gpt-image-2" => Some(image_doc(
            "model-docs/snapshots/image/openai/image-generation.md",
            &[
                "https://developers.openai.com/api/docs/guides/image-generation",
                "https://developers.openai.com/api/docs/models/gpt-image-2",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/image/openai/image-generation.md"
            ),
        )),
        "grok-imagine" => Some(image_doc(
            "model-docs/snapshots/image/vydra/grok-imagine.md",
            &[
                "https://www.vydra.ai/docs/models/grok-imagine",
                "https://docs.x.ai/developers/model-capabilities/images/generation",
            ],
            include_str!("../../../../assets/model-docs/snapshots/image/vydra/grok-imagine.md"),
        )),
        "image-01" => Some(image_doc(
            "model-docs/snapshots/image/minimax/image-01.md",
            &[
                "https://platform.minimax.io/docs/api-reference/image-generation-t2i",
                "https://platform.minimax.io/docs/api-reference/image-generation-i2i",
                "https://platform.minimax.io/docs/guides/image-generation",
            ],
            include_str!("../../../../assets/model-docs/snapshots/image/minimax/image-01.md"),
        )),
        "wan2.7-image" => Some(image_doc(
            "model-docs/snapshots/image/dashscope/wan2.7-image.md",
            &[
                "https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference",
            ],
            include_str!("../../../../assets/model-docs/snapshots/image/dashscope/wan2.7-image.md"),
        )),
        "doubao-seedance-2-0-260128" | "doubao-seedance-2-0-fast-260128" => Some(video_doc(
            "model-docs/snapshots/video/volcengine-ark/seedance-2.md",
            &[
                "https://www.volcengine.com/docs/82379/2291680",
                "https://www.volcengine.com/docs/82379/1520757",
                "https://www.volcengine.com/docs/82379/1521309",
                "https://www.volcengine.com/docs/82379/1159178",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/video/volcengine-ark/seedance-2.md"
            ),
        )),
        "openai-gpt-4o-mini-tts" | "openai-tts-1" | "openai-tts-1-hd" => Some(audio_doc(
            "model-docs/snapshots/audio/openai/tts.md",
            &[
                "https://developers.openai.com/api/docs/guides/text-to-speech",
                "https://developers.openai.com/api/docs/models/gpt-4o-mini-tts",
            ],
            include_str!("../../../../assets/model-docs/snapshots/audio/openai/tts.md"),
        )),
        "elevenlabs-v3-tts" | "elevenlabs-multilingual-v2" => Some(audio_doc(
            "model-docs/snapshots/audio/elevenlabs/tts.md",
            &["https://elevenlabs.io/docs/api-reference/text-to-speech/convert"],
            include_str!("../../../../assets/model-docs/snapshots/audio/elevenlabs/tts.md"),
        )),
        "elevenlabs-music" => Some(audio_doc(
            "model-docs/snapshots/audio/elevenlabs/music.md",
            &["https://elevenlabs.io/docs/api-reference/music/compose"],
            include_str!("../../../../assets/model-docs/snapshots/audio/elevenlabs/music.md"),
        )),
        "elevenlabs-sound-effects" => Some(audio_doc(
            "model-docs/snapshots/audio/elevenlabs/sound-effects.md",
            &["https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert"],
            include_str!(
                "../../../../assets/model-docs/snapshots/audio/elevenlabs/sound-effects.md"
            ),
        )),
        "gemini-tts" => Some(audio_doc(
            "model-docs/snapshots/audio/google-gemini/tts.md",
            &[
                "https://ai.google.dev/gemini-api/docs/speech-generation",
                "https://ai.google.dev/api/interactions-api",
            ],
            include_str!("../../../../assets/model-docs/snapshots/audio/google-gemini/tts.md"),
        )),
        "google-lyria-3-clip-preview" | "google-lyria-3-pro-preview" => Some(audio_doc(
            "model-docs/snapshots/audio/google-gemini/lyria.md",
            &[
                "https://ai.google.dev/gemini-api/docs/music-generation",
                "https://ai.google.dev/api/interactions-api",
            ],
            include_str!("../../../../assets/model-docs/snapshots/audio/google-gemini/lyria.md"),
        )),
        "minimax-speech-2-8-hd" => Some(audio_doc(
            "model-docs/snapshots/audio/minimax/t2a-http.md",
            &["https://platform.minimax.io/docs/api-reference/speech-t2a-http"],
            include_str!("../../../../assets/model-docs/snapshots/audio/minimax/t2a-http.md"),
        )),
        "minimax-music-2-6" => Some(audio_doc(
            "model-docs/snapshots/audio/minimax/music-generation.md",
            &["https://platform.minimax.io/docs/api-reference/music-generation"],
            include_str!(
                "../../../../assets/model-docs/snapshots/audio/minimax/music-generation.md"
            ),
        )),
        "dashscope-qwen3-tts-flash" => Some(audio_doc(
            "model-docs/snapshots/audio/dashscope/qwen-tts.md",
            &[
                "https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api",
                "https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide",
            ],
            include_str!("../../../../assets/model-docs/snapshots/audio/dashscope/qwen-tts.md"),
        )),
        "doubao-seed-tts-2-0" => Some(audio_doc(
            "model-docs/snapshots/audio/volcengine/seed-tts.md",
            &[
                "https://www.volcengine.com/docs/82379/2516286",
                "https://www.volcengine.com/docs/6561/1329505",
            ],
            include_str!("../../../../assets/model-docs/snapshots/audio/volcengine/seed-tts.md"),
        )),
        "fal-stable-audio-text-to-audio" | "fal-stable-audio-sfx" => Some(audio_doc(
            "model-docs/snapshots/audio/fal/stable-audio.md",
            &[
                "https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio",
                "https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio/api",
                "https://fal.ai/models/fal-ai/stable-audio-3/medium/base/text-to-audio/api",
                "https://fal.ai/docs/documentation/model-apis/inference/queue",
            ],
            include_str!("../../../../assets/model-docs/snapshots/audio/fal/stable-audio.md"),
        )),
        _ => None,
    }
}

fn image_doc(
    path: &'static str,
    urls: &'static [&'static str],
    snapshot: &'static str,
) -> DocSource {
    DocSource {
        urls,
        path,
        captured_at: "2026-05-31",
        snapshot,
    }
}

fn video_doc(
    path: &'static str,
    urls: &'static [&'static str],
    snapshot: &'static str,
) -> DocSource {
    DocSource {
        urls,
        path,
        captured_at: "2026-06-09",
        snapshot,
    }
}

fn audio_doc(
    path: &'static str,
    urls: &'static [&'static str],
    snapshot: &'static str,
) -> DocSource {
    DocSource {
        urls,
        path,
        captured_at: "2026-07-06",
        snapshot,
    }
}
