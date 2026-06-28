import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  resolveCliDebruteVersion,
  resolvePkgExecutableEntryDir
} from '../apps/debrute-cli/src/runtime/cliProductVersion';
import { packagedExecutablePath, packagedNodeModulesPath, packagedNodePathValue } from '../apps/debrute-cli/src/runtime/packagedNodeModules';

describe('Debrute CLI runtime paths', () => {
  it('resolves product version from a managed CLI runtime payload next to the executable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-cli-runtime-'));
    await writeFile(join(root, 'debrute'), '', 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.7.0' }), 'utf8');

    expect(await resolveCliDebruteVersion(root)).toBe('0.7.0');
  });

  it('resolves pkg entry directories from process.execPath', () => {
    expect(resolvePkgExecutableEntryDir('/Users/test/.debrute/products/0.7.0/cli/debrute')).toBe('/Users/test/.debrute/products/0.7.0/cli');
    expect(resolvePkgExecutableEntryDir('C:\\Users\\test\\.debrute\\products\\0.7.0\\cli\\debrute.exe')).toBe('C:\\Users\\test\\.debrute\\products\\0.7.0\\cli');
  });

  it('adds runtime payload node_modules before existing NODE_PATH entries', () => {
    expect(packagedExecutablePath('/payload/debrute')).toBe('/payload/debrute');
    expect(packagedNodeModulesPath('/Users/test/.debrute/products/0.7.0/cli/debrute')).toBe('/Users/test/.debrute/products/0.7.0/cli/node_modules');
    expect(packagedNodePathValue('/payload/debrute', '/existing')).toBe(`/payload/node_modules${delimiter}/existing`);
    expect(packagedNodePathValue('/payload/debrute', `/payload/node_modules${delimiter}/existing`)).toBe(`/payload/node_modules${delimiter}/existing`);
  });

  it('resolves source checkout version without requiring a Skills directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-cli-source-version-'));
    const runtimeDir = join(root, 'apps/debrute-cli/src/runtime');
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(root, 'apps/debrute-cli/src/index.ts'), '', 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'debrute', version: '0.8.0' }), 'utf8');

    expect(await resolveCliDebruteVersion(runtimeDir)).toBe('0.8.0');
  });

  it('does not resolve versions from arbitrary package metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-cli-arbitrary-package-'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8');

    await expect(resolveCliDebruteVersion(root)).rejects.toThrow(/package metadata/i);
  });
});
