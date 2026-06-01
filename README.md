# AXIS

AXIS is a local-first desktop creative production workbench for projects, Canvas review, and generation capabilities. AXIS does not implement an internal Agent. External Agents use AXIS through `axis-cli` and AXIS Skills installed under the standard shared Skills directory.

## What Is Here

- `apps/desktop` - Vite/React desktop workbench renderer plus Electron IPC shell.
- `apps/app-server` - local desktop support boundary for project sessions, Flowmap publishing and sync, Canvas node projection, model settings, generated asset metadata, and explicit CLI service methods.
- `apps/axis-cli` - external Agent interface for invoking AXIS capabilities with structured output.
- `packages/project-core` - project identity, `.axis/` path conventions, atomic JSON persistence, project text/binary file access, and file event normalization.
- `packages/flowmap-core` - Flowmap YAML parsing, publishing, include expansion, file-tree node derivation, and structure edge derivation.
- `packages/canvas-core` - Canvas documents, projected node state, derived structure edges, selection, viewport, diagnostics, and node layout operations.
- `packages/capability-core` - result and artifact value shapes shared by AXIS runtime services.
- `packages/capability-runtime` - model catalogs, model executors, runtime LLM request execution, provider settings, model settings, and Skills registry code.
- `skills/axis-*` - AXIS-managed standard Skills packages for external Agents.

## Commands

```sh
npm install
npm run doctor
npm run check
npm test
npm run lint:arch
npm run build
npm run package:cli
npm run package:cli:all
npm run verify
npm run pack
npm run dist
npm run dev
npm run dev:electron
npm run preview
npm run clean
npx tsx apps/axis-cli/src/index.ts project validate path/to/project
```

`npm run doctor` checks the local Node/npm/tooling surface needed for development and macOS packaging. `npm run verify` runs doctor, type checking, tests, architecture lint, and the production build.

`npm run dev` starts the Vite renderer server used by Electron. The workbench requires the Electron preload API and is not a supported browser-preview product surface. Use `npm run dev:electron` for the desktop development loop with Vite plus Electron.

`npm run preview` serves the production renderer build for smoke testing after `npm run build`. `npm run clean` removes generated build, release, and TypeScript build-info files.

`npm run package:cli` creates the current-platform standalone CLI release asset under `release/axis-cli/`. `npm run package:cli:all` creates all supported CLI assets for GitHub Releases.

`npm run pack` creates an unpacked desktop app under `apps/desktop/release/`. `npm run dist` creates distributable macOS and Windows installer artifacts when run on the matching platform. Packaged builds and standalone CLI assets are published from the public `XiiTang/AXIS` GitHub repository.

## Product Model

Project is the local file workspace plus `.axis/` metadata, generated assets, and health diagnostics.

Flowmap YAML controls file membership and Canvas mounts. A Flowmap lives at `.axis/flowmaps/<flowmap-id>.draft.yaml`, publishes to `.axis/flowmaps/<flowmap-id>.yaml`, and uses the project directory `<flowmap-id>/` as its file-tree root.

Canvas is the visual workspace for projected Flowmap nodes. Canvas JSON under `.axis/canvases/<canvas-id>.json` stores visual state only: node layout, layers, viewport, selection, annotations, and preferences. File structure defines hierarchy and structure edges; YAML only defines `canvases` and `include`.

Capabilities are discrete operations that the desktop app or `axis-cli` can invoke: project semantics, LLM requests, image generation, video generation, and generated asset metadata lookup. External Agents use their own filesystem tools for generic file access.

Integrations are optional local capabilities that the desktop Settings surface can detect and show command previews for. The first supported integrations are FFmpeg, ImageMagick, MediaInfo, ExifTool, and the `remove-ai-watermarks` CLI. Integrations are not required for AXIS startup and are not exposed through `axis-cli`. Third-party tools are optional local dependencies; AXIS does not bundle or redistribute them, and users are responsible for complying with each tool's license.

Skills are standard packages installed under `~/.agents/skills`. AXIS CLI release payloads include the official `skills/axis-*` bundle. Desktop triggers synchronization only by running the active `axis skills sync` command after CLI install, update, repair, or development refresh succeeds. Desktop does not package, inspect, synchronize, or render Skills.

## CLI

The CLI is Agent-facing and writes structured Agent Records on stdout. There is no JSON output mode; JSON is used only as an input encoding for request payloads.

AXIS Desktop does not bundle the CLI binary. Desktop installs and manages `axis` from the first-run setup page and Settings > CLI. Release builds download self-contained CLI assets from GitHub Releases in `XiiTang/AXIS`, verify `axis-cli_SHA256SUMS`, and install into the current user's AXIS directory:

```text
~/.axis/bin/axis
~/.axis/cli/current
~/.axis/cli/releases/<version>-<platform-arch>
%USERPROFILE%\.axis\bin\axis.exe
```

Desktop automatically adds the AXIS bin directory to PATH through the managed shell profile block on macOS/Linux or the current user's PATH on Windows. Local development writes a source-linked launcher to `~/.axis/bin/axis` or `%USERPROFILE%\.axis\bin\axis.cmd`, so running `axis` uses the current checkout through the repository's installed development dependencies.

```sh
axis --version
npx tsx apps/axis-cli/src/index.ts runtime status
npx tsx apps/axis-cli/src/index.ts runtime doctor
npx tsx apps/axis-cli/src/index.ts skills status
npx tsx apps/axis-cli/src/index.ts skills sync --force
npx tsx apps/axis-cli/src/index.ts project init path/to/project
npx tsx apps/axis-cli/src/index.ts project validate path/to/project
npx tsx apps/axis-cli/src/index.ts flowmap publish path/to/project --from .axis/flowmaps/image-production.draft.yaml
npx tsx apps/axis-cli/src/index.ts generated-asset lookup path/to/project --path generated/example.png
npx tsx apps/axis-cli/src/index.ts llm request --input-json '{"prompt":"Summarize this project."}'
npx tsx apps/axis-cli/src/index.ts models image list
npx tsx apps/axis-cli/src/index.ts models image describe gpt-image-2
npx tsx apps/axis-cli/src/index.ts generate image path/to/project --input-json '{"model":"gpt-image-2","arguments":{"prompt":"Cover image","output_path":"generated/cover.png"}}'
npx tsx apps/axis-cli/src/index.ts generate image-batch path/to/project --manifest image-requests.json --concurrency 8 --retries 0 --log image-results.jsonl --summary image-summary.json
npx tsx apps/axis-cli/src/index.ts models video list
npx tsx apps/axis-cli/src/index.ts commands
```

Use `generate image-batch` for multiple planned image requests; do not loop over `generate image` for planned batches. `--manifest` expects `{ "requests": [...] }`, with each item shaped like a `generate image` input. Batch item outcomes are written to `--log`; stdout is the final aggregate record.

Use `models image list` to compare configured image models by original model parameters and constraints. Before image generation, run `models image describe <model-id>` once for the selected model. Model descriptions return official documentation URLs, a repository snapshot path, official-documentation-backed `description_markdown`, AXIS examples, and the machine-readable `arguments_schema`.

Do not include provider API keys in generation requests; AXIS reads configured keys locally. Use the original model parameter names shown by `models image list` and confirmed by `models image describe`.

Provider request failures keep the stable CLI error code and include upstream response fields such as `raw_provider_output` or `provider_response` when available.

Minimal Flowmap draft:

```yaml
schemaVersion: 1
canvases:
  - production-map
include:
  - "**/*.png"
```

## Storage Boundaries

Project metadata and canvas state live under `.axis/`. Generated asset metadata, LLM provider settings, generation model settings, and provider secrets live in AXIS-owned runtime storage. Renderer code does not read or write project files, generated asset metadata, model secret files, or Skills directories directly; project and settings operations use the preload/App Server boundary, while Skills synchronization is owned by the CLI.

The CLI and Skills product posture is command-first: AXIS provides commands, structured output, safety guidance, and Skills for external Agents while not being the Agent itself.

## License

AXIS is licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
