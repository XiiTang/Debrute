import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Debrute video director Skill', () => {
  it('teaches video as a Model Kind on the shared Operation surface', () => {
    const skill = readFileSync(
      join(process.cwd(), 'skills/debrute-video-director/SKILL.md'),
      'utf8',
    );
    expect(skill).toContain('name: debrute-video-director');
    expect(skill).toContain('debrute models video describe <model-id>');
    expect(skill).toContain('debrute request single /path/to/project --input');
    expect(skill).toContain('request batch');
    expect(skill).toContain('default to `30m`');
    expect(skill).toContain('extension-free filename');
  });
});
