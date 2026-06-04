# AXIS

AXIS is a browser-first local creative production workbench for projects, Canvas review, and generation capabilities. The primary runtime is a normal Web workbench backed by a loopback daemon. Electron is an optional native shell that starts the daemon and loads the same Web URL. AXIS does not implement an internal Agent; external Agents use AXIS through `axis-cli` and AXIS Skills installed under the standard shared Skills directory.

## What Is Here

- `apps/web` - Vite/React browser workbench. It talks to the daemon through HTTP and SSE.
- `apps/daemon` - loopback HTTP/SSE runtime that serves the Web workbench and owns privileged project, Canvas, settings, and generated asset operations.
- `apps/desktop` - optional Electron shell for native folder picking, menus, packaging, and loading the Web workbench URL.
- `apps/app-server` - local domain service boundary for project sessions, Flowmap publishing and sync, Canvas node projection, model settings, generated asset metadata, and explicit CLI service methods.
- `apps/axis-cli` - external Agent interface for invoking AXIS capabilities with structured output.
- `packages/project-core` - project identity, `.axis/` path conventions, atomic JSON persistence, project text/binary file access, and file event normalization.
- `packages/flowmap-core` - Flowmap YAML parsing, publishing, include expansion, file-tree node derivation, and structure edge derivation.
- `packages/canvas-core` - Canvas documents, projected node state, derived structure edges, selection, viewport, diagnostics, and node layout operations.
- `packages/capability-core` - result and artifact value shapes shared by AXIS runtime services.
- `packages/capability-runtime` - model catalogs, model executors, runtime LLM request execution, LLM provider settings, generation model settings, and Skills registry code.
- `skills/axis-*` - AXIS-managed standard Skills packages for external Agents.

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
pnpm exec tsx apps/axis-cli/src/index.ts project validate path/to/project
```

`pnpm doctor` checks the local Node/pnpm/tooling surface needed for development and macOS packaging. `pnpm verify` runs doctor, type checking, tests, architecture lint, and the production build.

`pnpm dev` starts or reuses the shared local Workbench runtime and prints the Web URL. It prefers daemon port `17321` and Web port `17322` when they are free, but they are not required ports. The Web workbench is the primary product surface and can be opened directly in a normal browser. `pnpm dev:electron` participates in the same runtime registry, so it attaches to an existing healthy daemon/Web pair instead of starting a competing one. One daemon can host multiple live project sessions, and browser tabs or Electron windows connected to that daemon attach to `/projects/<project-id>` routes with daemon-issued opaque project ids. A project is opened only through an explicit project-open request or the Electron shell's Open Project/Open Recent actions; the root workbench route does not reopen the last project.

`pnpm preview` serves the production Web build for smoke testing after `pnpm build`. `pnpm clean` removes generated build, release, and TypeScript build-info files.

`pnpm package:cli` creates the current-platform standalone CLI release asset under `release/axis-cli/` with bundled Skills and Web workbench assets. `pnpm package:cli:all` creates all supported CLI assets for GitHub Releases.

`pnpm pack` creates an unpacked desktop app under `apps/desktop/release/`. `pnpm dist` creates distributable macOS and Windows installer artifacts when run on the matching platform. Packaged builds and standalone CLI assets are published from the public `XiiTang/AXIS` GitHub repository.

## Product Model

Project is the local file workspace plus `.axis/` metadata, generated assets, and health diagnostics.

Flowmap YAML controls file membership and Canvas mounts. A Flowmap lives at `.axis/flowmaps/<flowmap-id>.draft.yaml`, publishes to `.axis/flowmaps/<flowmap-id>.yaml`, and uses the project directory `<flowmap-id>/` as its file-tree root.

Canvas is the visual workspace for projected Flowmap nodes. Canvas JSON under `.axis/canvases/<canvas-id>.json` stores visual state only: node layout, layers, viewport, selection, annotations, and preferences. File structure defines hierarchy and structure edges; YAML only defines `canvases` and `include`.

Capabilities are discrete operations that the daemon-backed Web workbench or `axis-cli` can invoke: project semantics, LLM requests, image generation, video generation, and generated asset metadata lookup. External Agents use their own filesystem tools for generic file access.

Integrations are optional local capabilities that the daemon detects and the Web Settings surface renders as command previews. The first supported integrations are FFmpeg, ImageMagick, MediaInfo, ExifTool, and the `remove-ai-watermarks` CLI. Integrations are not required for AXIS startup and are not exposed through `axis-cli`. Third-party tools are optional local dependencies; AXIS does not bundle or redistribute them, and users are responsible for complying with each tool's license.

Skills are standard packages installed under `~/.agents/skills`. AXIS CLI release payloads include the official `skills/axis-*` bundle. Skills synchronization is explicit through `axis skills sync`; the Web workbench and Electron shell do not package, inspect, synchronize, or render Skills.

## CLI

The CLI is Agent-facing and writes structured Agent Records on stdout. There is no JSON output mode; JSON is used only as an input encoding for request payloads.

```sh
axis --version
pnpm exec tsx apps/axis-cli/src/index.ts runtime status
pnpm exec tsx apps/axis-cli/src/index.ts runtime doctor
pnpm exec tsx apps/axis-cli/src/index.ts skills status
pnpm exec tsx apps/axis-cli/src/index.ts skills sync --force
pnpm exec tsx apps/axis-cli/src/index.ts project init path/to/project
pnpm exec tsx apps/axis-cli/src/index.ts project validate path/to/project
pnpm exec tsx apps/axis-cli/src/index.ts workbench url path/to/project
pnpm exec tsx apps/axis-cli/src/index.ts flowmap publish path/to/project --from .axis/flowmaps/image-production.draft.yaml
pnpm exec tsx apps/axis-cli/src/index.ts generated-asset lookup path/to/project --path generated/example.png
pnpm exec tsx apps/axis-cli/src/index.ts llm request --input-json '{"prompt":"Summarize this project."}'
pnpm exec tsx apps/axis-cli/src/index.ts models image list
pnpm exec tsx apps/axis-cli/src/index.ts models image describe gpt-image-2
pnpm exec tsx apps/axis-cli/src/index.ts generate image path/to/project --input-json '{"model":"gpt-image-2","arguments":{"prompt":"Cover image","output_path":"generated/cover.png"}}'
pnpm exec tsx apps/axis-cli/src/index.ts generate image-batch path/to/project --manifest image-requests.json --concurrency 8 --retries 0 --log image-results.jsonl --summary image-summary.json
pnpm exec tsx apps/axis-cli/src/index.ts models video list
pnpm exec tsx apps/axis-cli/src/index.ts commands
```

Use `generate image-batch` for multiple planned image requests; do not loop over `generate image` for planned batches. `--manifest` expects `{ "requests": [...] }`, with each item shaped like a `generate image` input. Batch item outcomes are written to `--log`; stdout is the final aggregate record.

Use `models image list` to compare configured image models by original model parameters and constraints. Before image generation, run `models image describe <model-id>` once for the selected model. Model descriptions return official documentation URLs, a repository snapshot path, official-documentation-backed `description_markdown`, AXIS examples, and the machine-readable `arguments_schema`.

Do not include model API keys in generation requests; AXIS reads configured keys locally. Use the original model parameter names shown by `models image list` and confirmed by `models image describe`.

Model request failures keep the stable CLI error code and include the AXIS model id, message, and structured logs when available.

Minimal Flowmap draft:

```yaml
schemaVersion: 1
canvases:
  - production-map
include:
  - "**/*.png"
```

## Storage Boundaries

Project metadata and canvas state live under `.axis/`. Generated asset metadata, LLM provider settings, generation model settings, LLM provider secrets, and generation model secrets live in AXIS-owned runtime storage. Renderer code does not read or write project files, generated asset metadata, model secret files, or Skills directories directly; project and settings operations use the daemon/App Server boundary, while Skills synchronization is owned by the CLI.

The CLI and Skills product posture is command-first: AXIS provides commands, structured output, safety guidance, and Skills for external Agents while not being the Agent itself. `axis workbench url <project>` is the only CLI browser-facing entrypoint: it starts or reuses the local Workbench runtime, opens the project through the daemon, and returns the Workbench URL without opening a browser. One-shot project, Flowmap, and generation commands do not require the Workbench daemon.

## License

AXIS is licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
