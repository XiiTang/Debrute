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
    expect(skill).toContain('debrute.version: 0.0.2');
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
    expect(skill).toContain('--timeout-ms defaults to 600000ms for single image requests');
    expect(skill).toContain('--timeout-ms defaults to 900000ms per item attempt for image batches');
    expect(skill).toContain('--overwrite-existing');
    expect(skill).toContain('model-specific file format, size, dimension, alpha, and mask constraints are left to the upstream model');
  });

  it('teaches Canvas Map pushing for generated image output paths', () => {
    const core = readRepoFile('skills/debrute-core/SKILL.md');
    const imageDirector = readRepoFile('skills/debrute-image-director/SKILL.md');

    expect(core).toContain('.debrute/canvas-maps/<canvas-id>.yaml');
    expect(core).toContain('debrute canvas-map push /path/to/project <canvas-id>');
    expect(core).toContain('paths:');
    expect(core).toContain('layout:');
    expect(core).toContain('rows:');
    expect(core).toContain('String rules under `paths` are literal project paths.');
    expect(core).toContain('Use object rules such as `glob: outputs/**/*.png` only when wildcard matching is intended.');
    expect(core).toContain('add matching literal file/folder entries or explicit `glob:` entries under `paths` and push before running generation.');
    expect(imageDirector).toContain('Update the Canvas Map when planning image output paths.');
    expect(imageDirector).toContain('Add literal file/folder entries under `paths` in `.debrute/canvas-maps/<canvas-id>.yaml`; folder rules must end with `/`, and wildcard matching must use explicit `glob:` entries.');
    expect(imageDirector).toContain('When literal image output paths or explicit `glob:` rules are planned');
    expect(imageDirector).toContain('Push the Canvas Map with `debrute canvas-map push');
  });
});
