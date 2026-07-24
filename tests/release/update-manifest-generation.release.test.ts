import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateUpdateManifest,
  updateManifestName,
  updateManifestSignatureName
} from '../../scripts/generate-update-manifest.mjs';

describe('update manifest generation', () => {
  const roots: string[] = [];

  afterEach(async () => {
    while (roots.length > 0) {
      await rm(roots.pop()!, { recursive: true, force: true });
    }
  });

  it('writes a signed manifest for supported Desktop and complete Product assets', async () => {
    const root = join(tmpdir(), `debrute-update-manifest-${process.pid}-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeReleaseAssets(root, '0.2.0');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');

    await generateUpdateManifest({
      releaseDir: root,
      version: '0.2.0',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publishedAt: '2026-07-02T00:00:00.000Z'
    });

    const manifestBytes = await readFile(join(root, updateManifestName));
    const signature = Buffer.from(await readFile(join(root, updateManifestSignatureName), 'utf8'), 'base64');
    expect(verify(null, manifestBytes, publicKey, signature)).toBe(true);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    expect(manifest.product).toBe('debrute');
    expect(manifest.assets).toHaveLength(6);
    expect(manifest.assets[0]).toMatchObject({
      kind: 'desktop',
      name: 'debrute-desktop-0.2.0-macos-arm64.dmg',
      sha256: createHash('sha256').update('macos arm64').digest('hex'),
      sizeBytes: Buffer.byteLength('macos arm64')
    });
    expect(manifest.assets).toContainEqual(expect.objectContaining({
      kind: 'product',
      name: 'debrute-product-0.2.0-windows-x64.zip'
    }));
  });

  it('fails when a required desktop asset is missing', async () => {
    const root = join(tmpdir(), `debrute-update-manifest-missing-${process.pid}-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const { privateKey } = generateKeyPairSync('ed25519');

    await expect(generateUpdateManifest({
      releaseDir: root,
      version: '0.2.0',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    })).rejects.toThrow(/Missing release assets/);
  });

  it('fails when release upload contains files outside the signed update contract', async () => {
    const root = join(tmpdir(), `debrute-update-manifest-extra-${process.pid}-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeReleaseAssets(root, '0.2.0');
    await writeFile(join(root, 'unexpected-release-note.txt'), 'out-of-contract file');
    const { privateKey } = generateKeyPairSync('ed25519');

    await expect(generateUpdateManifest({
      releaseDir: root,
      version: '0.2.0',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    })).rejects.toThrow(/Unexpected release assets/);
  });

  it('rejects unsupported generator options instead of signing out-of-contract URLs', async () => {
    const root = join(tmpdir(), `debrute-update-manifest-repository-${process.pid}-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeReleaseAssets(root, '0.2.0');
    const { privateKey } = generateKeyPairSync('ed25519');

    await expect(generateUpdateManifest({
      releaseDir: root,
      version: '0.2.0',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      repository: 'example.test/debrute'
    })).rejects.toThrow(/Unsupported update manifest generator options: repository/);
  });
});

async function writeReleaseAssets(root: string, version: string): Promise<void> {
  await Promise.all([
    writeFile(join(root, `debrute-desktop-${version}-macos-arm64.dmg`), 'macos arm64'),
    writeFile(join(root, `debrute-desktop-${version}-macos-x64.dmg`), 'macos x64'),
    writeFile(join(root, `debrute-desktop-${version}-windows-x64.exe`), 'windows x64'),
    writeFile(join(root, `debrute-product-${version}-macos-arm64.zip`), 'macos arm64 product'),
    writeFile(join(root, `debrute-product-${version}-macos-x64.zip`), 'macos x64 product'),
    writeFile(join(root, `debrute-product-${version}-windows-x64.zip`), 'windows x64 product')
  ]);
}
