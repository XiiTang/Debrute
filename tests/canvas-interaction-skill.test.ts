import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Debrute repository Skill', () => {
  it('ships debrute-core as a standard Debrute-managed Skill', () => {
    const skill = readFileSync(join(process.cwd(), 'skills/debrute-core/SKILL.md'), 'utf8');

    expect(skill).toContain('name: debrute-core');
    expect(skill).toContain('description: Use when');
    expect(skill).toContain('metadata:');
    expect(skill).toContain('debrute.managed: "true"');
    expect(skill).toContain('debrute.package: "debrute"');
    expect(skill).toContain('debrute.version: "0.0.1"');
    expect(skill).toContain('debrute commands');
    expect(skill).toContain('## Visual Workbench');
    expect(skill).toContain('debrute workbench start');
    expect(skill).toContain('project_url=<web_url>/open?path=<encodeURIComponent(absProjectPath)>');
    expect(skill).toContain('Debrute CLI returns the runtime base URL and ports; it does not open browsers or projects.');
    expect(skill).toContain('Qoder: /browser Open <project_url>');
    expect(skill).toContain('Antigravity: /browser Open <project_url>');
    expect(skill).toContain('Cline: Use the browser to check <project_url>');
    expect(skill).toContain('Codex app:');
    expect(skill).toContain('await (await browser.capabilities.get("visibility")).set(true)');
    expect(skill).toContain('generate image-batch --manifest');
  });
});
