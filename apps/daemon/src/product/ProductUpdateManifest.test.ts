import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseTrustedProductUpdateManifest,
  productUpdateReleaseFromManifest
} from './ProductUpdateManifest.js';

describe('product update manifest trust boundary', () => {
  it('verifies a signed manifest before mapping update assets', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const manifestBytes = manifestBytesFixture({
      sha256: createHash('sha256').update('asset-bytes').digest('hex'),
      sizeBytes: 11
    });
    const signatureText = sign(null, manifestBytes, privateKey).toString('base64');

    const manifest = parseTrustedProductUpdateManifest({
      manifestBytes,
      signatureText,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    });

    expect(productUpdateReleaseFromManifest(manifest)).toMatchObject({
      version: '0.3.0',
      name: 'Debrute 0.3.0',
      date: '2026-07-02T00:00:00.000Z',
      assets: [{
        platform: 'darwin',
        arch: 'arm64',
        name: 'debrute-desktop-0.3.0-macos-arm64.dmg',
        url: 'https://github.com/xiitang/debrute/releases/download/v0.3.0/debrute-desktop-0.3.0-macos-arm64.dmg',
        sha256: createHash('sha256').update('asset-bytes').digest('hex'),
        sizeBytes: 11
      }]
    });
  });

  it('rejects an invalid signature', () => {
    const { publicKey } = generateKeyPairSync('ed25519');

    expect(() => parseTrustedProductUpdateManifest({
      manifestBytes: manifestBytesFixture(),
      signatureText: Buffer.alloc(64).toString('base64'),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    })).toThrow(/signature/i);
  });

  it('rejects an asset URL outside the Debrute release contract', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const manifestBytes = manifestBytesFixture({
      url: 'https://example.test/debrute-desktop-0.3.0-macos-arm64.dmg'
    });
    const signatureText = sign(null, manifestBytes, privateKey).toString('base64');

    expect(() => parseTrustedProductUpdateManifest({
      manifestBytes,
      signatureText,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    })).toThrow(/asset URL/i);
  });

  it('rejects platform and architecture pairs outside the release contract', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const manifestBytes = manifestBytesFixture({
      platform: 'linux',
      arch: 'arm64',
      extension: 'AppImage'
    });
    const signatureText = sign(null, manifestBytes, privateKey).toString('base64');

    expect(() => parseTrustedProductUpdateManifest({
      manifestBytes,
      signatureText,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    })).toThrow(/release target/i);
  });

  it('rejects unsupported top-level manifest fields', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const manifestBytes = manifestBytesFixture({
      topLevelExtra: { minimumRuntimeVersion: '0.3.0' }
    });
    const signatureText = sign(null, manifestBytes, privateKey).toString('base64');

    expect(() => parseTrustedProductUpdateManifest({
      manifestBytes,
      signatureText,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    })).toThrow(/unsupported fields/i);
  });

  it('rejects unsupported asset manifest fields', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const manifestBytes = manifestBytesFixture({
      assetExtra: { unexpectedDownloadUrl: 'https://example.test/asset' }
    });
    const signatureText = sign(null, manifestBytes, privateKey).toString('base64');

    expect(() => parseTrustedProductUpdateManifest({
      manifestBytes,
      signatureText,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    })).toThrow(/unsupported fields/i);
  });

  it('rejects duplicate assets for the same platform and architecture', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const manifestBytes = manifestBytesFixture({
      duplicateAsset: true
    });
    const signatureText = sign(null, manifestBytes, privateKey).toString('base64');

    expect(() => parseTrustedProductUpdateManifest({
      manifestBytes,
      signatureText,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    })).toThrow(/duplicate.*platform.*architecture/i);
  });

  it('rejects date-only publishedAt values', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const manifestBytes = manifestBytesFixture({
      publishedAt: '2026-07-02'
    });
    const signatureText = sign(null, manifestBytes, privateKey).toString('base64');

    expect(() => parseTrustedProductUpdateManifest({
      manifestBytes,
      signatureText,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
    })).toThrow(/publishedAt/i);
  });
});

function manifestBytesFixture(overrides: Partial<{
  platform: 'macos' | 'windows' | 'linux';
  arch: 'arm64' | 'x64';
  extension: 'dmg' | 'exe' | 'AppImage';
  url: string;
  sha256: string;
  sizeBytes: number;
  publishedAt: string;
  topLevelExtra: Record<string, unknown>;
  assetExtra: Record<string, unknown>;
  duplicateAsset: boolean;
}> = {}): Buffer {
  const version = '0.3.0';
  const platform = overrides.platform ?? 'macos';
  const arch = overrides.arch ?? 'arm64';
  const extension = overrides.extension ?? 'dmg';
  const name = `debrute-desktop-${version}-${platform}-${arch}.${extension}`;
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    product: 'debrute-desktop',
    version,
    releaseTag: `v${version}`,
    publishedAt: overrides.publishedAt ?? '2026-07-02T00:00:00.000Z',
    assets: [
      {
        platform,
        arch,
        name,
        url: overrides.url ?? `https://github.com/xiitang/debrute/releases/download/v${version}/${name}`,
        sha256: overrides.sha256 ?? 'a'.repeat(64),
        sizeBytes: overrides.sizeBytes ?? 1,
        ...overrides.assetExtra
      },
      ...(overrides.duplicateAsset ? [{
        platform,
        arch,
        name,
        url: overrides.url ?? `https://github.com/xiitang/debrute/releases/download/v${version}/${name}`,
        sha256: 'b'.repeat(64),
        sizeBytes: 2
      }] : [])
    ],
    ...overrides.topLevelExtra
  }, null, 2)}\n`, 'utf8');
}
