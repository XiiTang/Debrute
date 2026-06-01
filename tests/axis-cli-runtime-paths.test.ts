import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  resolveCliAxisVersion,
  resolveCliBundledSkillsRoot,
  resolvePkgExecutableEntryDir
} from '../apps/axis-cli/src/runtime/createCliSkillsRuntime';

describe('Axis CLI runtime paths', () => {
  it('resolves bundled skills and package metadata from a release payload next to the executable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'axis-cli-release-'));
    await mkdir(join(root, 'skills'), { recursive: true });
    await writeFile(join(root, 'axis'), '', 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.7.0' }), 'utf8');

    expect(await resolveCliBundledSkillsRoot(root)).toBe(join(root, 'skills'));
    expect(await resolveCliAxisVersion(root)).toBe('0.7.0');
  });

  it('resolves pkg entry directories from process.execPath', () => {
    expect(resolvePkgExecutableEntryDir('/Users/test/.axis/cli/current/axis')).toBe('/Users/test/.axis/cli/current');
    expect(resolvePkgExecutableEntryDir('C:\\Users\\test\\.axis\\cli\\current\\axis.exe')).toBe('C:\\Users\\test\\.axis\\cli\\current');
  });

  it('resolves bundled skills from the local source checkout layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'axis-cli-source-'));
    const runtimeDir = join(root, 'apps/axis-cli/src/runtime');
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(join(root, 'skills'), { recursive: true });
    await writeFile(join(root, 'apps/axis-cli/src/index.ts'), '', 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'axis', version: '0.7.0' }), 'utf8');

    expect(await resolveCliBundledSkillsRoot(runtimeDir)).toBe(join(root, 'skills'));
  });

  it('resolves source checkout version even when bundled skills are unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'axis-cli-source-version-'));
    const runtimeDir = join(root, 'apps/axis-cli/src/runtime');
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(root, 'apps/axis-cli/src/index.ts'), '', 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'axis', version: '0.8.0' }), 'utf8');

    expect(await resolveCliAxisVersion(runtimeDir)).toBe('0.8.0');
    expect(await resolveCliBundledSkillsRoot(runtimeDir)).toBeUndefined();
  });

  it('does not guess a Skills root from arbitrary parent directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'axis-cli-arbitrary-'));
    const runtimeDir = join(root, 'a/b/c/d');
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(join(root, 'skills'), { recursive: true });

    expect(await resolveCliBundledSkillsRoot(runtimeDir)).toBeUndefined();
  });

  it('does not treat a bare skills directory as a release payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'axis-cli-bare-skills-'));
    await mkdir(join(root, 'skills'), { recursive: true });

    expect(await resolveCliBundledSkillsRoot(root)).toBeUndefined();
  });

  it('does not resolve versions from arbitrary package metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'axis-cli-arbitrary-package-'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8');

    await expect(resolveCliAxisVersion(root)).rejects.toThrow(/package metadata/i);
  });
});
