import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AXIS repository Skill', () => {
  it('ships axis-core as a standard AXIS-managed Skill', () => {
    const skill = readFileSync(join(process.cwd(), 'skills/axis-core/SKILL.md'), 'utf8');

    expect(skill).toContain('name: axis-core');
    expect(skill).toContain('description: Use when');
    expect(skill).toContain('metadata:');
    expect(skill).toContain('axis.managed: "true"');
    expect(skill).toContain('axis.package: "axis"');
    expect(skill).toContain('axis.version: "0.1.0"');
    expect(skill).toContain('axis commands');
    expect(skill).toContain('generate image-batch --manifest');
    expect(skill).not.toContain('--json');
  });
});
