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
    expect(skill).toContain('debrute workbench start /absolute/path/to/project --frontend browser');
    expect(skill).toContain('debrute workbench start /absolute/path/to/project --frontend desktop');
    expect(skill).toContain('Interactive users can also open projects from the Workbench `Open Project` picker.');
    expect(skill).toContain('`--frontend browser` opens the Project in the system browser.');
    expect(skill).toContain('Qoder: use /browser to inspect the opened Debrute Workbench tab');
    expect(skill).toContain('Antigravity: use /browser to inspect the opened Debrute Workbench tab');
    expect(skill).toContain('Cline: use the browser to inspect the opened Debrute Workbench tab');
    expect(skill).toContain('Codex app:');
    expect(skill).toContain('use Browser for Web or Computer Use for Desktop');
    expect(skill).toContain('debrute request batch /path/to/project --input');
    expect(skill).toContain('debrute models tts describe openai-gpt-4o-mini-tts');
    expect(skill).toContain('debrute models music describe elevenlabs-music');
    expect(skill).toContain('debrute models sfx describe elevenlabs-sound-effects');
  });
});
