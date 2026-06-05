import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  assertSafeArchiveEntries,
  checksumForAsset,
  extractDebruteCliArchive,
  parseSha256Manifest,
  validateExtractedDebruteCliPayload
} from '../apps/desktop/src/electron/debruteCliArchive';

const execFileAsync = promisify(execFile);

describe('Desktop Debrute CLI archive helpers', () => {
  it('parses SHA256 manifests by asset name', () => {
    const manifest = parseSha256Manifest([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  debrute-cli-0.2.0-macos-arm64.tar.gz',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *debrute-cli-0.2.0-linux-x64.tar.gz'
    ].join('\n'));

    expect(checksumForAsset(manifest, 'debrute-cli-0.2.0-macos-arm64.tar.gz')).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(checksumForAsset(manifest, 'debrute-cli-0.2.0-linux-x64.tar.gz')).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('rejects unsafe archive entries before extraction', () => {
    expect(() => assertSafeArchiveEntries(['debrute', 'skills/debrute-core/SKILL.md'])).not.toThrow();
    expect(() => assertSafeArchiveEntries(['/tmp/debrute'])).toThrow(/unsafe/i);
    expect(() => assertSafeArchiveEntries(['C:/Users/me/debrute'])).toThrow(/unsafe/i);
    expect(() => assertSafeArchiveEntries(['C:\\Users\\me\\debrute'])).toThrow(/unsafe/i);
    expect(() => assertSafeArchiveEntries(['C:debrute'])).toThrow(/unsafe/i);
    expect(() => assertSafeArchiveEntries(['../debrute'])).toThrow(/unsafe/i);
    expect(() => assertSafeArchiveEntries(['skills/../../debrute'])).toThrow(/unsafe/i);
    expect(() => assertSafeArchiveEntries([{ name: 'debrute-link', type: 'symlink' }])).toThrow(/unsafe/i);
    expect(() => assertSafeArchiveEntries([{ name: 'debrute-hardlink', type: 'hardlink' }])).toThrow(/unsafe/i);
  });

  it('rejects tar archives with symlinks before extraction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-tar-link-'));
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    const archive = join(root, 'debrute-cli.tar.gz');
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, 'debrute'), '', 'utf8');
    await symlink('debrute', join(source, 'debrute-link'));
    await execFileAsync('tar', ['-czf', archive, '-C', source, '.']);

    await expect(extractDebruteCliArchive({ archivePath: archive, destinationDir: destination, platform: 'darwin' })).rejects.toThrow(/unsafe/i);
    await expect(pathExists(join(destination, 'debrute-link'))).resolves.toBe(false);
  });

  it('requires expected extracted executable and Skills payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-archive-'));
    await mkdir(join(root, 'skills', 'debrute-core'), { recursive: true });
    await writeFile(join(root, 'debrute'), '', 'utf8');
    await writeFile(join(root, 'skills', 'debrute-core', 'SKILL.md'), '---\nname: debrute-core\n---\n', 'utf8');

    await expect(validateExtractedDebruteCliPayload({ root, executableName: 'debrute' })).resolves.toBeUndefined();
    await expect(validateExtractedDebruteCliPayload({ root, executableName: 'missing-debrute' })).rejects.toThrow(/executable/i);
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
