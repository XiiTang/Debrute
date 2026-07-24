import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const root = process.cwd();

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as Record<string, unknown>;
}

function skillFrontmatter(relativePath: string): Record<string, unknown> {
  const content = readFileSync(join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (!match) throw new Error(`${relativePath} must start with YAML frontmatter.`);
  return parseYaml(match[1] ?? '') as Record<string, unknown>;
}

describe('Debrute product naming contract', () => {
  it('uses Debrute package names and managed Skill metadata', () => {
    expect(readJson('package.json')).toMatchObject({
      name: 'debrute'
    });
    expect(readJson('apps/desktop/package.json')).toMatchObject({
      name: '@debrute/desktop'
    });
    for (const skillPath of [
      'skills/debrute-core/SKILL.md',
      'skills/debrute-image-director/SKILL.md',
      'skills/debrute-video-director/SKILL.md',
      'skills/debrute-audio-director/SKILL.md'
    ]) {
      const frontmatter = skillFrontmatter(skillPath);
      const metadata = frontmatter.metadata as Record<string, unknown>;
      expect(metadata['debrute.managed']).toBe('true');
      expect(metadata['debrute.package']).toBe('debrute');
    }
  });

});
