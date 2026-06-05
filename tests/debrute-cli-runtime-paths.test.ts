import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  resolveCliDebruteVersion,
  resolveCliBundledSkillsRoot,
  resolvePkgExecutableEntryDir
} from '../apps/debrute-cli/src/runtime/createCliSkillsRuntime';
import { packagedExecutablePath, packagedNodeModulesPath, packagedNodePathValue } from '../apps/debrute-cli/src/runtime/packagedNodeModules';

describe('Debrute CLI runtime paths', () => {
  it('resolves bundled skills and package metadata from a release payload next to the executable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-cli-release-'));
    await mkdir(join(root, 'skills'), { recursive: true });
    await writeFile(join(root, 'debrute'), '', 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.7.0' }), 'utf8');

    expect(await resolveCliBundledSkillsRoot(root)).toBe(join(root, 'skills'));
    expect(await resolveCliDebruteVersion(root)).toBe('0.7.0');
  });

  it('resolves pkg entry directories from process.execPath', () => {
    expect(resolvePkgExecutableEntryDir('/Users/test/.debrute/cli/current/debrute')).toBe('/Users/test/.debrute/cli/current');
    expect(resolvePkgExecutableEntryDir('C:\\Users\\test\\.debrute\\cli\\current\\debrute.exe')).toBe('C:\\Users\\test\\.debrute\\cli\\current');
  });

  it('adds release payload node_modules before existing NODE_PATH entries', () => {
    expect(packagedExecutablePath('/payload/debrute')).toBe('/payload/debrute');
    expect(packagedNodeModulesPath('/Users/test/.debrute/cli/current/debrute')).toBe('/Users/test/.debrute/cli/current/node_modules');
    expect(packagedNodePathValue('/payload/debrute', '/existing')).toBe(`/payload/node_modules${delimiter}/existing`);
    expect(packagedNodePathValue('/payload/debrute', `/payload/node_modules${delimiter}/existing`)).toBe(`/payload/node_modules${delimiter}/existing`);
  });

  it('resolves bundled skills from the local source checkout layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-cli-source-'));
    const runtimeDir = join(root, 'apps/debrute-cli/src/runtime');
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(join(root, 'skills'), { recursive: true });
    await writeFile(join(root, 'apps/debrute-cli/src/index.ts'), '', 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'debrute', version: '0.7.0' }), 'utf8');

    expect(await resolveCliBundledSkillsRoot(runtimeDir)).toBe(join(root, 'skills'));
  });

  it('resolves source checkout version even when bundled skills are unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-cli-source-version-'));
    const runtimeDir = join(root, 'apps/debrute-cli/src/runtime');
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(root, 'apps/debrute-cli/src/index.ts'), '', 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'debrute', version: '0.8.0' }), 'utf8');

    expect(await resolveCliDebruteVersion(runtimeDir)).toBe('0.8.0');
    expect(await resolveCliBundledSkillsRoot(runtimeDir)).toBeUndefined();
  });

  it('does not guess a Skills root from arbitrary parent directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-cli-arbitrary-'));
    const runtimeDir = join(root, 'a/b/c/d');
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(join(root, 'skills'), { recursive: true });

    expect(await resolveCliBundledSkillsRoot(runtimeDir)).toBeUndefined();
  });

  it('does not treat a bare skills directory as a release payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-cli-bare-skills-'));
    await mkdir(join(root, 'skills'), { recursive: true });

    expect(await resolveCliBundledSkillsRoot(root)).toBeUndefined();
  });

  it('does not resolve versions from arbitrary package metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-cli-arbitrary-package-'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8');

    await expect(resolveCliDebruteVersion(root)).rejects.toThrow(/package metadata/i);
  });
});
