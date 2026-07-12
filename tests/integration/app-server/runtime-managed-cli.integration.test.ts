import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedProductCliService } from '../../../apps/daemon/src/product/ManagedProductCliService';
import { parseProductPayloadManifest } from '../../../apps/daemon/src/product/ProductPayloadManifest';

describe('runtime managed CLI service', { tags: ['runtime'] }, () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await rm(cleanup.pop()!, { recursive: true, force: true });
    }
  });

  it('validates product payload manifests', () => {
    expect(parseProductPayloadManifest({
      schemaVersion: 1,
      productVersion: '0.2.0'
    })).toEqual({
      schemaVersion: 1,
      productVersion: '0.2.0'
    });

    expect(() => parseProductPayloadManifest({
      schemaVersion: 1,
      productVersion: '0.2.0',
      unexpected: 'value'
    })).toThrow(/unsupported fields: unexpected/);

    expect(() => parseProductPayloadManifest({ schemaVersion: 2 })).toThrow(/schemaVersion/);
  });

  it('materializes the current product CLI wrapper and official Skills', async () => {
    const root = await tempDir('debrute-managed-cli-');
    const cliPayload = join(root, 'payload', 'cli');
    const skillsPayload = join(root, 'payload', 'skills');
    const managedBin = join(root, 'home', '.debrute', 'bin');
    const managedProductRoot = join(root, 'home', '.debrute', 'products');
    const manifestPath = join(root, 'payload', 'product-manifest.json');
    const replacementHelperPath = join(root, 'payload', 'product-replacement-helper.cjs');
    await writeFileRecursive(join(cliPayload, 'debrute'), '#!/usr/bin/env node\n', 0o755);
    await writeFileRecursive(join(cliPayload, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    await writeFileRecursive(replacementHelperPath, '#!/usr/bin/env node\n');
    await writeFileRecursive(join(skillsPayload, 'debrute-core', 'SKILL.md'), [
      '---',
      'name: debrute-core',
      'description: Debrute Core',
      'metadata:',
      '  debrute.managed: "true"',
      '  debrute.package: debrute',
      '  debrute.version: "0.2.0"',
      '---',
      '# Debrute Core',
      ''
    ].join('\n'));
    await writeFileRecursive(manifestPath, JSON.stringify({
      schemaVersion: 1,
      productVersion: '0.2.0'
    }));

    const service = new ManagedProductCliService({
      productVersion: '0.2.0',
      cliPayloadDir: cliPayload,
      skillsPayloadDir: skillsPayload,
      managedBinDir: managedBin,
      managedProductRoot,
      productManifestPath: manifestPath,
      webDistDir: '/Applications/Debrute.app/Contents/Resources/app.asar/dist',
      desktopInstallPath: '/Applications/Debrute.app',
      replacementHelperPath,
      userHome: join(root, 'home')
    });

    await expect(service.ensureCurrent()).resolves.toMatchObject({
      status: 'ready',
      version: '0.2.0',
      path: join(managedBin, process.platform === 'win32' ? 'debrute.cmd' : 'debrute'),
      skillsVersion: '0.2.0'
    });
    await expect(readFile(join(managedProductRoot, 'product-manifest.json'), 'utf8').then(JSON.parse)).resolves.toEqual({
      schemaVersion: 1,
      productVersion: '0.2.0'
    });
    await expect(readFile(join(managedProductRoot, 'product-runtime.json'), 'utf8')).resolves.toContain('/Applications/Debrute.app');
    await expect(readFile(join(managedProductRoot, 'product-runtime.json'), 'utf8')).resolves.toContain('/Applications/Debrute.app/Contents/Resources/app.asar/dist');
    await expect(stat(join(managedProductRoot, '0.2.0', 'cli', 'debrute'))).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(readFile(join(root, 'home', '.agents', 'skills', 'debrute-core', 'SKILL.md'), 'utf8')).resolves.toContain('Debrute Core');
  });

  it('does not replace current managed payload directories when they are already the source payload', async () => {
    const root = await tempDir('debrute-managed-cli-current-payload-');
    const managedBin = join(root, 'home', '.debrute', 'bin');
    const managedProductRoot = join(root, 'home', '.debrute', 'products');
    const cliPayload = join(managedProductRoot, '0.2.0', 'cli');
    const skillsPayload = join(managedProductRoot, '0.2.0', 'skills');
    const manifestPath = join(managedProductRoot, 'product-manifest.json');
    const replacementHelperPath = join(managedProductRoot, 'product-replacement-helper.cjs');
    await writeFileRecursive(join(cliPayload, 'debrute'), '#!/usr/bin/env node\n', 0o755);
    await writeFileRecursive(join(skillsPayload, 'debrute-core', 'SKILL.md'), [
      '---',
      'name: debrute-core',
      'description: Debrute Core',
      'metadata:',
      '  debrute.managed: "true"',
      '  debrute.package: debrute',
      '  debrute.version: "0.2.0"',
      '---',
      '# Debrute Core',
      ''
    ].join('\n'));
    await writeFileRecursive(manifestPath, JSON.stringify({
      schemaVersion: 1,
      productVersion: '0.2.0'
    }));
    await writeFileRecursive(replacementHelperPath, '#!/usr/bin/env node\n');
    const beforeCli = await stat(cliPayload);
    const beforeSkills = await stat(skillsPayload);

    const service = new ManagedProductCliService({
      productVersion: '0.2.0',
      cliPayloadDir: cliPayload,
      skillsPayloadDir: skillsPayload,
      managedBinDir: managedBin,
      managedProductRoot,
      productManifestPath: manifestPath,
      webDistDir: '/Applications/Debrute.app/Contents/Resources/app.asar/dist',
      desktopInstallPath: '/Applications/Debrute.app',
      replacementHelperPath,
      userHome: join(root, 'home')
    });

    await expect(service.ensureCurrent()).resolves.toMatchObject({ status: 'ready' });
    await expect(stat(cliPayload)).resolves.toMatchObject({ ino: beforeCli.ino });
    await expect(stat(skillsPayload)).resolves.toMatchObject({ ino: beforeSkills.ino });
  });

  it('reports an error diagnostic when the payload manifest version does not match the product version', async () => {
    const root = await tempDir('debrute-managed-cli-error-');
    const manifestPath = join(root, 'payload', 'product-manifest.json');
    await writeFileRecursive(manifestPath, JSON.stringify({
      schemaVersion: 1,
      productVersion: '0.1.0'
    }));

    const service = new ManagedProductCliService({
      productVersion: '0.2.0',
      cliPayloadDir: join(root, 'payload', 'cli'),
      skillsPayloadDir: join(root, 'payload', 'skills'),
      managedBinDir: join(root, 'home', '.debrute', 'bin'),
      managedProductRoot: join(root, 'home', '.debrute', 'products'),
      productManifestPath: manifestPath,
      webDistDir: '/Applications/Debrute.app/Contents/Resources/app.asar/dist',
      desktopInstallPath: '/Applications/Debrute.app',
      replacementHelperPath: '/Applications/Debrute.app/product-replacement-helper.cjs',
      userHome: join(root, 'home')
    });

    await expect(service.ensureCurrent()).resolves.toMatchObject({
      status: 'error',
      version: '0.2.0',
      message: expect.stringContaining('does not match')
    });
    expect(service.diagnostic()).toMatchObject({ status: 'error', version: '0.2.0' });
  });

  async function tempDir(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    cleanup.push(path);
    return path;
  }
});

async function writeFileRecursive(path: string, content: string, mode?: number): Promise<void> {
  await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(path), { recursive: true }));
  await writeFile(path, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
}
