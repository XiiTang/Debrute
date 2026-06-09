# Debrute

Debrute is a browser-first local creative production workbench for projects, Canvas review, and generation capabilities. The primary runtime is a normal Web workbench backed by a loopback daemon. Electron is an optional native shell that starts the daemon and loads the same Web URL. Debrute does not implement an internal Agent; external Agents use Debrute through Debrute CLI and Debrute Skills installed under the standard shared Skills directory.

## What Is Here

- `apps/web` - Vite/React browser workbench. It talks to the daemon through HTTP and SSE.
- `apps/daemon` - loopback HTTP/SSE runtime that serves the Web workbench and owns privileged project, Canvas, settings, and generated asset operations.
- `apps/desktop` - optional Electron shell for native folder picking, menus, packaging, and loading the Web workbench URL.
- `apps/app-server` - local domain service boundary for project sessions, Flowmap publishing and sync, Canvas node projection, model settings, generated asset metadata, and explicit CLI service methods.
- `apps/debrute-cli` - external Agent interface for invoking Debrute capabilities with structured output.
- `packages/project-core` - project identity, `.debrute/` path conventions, atomic JSON persistence, project text/binary file access, and file event normalization.
- `packages/flowmap-core` - Flowmap YAML parsing, publishing, include expansion, file-tree node derivation, and structure edge derivation.
- `packages/canvas-core` - Canvas documents, projected node state, derived structure edges, selection, viewport, diagnostics, and node layout operations.
- `packages/capability-core` - result and artifact value shapes shared by Debrute runtime services.
- `packages/capability-runtime` - model catalogs, model executors, runtime LLM request execution, LLM provider settings, generation model settings, and Skills registry code.
- `skills/debrute-*` - Debrute-managed standard Skills packages for external Agents.

## Commands

```sh
pnpm install
pnpm doctor
pnpm check
pnpm test
pnpm lint:arch
pnpm build
pnpm package:cli
pnpm package:cli:all
pnpm verify
pnpm pack
pnpm dist
pnpm dev
pnpm dev:electron
pnpm preview
pnpm clean
pnpm exec tsx apps/debrute-cli/src/index.ts project validate path/to/project
```

`pnpm doctor` checks the local Node/pnpm/tooling surface needed for development and macOS packaging. `pnpm verify` runs doctor, type checking, tests, architecture lint, and the production build.

`pnpm dev` starts or reuses the shared local Workbench runtime and prints the Web URL. It prefers daemon port `17321` and Web port `17322` when they are free, but they are not required ports. The Web workbench is the primary product surface and can be opened directly in a normal browser. `pnpm dev:electron` participates in the same runtime registry, so it attaches to an existing healthy daemon/Web pair instead of starting a competing one. One daemon can host multiple live project sessions, and browser tabs or Electron windows connected to that daemon attach to `/projects/<project-id>` routes with daemon-issued opaque project ids. A project is opened only through an explicit project-open request or the Electron shell's Open Project/Open Recent actions; the root workbench route does not reopen the last project.

`pnpm preview` serves the production Web build for smoke testing after `pnpm build`. `pnpm clean` removes generated build, release, and TypeScript build-info files.

`pnpm package:cli` creates the current-platform standalone CLI release asset under `release/debrute-cli/` with bundled Skills and Web workbench assets. `pnpm package:cli:all` creates all supported CLI assets for GitHub Releases.

`pnpm pack` creates an unpacked desktop app under `apps/desktop/release/`. `pnpm dist` creates distributable Desktop artifacts when run on the matching platform. Packaged builds and standalone CLI assets are published from the public `XiiTang/Debrute` GitHub repository.

## Releases

Debrute publishes Desktop installers and Debrute CLI archives on GitHub Releases.

Current Desktop builds are unsigned. macOS may require right-click Open or Privacy & Security approval. Windows may show SmartScreen. Linux AppImage builds may require `chmod +x`.

Each `vX.Y.Z` release includes these public asset names:

```text
debrute-desktop-X.Y.Z-macos-arm64.dmg
debrute-desktop-X.Y.Z-macos-x64.dmg
debrute-desktop-X.Y.Z-windows-x64.exe
debrute-desktop-X.Y.Z-linux-x64.AppImage
debrute-cli-X.Y.Z-macos-arm64.tar.gz
debrute-cli-X.Y.Z-macos-x64.tar.gz
debrute-cli-X.Y.Z-linux-arm64.tar.gz
debrute-cli-X.Y.Z-linux-x64.tar.gz
debrute-cli-X.Y.Z-windows-arm64.zip
debrute-cli-X.Y.Z-windows-x64.zip
debrute_SHA256SUMS
```

Verify manual downloads against `debrute_SHA256SUMS` from the same release tag before installing. Filter the manifest to the asset you downloaded:

```sh
grep "  debrute-cli-X.Y.Z-macos-arm64.tar.gz$" debrute_SHA256SUMS | shasum -a 256 -c -
```

On Linux, use:

```sh
sha256sum -c --ignore-missing debrute_SHA256SUMS
```

Debrute CLI is managed from Debrute Desktop Settings under **Debrute CLI**. The Desktop app downloads the matching CLI archive from the same GitHub Release, verifies `debrute_SHA256SUMS`, installs the command as `debrute`, and runs:

```sh
debrute skills sync
```

Manual Skill commands:

```sh
debrute skills status
debrute skills sync
debrute skills sync --force
```

`debrute skills sync --force` restores all official Debrute Skills. Normal sync updates installed official Skills and adds newly introduced official Skills without restoring official Skills the user removed.

## Product Model

Project is the local file workspace plus `.debrute/` metadata, generated assets, and health diagnostics.

Flowmap YAML controls file membership and Canvas mounts. A Flowmap lives at `.debrute/flowmaps/<flowmap-id>.draft.yaml`, publishes to `.debrute/flowmaps/<flowmap-id>.yaml`, and uses the project directory `<flowmap-id>/` as its file-tree root.

Canvas is the visual workspace for projected Flowmap nodes. Canvas JSON under `.debrute/canvases/<canvas-id>.json` stores visual state only: node layout, layers, viewport, selection, annotations, and preferences. File structure defines hierarchy and structure edges; YAML only defines `canvases` and `include`.

Capabilities are discrete operations that the daemon-backed Web workbench or the `debrute` command can invoke: project semantics, LLM requests, image generation, video generation, and generated asset metadata lookup. External Agents use their own filesystem tools for generic file access.

Integrations are optional local capabilities that the daemon detects and the Web Settings surface renders as command previews. The first supported integrations are FFmpeg, ImageMagick, MediaInfo, ExifTool, and the `remove-ai-watermarks` CLI. Integrations are not required for Debrute startup and are not exposed through the `debrute` command. Third-party tools are optional local dependencies; Debrute does not bundle or redistribute them, and users are responsible for complying with each tool's license.

Skills are standard packages installed under `~/.agents/skills`. Debrute CLI release payloads include the official `skills/debrute-*` bundle. Skills synchronization is explicit through `debrute skills sync`; Debrute Desktop can invoke that managed CLI sync from Settings, and the Web workbench shows manual instructions only.

## CLI

The CLI is Agent-facing and writes structured Agent Records on stdout. There is no JSON output mode; JSON is used only as an input encoding for request payloads.

```sh
debrute --version
pnpm exec tsx apps/debrute-cli/src/index.ts runtime status
pnpm exec tsx apps/debrute-cli/src/index.ts runtime doctor
pnpm exec tsx apps/debrute-cli/src/index.ts skills status
pnpm exec tsx apps/debrute-cli/src/index.ts skills sync
pnpm exec tsx apps/debrute-cli/src/index.ts project init path/to/project
pnpm exec tsx apps/debrute-cli/src/index.ts project validate path/to/project
pnpm exec tsx apps/debrute-cli/src/index.ts workbench url path/to/project
pnpm exec tsx apps/debrute-cli/src/index.ts flowmap publish path/to/project --from .debrute/flowmaps/image-production.draft.yaml
pnpm exec tsx apps/debrute-cli/src/index.ts generated-asset lookup path/to/project --path generated/example.png
pnpm exec tsx apps/debrute-cli/src/index.ts llm request --input-json '{"prompt":"Summarize this project."}'
pnpm exec tsx apps/debrute-cli/src/index.ts models image list
pnpm exec tsx apps/debrute-cli/src/index.ts models image describe gpt-image-2
pnpm exec tsx apps/debrute-cli/src/index.ts generate image path/to/project --input-json '{"model":"gpt-image-2","arguments":{"prompt":"Cover image","output_path":"generated/cover.png"}}'
pnpm exec tsx apps/debrute-cli/src/index.ts generate image-batch path/to/project --manifest image-requests.json --concurrency 8 --retries 0 --log image-results.jsonl --summary image-summary.json
pnpm exec tsx apps/debrute-cli/src/index.ts models video list
pnpm exec tsx apps/debrute-cli/src/index.ts models video describe doubao-seedance-2-0-260128
pnpm exec tsx apps/debrute-cli/src/index.ts generate video path/to/project --input-json '{"model":"doubao-seedance-2-0-260128","arguments":{"prompt":"Short video brief","intent":"generate"}}'
pnpm exec tsx apps/debrute-cli/src/index.ts commands
```

Use `generate image-batch` for multiple planned image requests; do not loop over `generate image` for planned batches. `--manifest` expects `{ "requests": [...] }`, with each item shaped like a `generate image` input. Batch item outcomes are written to `--log`; stdout is the final aggregate record.

Use `models image list` to compare configured image models by original model parameters and constraints. Before image generation, run `models image describe <model-id>` once for the selected model. Model descriptions return official documentation URLs, a repository snapshot path, official-documentation-backed `description_markdown`, Debrute examples, and the machine-readable `arguments_schema`.

Use `models video list` to compare configured video models by Debrute-native parameters and constraints. Before video generation, run `models video describe <model-id>` once for the selected model. Video model descriptions return official documentation URLs, a repository snapshot path, official-documentation-backed `description_markdown`, Debrute examples, and the machine-readable `arguments_schema`.

Video generation uses `prompt`, `intent`, and `references`; Debrute constructs Seedance `content` internally. Project-local image and audio references can be normalized by Debrute when the selected model supports them. Project-local video references require Debrute upload-server support unless the source is already `http(s)` or `asset://`.

Do not include model API keys in generation requests; Debrute reads configured keys locally. Use the original model parameter names shown by `models image list` and confirmed by `models image describe`.

Model request failures keep the stable CLI error code and include the Debrute model id, message, and structured logs when available.

Minimal Flowmap draft:

```yaml
schemaVersion: 1
canvases:
  - production-map
include:
  - "**/*.png"
```

## Storage Boundaries

Project metadata and canvas state live under `.debrute/`. Generated asset metadata, LLM provider settings, generation model settings, LLM provider secrets, and generation model secrets live in Debrute-owned runtime storage. Renderer code does not read or write project files, generated asset metadata, model secret files, or Skills directories directly; project and settings operations use the daemon/App Server boundary, while Skills synchronization is owned by the CLI.

The CLI and Skills product posture is command-first: Debrute provides commands, structured output, safety guidance, and Skills for external Agents while not being the Agent itself. `debrute workbench url <project>` is the only CLI browser-facing entrypoint: it starts or reuses the local Workbench runtime, opens the project through the daemon, and returns the Workbench URL without opening a browser. One-shot project, Flowmap, and generation commands do not require the Workbench daemon.

## License

Debrute is licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
