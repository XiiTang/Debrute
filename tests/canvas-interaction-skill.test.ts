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
    expect(skill).toContain('## Visual Workbench');
    expect(skill).toContain('axis workbench url /path/to/project');
    expect(skill).toContain('AXIS CLI only returns URLs and ports; it does not open browsers.');
    expect(skill).toContain('Qoder: /browser Open <project_url>');
    expect(skill).toContain('Antigravity: /browser Open <project_url>');
    expect(skill).toContain('Cline: Use the browser to check <project_url>');
    expect(skill).toContain('Codex app:');
    expect(skill).toContain('await (await browser.capabilities.get("visibility")).set(true)');
    expect(skill).toContain('generate image-batch --manifest');
  });
});
