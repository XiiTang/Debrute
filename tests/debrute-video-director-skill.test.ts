import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('Debrute video director Skill', () => {
  it('ships debrute-video-director as a static Debrute-managed Skill', () => {
    const skill = readRepoFile('skills/debrute-video-director/SKILL.md');

    expect(skill).toContain('name: debrute-video-director');
    expect(skill).toContain('description: Use for any task related to video generation or video editing in a Debrute project through the debrute command.');
    expect(skill).toContain('debrute.managed: "true"');
    expect(skill).toContain('Run `debrute models video list` to compare configured video models by Debrute-native parameters and constraints.');
    expect(skill).toContain('Before generation, run `debrute models video describe <model-id>` once for the selected model.');
    expect(skill).toContain('Use `prompt`, `intent`, and `references`; do not assemble official Seedance `content` arrays.');
    expect(skill).toContain('Project-local video references require Debrute upload-server support unless the source is already `http(s)` or `asset://`.');
    expect(skill).toContain('debrute generate video /path/to/project --input-json');
    expect(skill).toContain('--timeout-ms defaults to 600000ms for video requests');
    expect(skill).toContain('Add literal file/folder entries under `paths` in `.debrute/canvas-maps/<canvas-id>.yaml`; folder rules must end with `/`, and wildcard matching must use explicit `glob:` entries.');
    expect(skill).toContain('When literal output paths or explicit `glob:` rules are planned');
  });

  it('updates core Skill video examples to the native request contract', () => {
    const core = readRepoFile('skills/debrute-core/SKILL.md');

    expect(core).toContain('debrute models video describe doubao-seedance-2-0-260128');
    expect(core).toContain('"prompt":"Short video brief"');
    expect(core).not.toContain('"content":[{"type":"text"');
  });
});
