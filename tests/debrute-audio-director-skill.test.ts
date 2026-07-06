import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('Debrute audio director Skill', () => {
  it('ships debrute-audio-director as a static Debrute-managed Skill', () => {
    const skill = readRepoFile('skills/debrute-audio-director/SKILL.md');

    expect(skill).toContain('name: debrute-audio-director');
    expect(skill).toContain('description: Use for any task related to TTS, music generation, or sound effect generation in a Debrute project through the debrute command.');
    expect(skill).toContain('debrute.managed: "true"');
    expect(skill).toContain('Pick exactly one audio use case before listing models: TTS, music, or sound effects.');
    expect(skill).toContain('run `debrute models tts list`');
    expect(skill).toContain('run `debrute models music list`');
    expect(skill).toContain('run `debrute models sfx list`');
    expect(skill).toContain('official documentation URLs');
    expect(skill).toContain('repository snapshot path');
    expect(skill).toContain('description_markdown');
    expect(skill).toContain('arguments_schema');
    expect(skill).toContain('Do not include model API keys in generation requests; Debrute reads configured keys locally.');
    expect(skill).toContain('debrute generate tts /path/to/project --input-json');
    expect(skill).toContain('debrute generate music /path/to/project --input-json');
    expect(skill).toContain('debrute generate sfx /path/to/project --input-json');
    expect(skill).toContain('--timeout-ms defaults to 600000ms for audio requests');
    expect(skill).toContain('Add literal file/folder entries under `paths` in `.debrute/canvas-maps/<canvas-id>.yaml`; folder rules must end with `/`, and wildcard matching must use explicit `glob:` entries.');
  });

  it('updates core Skill audio examples to separate TTS, music, and sound-effect commands', () => {
    const core = readRepoFile('skills/debrute-core/SKILL.md');

    expect(core).toContain('debrute models tts describe openai-gpt-4o-mini-tts');
    expect(core).toContain('debrute generate tts /path/to/project --input-json');
    expect(core).toContain('debrute models music describe elevenlabs-music');
    expect(core).toContain('debrute generate music /path/to/project --input-json');
    expect(core).toContain('debrute models sfx describe elevenlabs-sound-effects');
    expect(core).toContain('debrute generate sfx /path/to/project --input-json');
  });
});
