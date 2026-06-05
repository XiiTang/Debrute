import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('Debrute image director Skill', () => {
  it('ships debrute-image-director as a static Debrute-managed Skill', () => {
    const skillPath = join(root, 'skills/debrute-image-director/SKILL.md');
    expect(existsSync(skillPath)).toBe(true);

    const skill = readFileSync(skillPath, 'utf8');
    expect(skill).toContain('name: debrute-image-director');
    expect(skill).toContain('description: Use for any task related to image generation or image editing in a Debrute project through the debrute command.');
    expect(skill).toContain('metadata:');
    expect(skill).toContain('debrute.managed: "true"');
    expect(skill).toContain('debrute.package: "debrute"');
    expect(skill).toContain('debrute.version: "0.0.1"');
    expect(skill).toContain('Use for any task related to image generation or image editing.');
    expect(skill).not.toContain('debrute-cli');
    expect(skill).toContain('Run `debrute models image list` to compare configured image models by original model parameters and constraints.');
    expect(skill).toContain('Before generation, run `debrute models image describe <model-id>` once for the selected model.');
    expect(skill).toContain('official documentation URLs');
    expect(skill).toContain('repository snapshot path');
    expect(skill).toContain('description_markdown');
    expect(skill).toContain('arguments_schema');
    expect(skill).toContain('Use original model parameter names shown by `models image list` and confirmed by `models image describe`.');
    expect(skill).toContain('Do not include model API keys in generation requests; Debrute reads configured keys locally.');
    expect(skill).toContain('Use the Debrute example command returned by `models image describe`; do not rely on source API curl or SDK snippets.');
    expect(skill).toContain('Image-capable model fields accept only the image input forms described by `models image describe`; follow each field\'s array/single-value shape and model-specific object shape exactly.');
    expect(skill).toContain('debrute generate image /path/to/project --input-json');
    expect(skill).toContain('debrute generate image-batch /path/to/project --manifest');
    expect(skill).toContain('debrute generate image-batch /path/to/project --manifest <manifest.json> --log <results.jsonl> --summary <summary.json>');
    expect(skill).toContain('debrute generate image-batch /path/to/project --input-jsonl <requests.jsonl> --log <results.jsonl> --summary <summary.json>');
    expect(skill).toContain('Do not loop over `debrute generate image` for a planned set of image requests.');
    expect(skill).toContain('Batch result JSONL contains one final item outcome per line.');
  });

  it('teaches Flowmap draft publishing for generated image output paths', () => {
    const core = readRepoFile('skills/debrute-core/SKILL.md');
    const imageDirector = readRepoFile('skills/debrute-image-director/SKILL.md');

    expect(core).toContain('.debrute/flowmaps/<flowmap-id>.draft.yaml');
    expect(core).toContain('debrute flowmap publish /path/to/project --from .debrute/flowmaps/<flowmap-id>.draft.yaml');
    expect(core).toContain('Do not edit `.debrute/flowmaps/<flowmap-id>.yaml` directly.');
    expect(core).toContain('Maintain the Flowmap draft while creating file-producing scripts, prompts, llm requests, image requests, or video requests.');
    expect(core).toContain('include');
    expect(core).toContain('canvases');
    expect(core).toContain('write them under `<flowmap-id>/`, add matching relative paths or globs to `include`');
    expect(imageDirector).toContain('Update the Flowmap draft when planning image output paths.');
    expect(imageDirector).toContain('add matching paths or globs to `include`');
    expect(imageDirector).toContain('Publish the draft with `debrute flowmap publish');
  });

  it('teaches Flowmap horizontal layout groups for comparable output folders', () => {
    const core = readRepoFile('skills/debrute-core/SKILL.md');
    const imageDirector = readRepoFile('skills/debrute-image-director/SKILL.md');

    expect(core).toContain('layout.groups');
    expect(core).toContain('directory: outputs/gpt-image-2/2000x2000/high');
    expect(core).toContain('include:');
    expect(imageDirector).toContain('layout.groups');
    expect(imageDirector).toContain('comparable variants');
    expect(imageDirector).toContain('direct child output files');
  });

  it('documents batch command semantics in the README', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('- `apps/daemon` - loopback HTTP/SSE runtime that serves the Web workbench and owns privileged project, Canvas, settings, and generated asset operations.');
    expect(readme).toContain('- `apps/app-server` - local domain service boundary for project sessions, Flowmap publishing and sync, Canvas node projection, model settings, generated asset metadata, and explicit CLI service methods.');
    expect(readme).toContain('- `packages/capability-core` - result and artifact value shapes shared by Debrute runtime services.');
    expect(readme).toContain('- `packages/capability-runtime` - model catalogs, model executors, runtime LLM request execution, LLM provider settings, generation model settings, and Skills registry code.');
    expect(readme).toContain('Use `generate image-batch` for multiple planned image requests; do not loop over `generate image` for planned batches.');
    expect(readme).toContain('Batch item outcomes are written to `--log`; stdout is the final aggregate record.');
    expect(readme).toContain('Use `models image list` to compare configured image models by original model parameters and constraints.');
    expect(readme).toContain('Before image generation, run `models image describe <model-id>` once for the selected model.');
    expect(readme).toContain('Do not include model API keys in generation requests; Debrute reads configured keys locally.');
    expect(readme).toContain('Model descriptions return official documentation URLs, a repository snapshot path, official-documentation-backed `description_markdown`, Debrute examples, and the machine-readable `arguments_schema`.');
  });
});
