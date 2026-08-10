# Getting Started

This guide covers one complete Debrute workflow: open a real Project, let an external agent work with its existing tools, review many file types on the Canvas, leave structured Feedback, and ask the agent to continue from that Feedback.

## Start The Development Workbench

Source development currently supports macOS and Windows and requires the repository toolchain checked by `pnpm doctor`.

```sh
git clone https://github.com/XiiTang/Debrute.git
cd Debrute
pnpm install
pnpm doctor
pnpm dev
```

`pnpm dev` starts or reuses the local Rust Runtime, starts the Web development frontend, and prints the exact Workbench URL without opening a browser. Open that URL in your preferred browser.

Use `pnpm dev:electron` instead when developing through the Electron Desktop host.

## Open A Real Project

Choose **Open Project** and select an existing folder. That folder is the Project source of truth; Debrute does not copy its contents into another workspace.

Every regular file and directory belongs to the Canvas. Expand or collapse Project folders to control the visible descendants, then arrange related files spatially for comparison.

## Let Your Agent Work Normally

Open the same folder in the agent harness you already use. The agent can create, edit, move, or delete files with its existing filesystem, terminal, browser, generation, and editing tools. Changes beneath the open Project are reflected in the Project Tree and Canvas.

For example:

> Create three visual directions for this brief under `concepts/`. Keep the prompt and a short rationale beside each result.

Debrute Model Requests and official Skills are optional. Use them when their image, video, audio, provenance, or Project semantics help; files created through other tools remain ordinary Project files and appear on the Canvas in the same way.

## Review The Project On Canvas

Use the Canvas to keep source context and outputs together:

- compare many image alternatives at once;
- preview and play video files, with the selected playback position retained;
- play audio beside its prompt, notes, or related media;
- preview and edit briefs, prompts, Markdown, structured data, configuration, logs, code, scripts, patches, tables, subtitles, and other registered text formats;
- keep unfamiliar or non-previewable regular files visible as part of the Project structure.

The text editor can also open an unfamiliar-suffix file when it is regular, valid UTF-8 text without a binary NUL. Rich automatic Canvas text classification remains registry-based.

The Canvas rendering system uses spatial indexes, viewport culling, incremental DOM presentation, and interaction-aware preview scheduling for large working sets. See [Canvas rendering](./canvas-rendering.md) for the exact technical contract.

## Leave Structured Feedback

Use Feedback Marks to classify whole files, or add comments to record the reason behind a choice. Images support numbered pins and regions. Videos support comments, pins, and regions at exact moments.

Accepted Feedback is stored in:

```text
.debrute/feedback/feedback.json
```

External agents can read that document with ordinary filesystem tools. They can also update it when explicitly asked, provided they preserve the validated Feedback schema and avoid racing another writer. Files under `.debrute/feedback/artifacts/` are Runtime-derived visual aids and must not be edited by an agent.

Try this workflow:

1. Mark several image outputs as **Like**.
2. Add a region comment to any output that still needs a local correction.
3. Ask the agent:

   > Read the project Feedback. Combine all liked images into a 3 x 3 grid, then address the region comments in separate revised files. Keep the originals.

4. Review the new files when they appear on the Canvas.

Feedback is current review state, not workflow history or an approval system. An agent should not clear or rewrite subjective user Feedback unless the user explicitly asks it to.

## Continue In Photoshop

The repository includes a Photoshop UXP plugin. It transfers Project assets through the Runtime-owned integration while preserving the real Project file and path identity. See [Photoshop file transfer](./photoshop.md) for supported formats, installation, and exact behavior.

## Go Deeper

- [Product model](./product-model.md)
- [Canvas architecture](./canvas.md)
- [Canvas media presentation](./canvas-media.md)
- [Text files and Canvas previews](./text-files.md)
- [Canvas Feedback](./canvas-feedback.md)
- [CLI and official Skills](./cli.md)
- [Development](./development.md)
