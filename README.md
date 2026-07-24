# Debrute

[中文版](./README.zh-CN.md)

Debrute is a local creative production workbench for the files that AI agents generate: images, videos, audio, documents, and design references.

It is built around a simple belief: the best agents already exist, and the best professional creative tools already exist. Debrute does not try to replace either side. Instead, it gives agents, designers, and creative teams a shared place to generate, inspect, organize, compare, annotate, and hand off production assets.

## Why Debrute Exists

Modern agents are already good at planning, writing prompts, calling tools, generating assets, and editing files. What is still awkward is the space between an agent's filesystem operations and a human's visual judgment.

Generated assets are often binary, visual, versioned, and messy. They need to be seen, compared, rejected, annotated, selected, and passed into professional tools. A terminal transcript is not enough. A folder tree is not enough. A single chat attachment is not enough.

Debrute turns a local project folder into an agent-readable and human-readable production space.

## What Debrute Is

- A local workbench for generated production assets.
- A visual Canvas for reviewing project files, asset variants, folder structure, and feedback.
- A project model based on your real local folder, not an imported cloud workspace.
- A bridge between external agents, generated files, and professional design tools.
- A command and Skills surface that lets agents call Debrute without becoming dependent on a Debrute-specific agent.

Debrute is designed for projects where filesystem structure matters. You can ask an agent to create folders, prompts, references, outputs, alternatives, and final picks. The folder hierarchy itself becomes part of the project logic: a lightweight way to express grouping, sequencing, comparison, and intent.

## What Debrute Is Not

Debrute is not an agent.

The market already has strong agents, and they keep improving quickly. Debrute does not implement its own planner, coding assistant, creative director, or autonomous workflow engine. You bring the agent you like, install the Skills you need, and let that agent use Debrute as a project and asset workbench.

Debrute is not a workflow system.

It does not force a fixed production pipeline. It does not prescribe how you should brainstorm, generate, rank, edit, approve, or publish. Agents and humans can express those choices through files, folders, Canvas Maps, prompts, and normal project conventions.

Debrute is not a replacement for Photoshop, Blender, Premiere, Figma, or other professional creative software.

AI generation does not replace the precision, control, and expertise of professional editing tools. Debrute intentionally avoids features that those tools already do well. For professional designers, Debrute is the place to generate, gather, review, compare, and select resources before taking them into specialized software. The repository includes Photoshop plugins for moving assets between Debrute and Photoshop.

## Working With Agents

Debrute is agent-agnostic. It works best with agent GUI projects that have a built-in browser, because the agent can open the Debrute Workbench, inspect Canvas state, understand visual feedback, and then update project files in the same loop.

Good examples to evaluate first:

- [Codex](https://developers.openai.com/codex/app/browser)
- [Qoder](https://docs.qoder.com/user-guide/chat/browser-agent)
- [Cursor](https://cursor.com/docs/agent/tools/browser)
- [Google Antigravity](https://www.antigravity.google/docs/browser)

All CLI agents can use Debrute too. Debrute provides a command surface and official Skills so external agents can start the Workbench, validate a project, push Canvas Maps, request generation, and inspect generated asset metadata.

## Working With Designers

Debrute is meant to sit before and beside professional editing software, not above it.

A designer can use Debrute as a resource table: generate many candidates, keep references nearby, mark what works, reject what does not, annotate exact visual regions, compare variations, and then move selected assets into tools like Photoshop or other specialized editors.

This repository includes UXP and CEP Photoshop plugins that share one Debrute bridge protocol.

## Project Model

A Debrute project is your local folder plus Debrute metadata under `.debrute/`.

The local folder remains the source of truth. Agents can use normal filesystem tools to create project structure, prompts, references, generated outputs, and final assets. Debrute adds a visual layer over that folder so humans and agents can see the same project shape.

Canvas Maps define which project files appear on a Canvas. The Canvas then becomes the shared visual surface for review, comparison, selection, and feedback.

## Official Skills

Debrute ships standard Skills for external agents:

- `debrute-core` for project semantics, Workbench URLs, Canvas Map pushes, generated assets, and model-backed generation.
- `debrute-image-director` for image generation and editing through the `debrute` command.
- `debrute-video-director` for video generation and editing through the `debrute` command.
- `debrute-audio-director` for TTS, music generation, and sound effect generation through the `debrute` command.

The Skills explain how to call Debrute. They are not hidden APIs and they do not replace the agent's own tools.

## Technical Docs

The README is intentionally short. Technical details live here:

- [Documentation index](./docs/README.md)
- [Product model](./docs/product-model.md)
- [Domain context map](./CONTEXT-MAP.md)
- [Development](./docs/development.md)

## License

Debrute is licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
