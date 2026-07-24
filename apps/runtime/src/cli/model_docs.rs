#![allow(clippy::too_many_lines)]

use super::service::CliFailure;
use crate::global::ModelRequestExample;

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
    request_example: &ModelRequestExample,
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
    let example = serde_json::to_string(&request_example.input)
        .map_err(|error| CliFailure::new("runtime_config_error", error.to_string()))?;
    let model_kind = match command {
        "models.image.describe" => "image",
        "models.video.describe" => "video",
        "models.tts.describe" => "tts",
        "models.music.describe" => "music",
        "models.sfx.describe" => "sound-effect",
        other => {
            return Err(CliFailure::new(
                "internal_error",
                format!("Model documentation command is unsupported: {other}"),
            ));
        }
    };
    let timeout_note = if model_kind == "image" {
        "The default active image Model Run timeout is 10 minutes."
    } else if model_kind == "video" {
        "The default active video Model Run timeout is 30 minutes."
    } else {
        "The default active audio Model Run timeout is 10 minutes."
    };
    Ok(ModelDocumentation {
        source_urls: source.urls,
        snapshot_path: source.path,
        captured_at: source.captured_at,
        description_markdown: format!(
            "# {model_id}\n\nOfficial documentation:\n{urls}\n\nRepository snapshot:\n- {}\n\n{body}\n\n## Debrute command\n\n{timeout_note} Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single <project> --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed.\n\n```json\n{example}\n```",
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
        "doubao-seedream-5-0-lite-260128" => Some(model_doc(
            "model-docs/snapshots/image/volcengine-ark/seedream-5-lite.md",
            &[
                "https://www.volcengine.com/docs/82379/1541523",
                "https://www.volcengine.com/docs/82379/1824692",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/image/volcengine-ark/seedream-5-lite.md"
            ),
        )),
        "doubao-seedream-5-0-pro-260628" => Some(model_doc_at(
            "model-docs/snapshots/image/volcengine-ark/seedream-5-pro.md",
            &[
                "https://www.volcengine.com/docs/82379/2582774",
                "https://www.volcengine.com/docs/82379/1541523",
            ],
            "2026-07-23",
            include_str!(
                "../../../../assets/model-docs/snapshots/image/volcengine-ark/seedream-5-pro.md"
            ),
        )),
        "fal-ai/flux/dev" => Some(model_doc(
            "model-docs/snapshots/image/fal/flux-dev.md",
            &["https://fal.ai/models/fal-ai/flux/dev/api"],
            include_str!("../../../../assets/model-docs/snapshots/image/fal/flux-dev.md"),
        )),
        "fal-ai/flux/dev/image-to-image" => Some(model_doc(
            "model-docs/snapshots/image/fal/flux-dev-image-to-image.md",
            &["https://fal.ai/models/fal-ai/flux/dev/image-to-image/api"],
            include_str!(
                "../../../../assets/model-docs/snapshots/image/fal/flux-dev-image-to-image.md"
            ),
        )),
        "gemini-3.1-flash-image" => Some(model_doc(
            "model-docs/snapshots/image/google-gemini/gemini-3.1-flash-image.md",
            &[
                "https://ai.google.dev/gemini-api/docs/image-generation",
                "https://deepmind.google/models/model-cards/gemini-3-1-flash-image/",
                "https://ai.google.dev/api/interactions-api",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/image/google-gemini/gemini-3.1-flash-image.md"
            ),
        )),
        "gemini-3-pro-image" => Some(model_doc(
            "model-docs/snapshots/image/google-gemini/gemini-3-pro-image.md",
            &[
                "https://ai.google.dev/gemini-api/docs/image-generation",
                "https://ai.google.dev/api/interactions-api",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/image/google-gemini/gemini-3-pro-image.md"
            ),
        )),
        "gpt-image-1" => Some(model_doc(
            "model-docs/snapshots/image/openai/gpt-image-1.md",
            &[
                "https://developers.openai.com/api/docs/guides/image-generation",
                "https://developers.openai.com/api/docs/models/gpt-image-1",
            ],
            include_str!("../../../../assets/model-docs/snapshots/image/openai/gpt-image-1.md"),
        )),
        "gpt-image-2" => Some(model_doc(
            "model-docs/snapshots/image/openai/gpt-image-2.md",
            &[
                "https://developers.openai.com/api/docs/guides/image-generation",
                "https://developers.openai.com/api/docs/models/gpt-image-2",
            ],
            include_str!("../../../../assets/model-docs/snapshots/image/openai/gpt-image-2.md"),
        )),
        "grok-imagine" => Some(model_doc(
            "model-docs/snapshots/image/vydra/grok-imagine.md",
            &[
                "https://www.vydra.ai/docs/models/grok-imagine",
                "https://docs.x.ai/developers/model-capabilities/images/generation",
            ],
            include_str!("../../../../assets/model-docs/snapshots/image/vydra/grok-imagine.md"),
        )),
        "image-01" => Some(model_doc(
            "model-docs/snapshots/image/minimax/image-01.md",
            &[
                "https://platform.minimax.io/docs/api-reference/image-generation-t2i",
                "https://platform.minimax.io/docs/api-reference/image-generation-i2i",
                "https://platform.minimax.io/docs/guides/image-generation",
            ],
            include_str!("../../../../assets/model-docs/snapshots/image/minimax/image-01.md"),
        )),
        "qwen-image-2.0-pro-2026-06-22" => Some(model_doc_at(
            "model-docs/snapshots/image/dashscope/qwen-image-2.0-pro-2026-06-22.md",
            &[
                "https://help.aliyun.com/en/model-studio/qwen-image-api",
                "https://help.aliyun.com/en/model-studio/qwen-image-edit-guide",
                "https://help.aliyun.com/zh/model-studio/image-model/",
            ],
            "2026-07-23",
            include_str!(
                "../../../../assets/model-docs/snapshots/image/dashscope/qwen-image-2.0-pro-2026-06-22.md"
            ),
        )),
        "qwen-image-2.0-2026-03-03" => Some(model_doc_at(
            "model-docs/snapshots/image/dashscope/qwen-image-2.0-2026-03-03.md",
            &[
                "https://help.aliyun.com/en/model-studio/qwen-image-api",
                "https://help.aliyun.com/en/model-studio/qwen-image-edit-guide",
                "https://help.aliyun.com/zh/model-studio/image-model/",
            ],
            "2026-07-23",
            include_str!(
                "../../../../assets/model-docs/snapshots/image/dashscope/qwen-image-2.0-2026-03-03.md"
            ),
        )),
        "wan2.7-image" => Some(model_doc(
            "model-docs/snapshots/image/dashscope/wan2.7-image.md",
            &[
                "https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference",
            ],
            include_str!("../../../../assets/model-docs/snapshots/image/dashscope/wan2.7-image.md"),
        )),
        "doubao-seedance-2-0-260128" => Some(model_doc(
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
        "doubao-seedance-2-0-fast-260128" => Some(model_doc(
            "model-docs/snapshots/video/volcengine-ark/seedance-2-fast.md",
            &[
                "https://www.volcengine.com/docs/82379/2291680",
                "https://www.volcengine.com/docs/82379/1520757",
                "https://www.volcengine.com/docs/82379/1521309",
                "https://www.volcengine.com/docs/82379/1159178",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/video/volcengine-ark/seedance-2-fast.md"
            ),
        )),
        "doubao-seedance-2-0-mini-260615" => Some(model_doc_at(
            "model-docs/snapshots/video/volcengine-ark/seedance-2-mini.md",
            &[
                "https://www.volcengine.com/docs/82379/2291680",
                "https://www.volcengine.com/docs/82379/2298881",
                "https://www.volcengine.com/docs/82379/1520757",
                "https://www.volcengine.com/docs/82379/1521309",
                "https://www.volcengine.com/docs/82379/1159178",
            ],
            "2026-07-23",
            include_str!(
                "../../../../assets/model-docs/snapshots/video/volcengine-ark/seedance-2-mini.md"
            ),
        )),
        "openai-gpt-4o-mini-tts" => Some(model_doc(
            "model-docs/snapshots/audio/openai/gpt-4o-mini-tts.md",
            &[
                "https://developers.openai.com/api/docs/guides/text-to-speech",
                "https://developers.openai.com/api/docs/models/gpt-4o-mini-tts",
            ],
            include_str!("../../../../assets/model-docs/snapshots/audio/openai/gpt-4o-mini-tts.md"),
        )),
        "openai-tts-1" => Some(model_doc(
            "model-docs/snapshots/audio/openai/tts-1.md",
            &["https://developers.openai.com/api/docs/guides/text-to-speech"],
            include_str!("../../../../assets/model-docs/snapshots/audio/openai/tts-1.md"),
        )),
        "openai-tts-1-hd" => Some(model_doc(
            "model-docs/snapshots/audio/openai/tts-1-hd.md",
            &["https://developers.openai.com/api/docs/guides/text-to-speech"],
            include_str!("../../../../assets/model-docs/snapshots/audio/openai/tts-1-hd.md"),
        )),
        "elevenlabs-v3-tts" => Some(model_doc(
            "model-docs/snapshots/audio/elevenlabs/eleven-v3.md",
            &[
                "https://elevenlabs.io/docs/overview/models",
                "https://elevenlabs.io/docs/api-reference/text-to-speech/convert",
                "https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices",
            ],
            include_str!("../../../../assets/model-docs/snapshots/audio/elevenlabs/eleven-v3.md"),
        )),
        "elevenlabs-multilingual-v2" => Some(model_doc(
            "model-docs/snapshots/audio/elevenlabs/multilingual-v2.md",
            &[
                "https://elevenlabs.io/docs/overview/models",
                "https://elevenlabs.io/docs/api-reference/text-to-speech/convert",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/audio/elevenlabs/multilingual-v2.md"
            ),
        )),
        "elevenlabs-music" => Some(model_doc(
            "model-docs/snapshots/audio/elevenlabs/music-v2.md",
            &[
                "https://elevenlabs.io/docs/api-reference/music/compose",
                "https://elevenlabs.io/docs/eleven-api/guides/how-to/music/composition-plans",
            ],
            include_str!("../../../../assets/model-docs/snapshots/audio/elevenlabs/music-v2.md"),
        )),
        "elevenlabs-sound-effects" => Some(model_doc(
            "model-docs/snapshots/audio/elevenlabs/sound-effects-v2.md",
            &["https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert"],
            include_str!(
                "../../../../assets/model-docs/snapshots/audio/elevenlabs/sound-effects-v2.md"
            ),
        )),
        "gemini-3-1-flash-tts-preview" => Some(model_doc(
            "model-docs/snapshots/audio/google-gemini/gemini-3.1-flash-tts-preview.md",
            &[
                "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-tts-preview",
                "https://ai.google.dev/gemini-api/docs/speech-generation",
                "https://ai.google.dev/api/interactions-api",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/audio/google-gemini/gemini-3.1-flash-tts-preview.md"
            ),
        )),
        "google-lyria-3-clip-preview" => Some(model_doc(
            "model-docs/snapshots/audio/google-gemini/lyria-3-clip-preview.md",
            &[
                "https://ai.google.dev/gemini-api/docs/music-generation",
                "https://ai.google.dev/api/interactions-api",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/audio/google-gemini/lyria-3-clip-preview.md"
            ),
        )),
        "google-lyria-3-pro-preview" => Some(model_doc(
            "model-docs/snapshots/audio/google-gemini/lyria-3-pro-preview.md",
            &[
                "https://ai.google.dev/gemini-api/docs/music-generation",
                "https://ai.google.dev/api/interactions-api",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/audio/google-gemini/lyria-3-pro-preview.md"
            ),
        )),
        "minimax-speech-2-8-hd" => Some(model_doc(
            "model-docs/snapshots/audio/minimax/speech-2.8-hd.md",
            &[
                "https://platform.minimax.io/docs/api-reference/speech-t2a-http",
                "https://platform.minimax.io/docs/guides/models-intro",
            ],
            include_str!("../../../../assets/model-docs/snapshots/audio/minimax/speech-2.8-hd.md"),
        )),
        "minimax-music-3-0" => Some(model_doc(
            "model-docs/snapshots/audio/minimax/music-3.0.md",
            &["https://platform.minimax.io/docs/api-reference/music-generation"],
            include_str!("../../../../assets/model-docs/snapshots/audio/minimax/music-3.0.md"),
        )),
        "dashscope-qwen3-tts-flash" => Some(model_doc(
            "model-docs/snapshots/audio/dashscope/qwen3-tts-flash.md",
            &[
                "https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api",
                "https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/audio/dashscope/qwen3-tts-flash.md"
            ),
        )),
        "doubao-seed-tts-2-0" => Some(model_doc(
            "model-docs/snapshots/audio/volcengine/seed-tts-2.0.md",
            &[
                "https://www.volcengine.com/docs/82379/2516286",
                "https://www.volcengine.com/docs/6561/1598757",
                "https://www.volcengine.com/docs/6561/1257544",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/audio/volcengine/seed-tts-2.0.md"
            ),
        )),
        "fal-stable-audio-text-to-audio" => Some(model_doc(
            "model-docs/snapshots/audio/fal/stable-audio-2.5.md",
            &[
                "https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio/api",
                "https://fal.ai/docs/documentation/model-apis/inference/queue",
            ],
            include_str!("../../../../assets/model-docs/snapshots/audio/fal/stable-audio-2.5.md"),
        )),
        "fal-stable-audio-3-small-sfx" => Some(model_doc(
            "model-docs/snapshots/audio/fal/stable-audio-3-small-sfx.md",
            &[
                "https://fal.ai/models/fal-ai/stable-audio-3/small/sfx/text-to-audio/api",
                "https://fal.ai/docs/documentation/model-apis/inference/queue",
            ],
            include_str!(
                "../../../../assets/model-docs/snapshots/audio/fal/stable-audio-3-small-sfx.md"
            ),
        )),
        _ => None,
    }
}

fn model_doc(
    path: &'static str,
    urls: &'static [&'static str],
    snapshot: &'static str,
) -> DocSource {
    model_doc_at(path, urls, "2026-07-21", snapshot)
}

fn model_doc_at(
    path: &'static str,
    urls: &'static [&'static str],
    captured_at: &'static str,
    snapshot: &'static str,
) -> DocSource {
    DocSource {
        urls,
        path,
        captured_at,
        snapshot,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::global::ModelCatalog;

    #[test]
    fn every_catalog_model_has_one_model_specific_manual() {
        let catalog = ModelCatalog::bundled().unwrap();
        let mut paths = std::collections::HashSet::new();
        for model_id in catalog
            .images()
            .iter()
            .map(|entry| entry.debrute_model_id.as_str())
            .chain(
                catalog
                    .videos()
                    .iter()
                    .map(|entry| entry.debrute_model_id.as_str()),
            )
            .chain(
                catalog
                    .audio()
                    .iter()
                    .map(|entry| entry.debrute_model_id.as_str()),
            )
        {
            let source = source_for(model_id)
                .unwrap_or_else(|| panic!("Catalog model {model_id} has no manual"));
            assert!(
                source.snapshot.contains(model_id),
                "Catalog model {model_id} manual does not identify that model"
            );
            assert!(
                paths.insert(source.path),
                "Catalog model {model_id} shares manual {} with another model",
                source.path
            );
        }
    }
}
