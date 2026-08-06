import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Debrute image director Skill', () => {
  it('teaches the shared Model Request Operation contract', () => {
    const skill = readFileSync(
      join(process.cwd(), 'skills/debrute-image-director/SKILL.md'),
      'utf8',
    );
    expect(skill).toContain('name: debrute-image-director');
    expect(skill).toContain('debrute.managed: "true"');
    expect(skill).toContain('debrute models image describe <model-id>');
    expect(skill).toContain('direct `--model`, `--arguments`, and');
    expect(skill).toContain('debrute request batch --input');
    expect(skill).toContain('Both output fields are required');
    expect(skill).toContain('relative to the CLI working directory');
    expect(skill).toContain('Do not loop over Single commands for a Batch');
    expect(skill).toContain('Batch can exit 0');
    expect(skill).toContain('An output inside an open Project');
  });
});
