# CLI

The CLI is Agent-facing and writes structured Agent Records on stdout. There is no JSON output mode; JSON is used only as an input encoding for request payloads.

Model catalog, configuration, execution, redaction, and Generated Asset
contracts are documented in [`model-generation.md`](./model-generation.md) and
[`generated-assets.md`](./generated-assets.md).

## Command And Output Contract

`apps/runtime/src/cli/spec.rs` is the executable inventory of
public commands. `debrute commands`, `debrute help <command-path>`, `--help`, and
parser validation all use that inventory; Skills and prose are consumers rather
than an alternate command registry.

Every result begins with one stable Agent Record:

```text
debrute/1 ok cmd=<command>
debrute/1 error cmd=<command> code=<error-code>
debrute/1 progress cmd=<command> ...
```

Named records and fields follow on separate lines. Values containing whitespace,
quotes, backslashes, control characters, or `=` are quoted and escaped. Standard
output is the command contract; commands do not emit ANSI tables or a second JSON
output shape. Parse and input failures, runtime/configuration failures,
model/network failures, and unexpected failures map to stable nonzero exit-code
classes.

Commands have one of five runtime policies:

- `commands` and `help` run without a Workbench runtime;
- `runtime status` and `runtime doctor` inspect an existing runtime without
  starting one, including whether its native tray is active or unavailable;
- `workbench start` ensures Runtime and sends only a native Control activation;
- non-streaming operational commands ensure Runtime, create a connection-bound
  CLI authorization, and call `/api/cli/run`;
- `generate image-batch` uses the same connection-bound authorization with the
  NDJSON `/api/cli/run-stream` route.

Both Runtime observation commands report `runtime_state` and `native_tray`.
`native_tray=active` is emitted only from a Ready Runtime, whose startup gate
has already created the required macOS menu-bar or Windows notification-area
item; stopped and transitional states report it as unavailable.

Project commands resolve the supplied Project root to an absolute path before
crossing that bridge. They use Rust Runtime semantic operations; the CLI does not
duplicate generic filesystem access or Project persistence.

## Official Skills

The repository owns four standard external-Agent Skills under `skills/`:

- `debrute-core`
- `debrute-image-director`
- `debrute-video-director`
- `debrute-audio-director`

Each package has a matching directory and frontmatter name plus
`debrute.managed: "true"`, `debrute.package: "debrute"`, and the product version.
Skills teach an external Agent to call `debrute`; they are not callable Debrute
APIs and are not generated from model or Project state.

The Desktop product bundle contains the official Skills payload. Before the
packaged Runtime starts, it validates that payload and materializes it into
`~/.agents/skills` together with the matching Product version. Existing
directories carrying Debrute's managed metadata are replaced through temporary
sibling directories; unrelated Skills are ignored. Source development uses the
same materializer against the repository payload.

`debrute skills status` is read-only. It reports the runtime-owned managed CLI
and Skills version/path diagnostic established during materialization. There is
no public `skills sync`, `skills install`, `skills update`, Skill-content browser,
standalone CLI installer, PATH repair, or Desktop CLI-management page. Repair and
refresh happen by starting the current product runtime or updating the whole
Debrute product.

## Common Commands

```sh
debrute --version
debrute runtime status
debrute runtime doctor
debrute skills status
debrute project init path/to/project
debrute project validate path/to/project
debrute workbench start
debrute canvas-map push path/to/project canvas-1
debrute canvas create path/to/project
debrute canvas rename path/to/project canvas-2 故事板
debrute canvas reorder path/to/project canvas-2 canvas-1
debrute canvas delete path/to/project canvas-2
debrute canvas repair-index path/to/project
debrute generated-asset lookup path/to/project --path generated/example.png
debrute models image list
debrute models image describe gpt-image-2
debrute generate image path/to/project --input-json '{"model":"gpt-image-2","arguments":{"prompt":"Cover image","output_path":"generated/cover.png"}}' --timeout-ms 600000
debrute generate image-batch path/to/project --manifest image-requests.json --concurrency 8 --timeout-ms 900000 --log image-results.jsonl --summary image-summary.json
debrute models video list
debrute models video describe doubao-seedance-2-0-260128
debrute generate video path/to/project --input-json '{"model":"doubao-seedance-2-0-260128","arguments":{"prompt":"Short video brief","intent":"generate"}}' --timeout-ms 600000
debrute models tts list
debrute models tts describe openai-gpt-4o-mini-tts
debrute generate tts path/to/project --input-json '{"model":"openai-gpt-4o-mini-tts","arguments":{"text":"Welcome to Debrute.","voice":"alloy","output_path":"generated/welcome.mp3"}}' --timeout-ms 600000
debrute models music list
debrute models music describe elevenlabs-music
debrute generate music path/to/project --input-json '{"model":"elevenlabs-music","arguments":{"prompt":"Warm ambient electronic music for a product demo.","output_path":"generated/demo-music.mp3"}}' --timeout-ms 600000
debrute models sfx list
debrute models sfx describe elevenlabs-sound-effects
debrute generate sfx path/to/project --input-json '{"model":"elevenlabs-sound-effects","arguments":{"prompt":"Short glass chime.","output_path":"generated/chime.wav"}}' --timeout-ms 600000
debrute commands
```

## Image Generation

Use `generate image-batch` for multiple image requests; do not loop over
`generate image` for a batch.

`--manifest` expects:

```json
{ "requests": [] }
```

Each item is shaped like a `generate image` input. Batch item outcomes are written to `--log`; stdout emits sparse progress records and the final aggregate record.

Use `models image list` to compare configured image models by original model parameters and constraints. Before image generation, run `models image describe <model-id>` once for the selected model. Model descriptions return official documentation URLs, a repository snapshot path, official-documentation-backed `description_markdown`, Debrute examples, and the machine-readable `arguments_schema`.

Single image `--timeout-ms` defaults to 600000ms. Image batch `--timeout-ms` defaults to 900000ms per item.

Use `--overwrite-existing` to regenerate batch outputs that would otherwise be skipped.

Debrute resolves project files, data URLs, and safe public `http(s)` URLs for image inputs. Model-specific file format, size, dimension, alpha, and mask constraints are left to the upstream model.

## Video Generation

Use `models video list` to compare configured video models by Debrute-native parameters and constraints. Before video generation, run `models video describe <model-id>` once for the selected model. Video model descriptions return official documentation URLs, a repository snapshot path, official-documentation-backed `description_markdown`, Debrute examples, and the machine-readable `arguments_schema`.

Video `--timeout-ms` defaults to 600000ms and covers task submission, polling, response reads, and artifact download.

Video generation uses `prompt`, `intent`, and `references`; Debrute constructs Seedance `content` internally.

Project-local image and audio references can be normalized by Debrute when the selected model supports them. Project-local video references require Debrute upload-server support unless the source is already `http(s)` or `asset://`.

Do not include model API keys in generation requests; Debrute reads configured keys locally. Use the original model parameter names shown by `models image list` and confirmed by `models image describe`.

Model request failures keep the stable CLI error code and include the Debrute model id, message, and structured logs when available.

## Audio Generation

Audio is exposed as three separate CLI surfaces:

- TTS: `models tts list`, `models tts describe <model-id>`, and `generate tts`.
- Music: `models music list`, `models music describe <model-id>`, and `generate music`.
- Sound effects: `models sfx list`, `models sfx describe <model-id>`, and `generate sfx`.

Use the matching list command to compare configured models for that use case. Before generation, run the matching describe command once for the selected model. Descriptions return official documentation URLs, a repository snapshot path, official-documentation-backed `description_markdown`, Debrute examples, and the machine-readable `arguments_schema`.

Audio `--timeout-ms` defaults to 600000ms and covers task submission, polling when the official API is task-based, response reads, artifact download, and artifact write.

Do not include model API keys in generation requests; Debrute reads configured keys locally. Use the original model parameter names shown by the matching `models ... list` command and confirmed by the matching `models ... describe` command.

## Minimal Canvas Map

```yaml
paths:
  - outputs/gpt/
  - prompts/cover.md
```

See [Product model](./product-model.md) for Canvas Map semantics.
