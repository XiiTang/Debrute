import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  importAdobeBridgePngTransfer,
  isSupportedAdobeBridgeProjectImageFile,
  nextAdobeBridgeTransferFileName,
  sanitizeAdobeBridgePngBasename
} from '@debrute/project-core';

describe('Adobe Bridge project file transfer', () => {
  it('supports only Debrute-to-Photoshop image source formats', () => {
    expect(isSupportedAdobeBridgeProjectImageFile('assets/cover.png')).toBe(true);
    expect(isSupportedAdobeBridgeProjectImageFile('assets/photo.jpeg')).toBe(true);
    expect(isSupportedAdobeBridgeProjectImageFile('assets/photo.jpg')).toBe(true);
    expect(isSupportedAdobeBridgeProjectImageFile('assets/ref.webp')).toBe(true);
    expect(isSupportedAdobeBridgeProjectImageFile('assets/edit.psd')).toBe(true);
    expect(isSupportedAdobeBridgeProjectImageFile('assets/brief.md')).toBe(false);
    expect(isSupportedAdobeBridgeProjectImageFile('.debrute/cache/cover.png')).toBe(false);
    expect(isSupportedAdobeBridgeProjectImageFile('.DeBrute/cache/cover.png')).toBe(false);
    expect(isSupportedAdobeBridgeProjectImageFile('.GIT/objects/cover.png')).toBe(false);
  });

  it('sanitizes Photoshop layer names without copy suffixes', () => {
    expect(sanitizeAdobeBridgePngBasename('Hero / Title?.psd')).toBe('Hero Title');
    expect(sanitizeAdobeBridgePngBasename('   ...   ')).toBe('Photoshop Layer');
    expect(nextAdobeBridgeTransferFileName(new Set(['Hero.png']), 'Hero')).toBe('Hero 2.png');
    expect(nextAdobeBridgeTransferFileName(new Set(['Hero.png', 'Hero 2.png']), 'Hero')).toBe('Hero 3.png');
  });

  it('writes PNG transfers into a visible target directory using numeric conflicts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-adobe-transfer-'));
    try {
      await mkdir(join(projectRoot, 'assets'), { recursive: true });
      await writeFile(join(projectRoot, 'assets/Hero.png'), 'existing', 'utf8');

      const result = await importAdobeBridgePngTransfer(projectRoot, {
        targetDirectoryProjectRelativePath: 'assets',
        suggestedName: 'Hero',
        content: new Uint8Array([137, 80, 78, 71]),
        byteLength: 4,
        mimeType: 'image/png'
      });

      expect(result).toEqual({
        projectRelativePath: 'assets/Hero 2.png',
        kind: 'file'
      });
      await expect(readFile(join(projectRoot, 'assets/Hero 2.png'))).resolves.toEqual(Buffer.from([137, 80, 78, 71]));
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects internal target directories', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-adobe-transfer-internal-'));
    try {
      await mkdir(join(projectRoot, '.debrute'), { recursive: true });
      await expect(importAdobeBridgePngTransfer(projectRoot, {
        targetDirectoryProjectRelativePath: '.debrute',
        suggestedName: 'Layer',
        content: new Uint8Array([1]),
        byteLength: 1,
        mimeType: 'image/png'
      })).rejects.toThrow('not visible');
      await expect(importAdobeBridgePngTransfer(projectRoot, {
        targetDirectoryProjectRelativePath: '.DeBrute',
        suggestedName: 'Layer',
        content: new Uint8Array([1]),
        byteLength: 1,
        mimeType: 'image/png'
      })).rejects.toThrow('not visible');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
