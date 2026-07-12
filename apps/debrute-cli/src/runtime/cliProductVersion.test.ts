import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveCliDebruteVersion, resolvePkgExecutableEntryDir } from './cliProductVersion.js';

describe('CLI product version resolution', { tags: ['runtime'] }, () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('resolves product version from a managed CLI runtime payload next to the executable', async () => {
    const root = await tempRoot('debrute-cli-runtime-');
    await writeFile(join(root, 'debrute'), '', 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.7.0' }), 'utf8');

    expect(await resolveCliDebruteVersion(root)).toBe('0.7.0');
  });

  it('resolves pkg entry directories from process.execPath', () => {
    expect(resolvePkgExecutableEntryDir('/Users/test/.debrute/products/0.7.0/cli/debrute')).toBe('/Users/test/.debrute/products/0.7.0/cli');
    expect(resolvePkgExecutableEntryDir('C:\\Users\\test\\.debrute\\products\\0.7.0\\cli\\debrute.exe')).toBe('C:\\Users\\test\\.debrute\\products\\0.7.0\\cli');
  });

  it('resolves source checkout version without requiring a Skills directory', async () => {
    const root = await tempRoot('debrute-cli-source-version-');
    const runtimeDir = join(root, 'apps/debrute-cli/src/runtime');
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(root, 'apps/debrute-cli/src/index.ts'), '', 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'debrute', version: '0.8.0' }), 'utf8');

    expect(await resolveCliDebruteVersion(runtimeDir)).toBe('0.8.0');
  });

  it('does not resolve versions from arbitrary package metadata', async () => {
    const root = await tempRoot('debrute-cli-arbitrary-package-');
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8');

    await expect(resolveCliDebruteVersion(root)).rejects.toThrow(/package metadata/i);
  });

  async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
});
