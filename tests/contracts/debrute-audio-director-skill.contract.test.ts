import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Debrute audio director Skill', () => {
  it('keeps TTS, music, and sound-effect as peer Model Kinds', () => {
    const skill = readFileSync(
      join(process.cwd(), 'skills/debrute-audio-director/SKILL.md'),
      'utf8',
    );
    expect(skill).toContain('peer Model Kinds TTS, music, and sound-effect');
    expect(skill).toContain('debrute models tts|music|sfx list');
    expect(skill).toContain('debrute request single /path/to/project --input');
    expect(skill).toContain('debrute request batch /path/to/project --input');
    expect(skill).toContain('default to `10m`');
    expect(skill).toContain('Batch supports every audio Model Kind');
    expect(skill).toContain('exit 0 with failed Items');
  });
});
