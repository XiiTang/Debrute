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
    expect(skill).toContain('debrute commands');
    expect(skill).toContain('## Visual Workbench');
    expect(skill).toContain('debrute workbench url ./');
    expect(skill).toContain('debrute workbench url [<project>]');
    expect(skill).toContain('debrute workbench start [<project>] --frontend desktop');
    expect(skill).toContain('browser requested by the user');
    expect(skill).toContain("current Agent harness's built-in browser");
    expect(skill).toMatch(/system\s+default browser/);
    expect(skill).not.toMatch(/^debrute workbench start$/m);
    expect(skill).not.toContain('Qoder:');
    expect(skill).not.toContain('Antigravity:');
    expect(skill).not.toContain('Cline:');
    expect(skill).not.toContain('Codex app:');
    expect(skill).toContain('debrute request batch --input');
    expect(skill).toContain('debrute models tts describe openai-tts-1');
    expect(skill).toContain('debrute models music describe elevenlabs-music');
    expect(skill).toContain('debrute models sfx describe elevenlabs-sound-effects');
  });
});
