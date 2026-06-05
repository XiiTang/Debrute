import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const root = process.cwd();

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((path) => path !== 'tests/debrute-rename-contract.test.ts')
    .filter((path) => !path.startsWith('axis-docs-private/'))
    .filter((path) => !path.includes('/officialDocs/snapshots/'));
}

function textFile(path: string): boolean {
  return /\.(?:cjs|css|html|js|json|md|mjs|ts|tsx|txt|yaml|yml)$/.test(path);
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as Record<string, unknown>;
}

function skillFrontmatter(relativePath: string): Record<string, unknown> {
  const content = readFileSync(join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (!match) throw new Error(`${relativePath} must start with YAML frontmatter.`);
  return parseYaml(match[1] ?? '') as Record<string, unknown>;
}

describe('Debrute rename contract', () => {
  it('uses Debrute package names and version 0.0.1 on every release surface', () => {
    expect(readJson('package.json')).toMatchObject({
      name: 'debrute',
      version: '0.0.1'
    });
    expect(readJson('apps/desktop/package.json')).toMatchObject({
      name: '@debrute/desktop',
      version: '0.0.1'
    });
    expect(readJson('apps/debrute-cli/package.json')).toMatchObject({
      name: '@debrute/cli',
      version: '0.0.1',
      bin: { debrute: 'dist/index.js' }
    });
    for (const skillPath of [
      'skills/debrute-core/SKILL.md',
      'skills/debrute-image-director/SKILL.md'
    ]) {
      const frontmatter = skillFrontmatter(skillPath);
      const metadata = frontmatter.metadata as Record<string, unknown>;
      expect(metadata['debrute.managed']).toBe('true');
      expect(metadata['debrute.package']).toBe('debrute');
      expect(metadata['debrute.version']).toBe('0.0.1');
    }
  });

  it('has no stale AXIS product paths, package scopes, release names, or command records in tracked text files', () => {
    const forbidden = [
      'AX' + 'IS',
      'Axis CLI',
      '@' + 'axis/',
      'apps/' + 'axis-cli',
      'axis' + '-cli',
      'axis' + '-desktop',
      'axis' + '_SHA256SUMS',
      'XiiTang/' + 'AXIS',
      'axis' + '-docs-private',
      'axis' + '/1',
      'AX' + 'IS_',
      'x-' + 'axis-daemon-token',
      'x-' + 'axis-daemon-url',
      '.axis/',
      '~/.axis',
      'axis.managed',
      'axis.package',
      'axis.version',
      'axisVersion',
      'currentAxisVersion',
      'axisModelId',
      'axisImageInput',
      'axisModelSpecificImageObject'
    ];

    const failures: string[] = [];
    for (const path of trackedFiles().filter(textFile)) {
      const content = readFileSync(join(root, path), 'utf8');
      for (const term of forbidden) {
        if (content.includes(term)) failures.push(`${path}: contains ${term}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('has no stale AXIS product paths in tracked file names', () => {
    const failures = trackedFiles().filter((path) => [
      'axis-cli',
      'axis-docs-private',
      'axis-core',
      'axis-image-director',
      'AxisCli',
      'axisCli',
      'AxisAppServer',
      'AxisGlobalRuntimeServer',
      'createAxisDaemonHttpServer',
      'axisSkillsSync'
    ].some((term) => path.includes(term)));

    expect(failures).toEqual([]);
  });
});
