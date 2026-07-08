import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  projectFileRevision,
  projectRelativePathCacheKey,
  projectRevisionCacheKey
} from '@debrute/project-core';
import { reconcileCanvasImagePreviewCache } from './CanvasImagePreviewCacheCleanup';

describe('Canvas image preview cache cleanup', () => {
  it('removes cache directories for missing sources', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-preview-cleanup-missing-'));
    try {
      const staleSourceKey = projectRelativePathCacheKey('images/missing.png');
      await mkdir(join(projectRoot, '.debrute/cache/canvas-image-previews', staleSourceKey, '1000%3A10'), { recursive: true });
      await writeFile(join(projectRoot, '.debrute/cache/canvas-image-previews', staleSourceKey, '1000%3A10', 'preview-w100.jpg'), 'stale');

      await reconcileCanvasImagePreviewCache({ projectRoot, files: [] });

      await expect(stat(join(projectRoot, '.debrute/cache/canvas-image-previews', staleSourceKey)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps only the current revision directory for previewable images', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-preview-cleanup-revision-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      const sourcePath = join(projectRoot, 'images/cover.png');
      await sharp({
        create: {
          width: 64,
          height: 32,
          channels: 3,
          background: '#223344'
        }
      }).png().toFile(sourcePath);
      const sourceStat = await stat(sourcePath);
      const currentRevisionKey = projectRevisionCacheKey(projectFileRevision(sourceStat.size, sourceStat.mtimeMs));
      const sourceKey = projectRelativePathCacheKey('images/cover.png');
      const sourceCacheRoot = join(projectRoot, '.debrute/cache/canvas-image-previews', sourceKey);
      await mkdir(join(sourceCacheRoot, currentRevisionKey), { recursive: true });
      await writeFile(join(sourceCacheRoot, currentRevisionKey, 'preview-w32.jpg'), 'current');
      await mkdir(join(sourceCacheRoot, 'old%3A10'), { recursive: true });
      await writeFile(join(sourceCacheRoot, 'old%3A10', 'preview-w32.jpg'), 'old');

      await reconcileCanvasImagePreviewCache({
        projectRoot,
        files: [{ projectRelativePath: 'images/cover.png', kind: 'file' }]
      });

      await expect(readdir(sourceCacheRoot)).resolves.toEqual([currentRevisionKey]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes cache directories for non-previewable project files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-preview-cleanup-non-preview-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/animated.gif'), 'GIF89a');
      const sourceKey = projectRelativePathCacheKey('images/animated.gif');
      await mkdir(join(projectRoot, '.debrute/cache/canvas-image-previews', sourceKey, '1000%3A10'), { recursive: true });

      await reconcileCanvasImagePreviewCache({
        projectRoot,
        files: [{ projectRelativePath: 'images/animated.gif', kind: 'file' }]
      });

      await expect(stat(join(projectRoot, '.debrute/cache/canvas-image-previews', sourceKey)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes cache directories when an image path is no longer metadata-previewable', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-preview-cleanup-unreadable-image-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      const sourcePath = join(projectRoot, 'images/cover.png');
      await sharp({
        create: {
          width: 64,
          height: 32,
          channels: 3,
          background: '#223344'
        }
      }).png().toFile(sourcePath);
      const sourceStat = await stat(sourcePath);
      const currentRevisionKey = projectRevisionCacheKey(projectFileRevision(sourceStat.size, sourceStat.mtimeMs));
      const sourceKey = projectRelativePathCacheKey('images/cover.png');
      const sourceCacheRoot = join(projectRoot, '.debrute/cache/canvas-image-previews', sourceKey);
      await mkdir(join(sourceCacheRoot, currentRevisionKey), { recursive: true });
      await writeFile(join(sourceCacheRoot, currentRevisionKey, 'preview-w32.jpg'), 'current');
      await writeFile(sourcePath, 'not a png');

      await reconcileCanvasImagePreviewCache({
        projectRoot,
        files: [{ projectRelativePath: 'images/cover.png', kind: 'file' }]
      });

      await expect(stat(sourceCacheRoot))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes cache directories when source path and decoded media type differ', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-preview-cleanup-media-type-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      const sourcePath = join(projectRoot, 'images/cover.png');
      await sharp({
        create: {
          width: 64,
          height: 32,
          channels: 3,
          background: '#223344'
        }
      }).jpeg().toFile(sourcePath);
      const sourceStat = await stat(sourcePath);
      const currentRevisionKey = projectRevisionCacheKey(projectFileRevision(sourceStat.size, sourceStat.mtimeMs));
      const sourceKey = projectRelativePathCacheKey('images/cover.png');
      const sourceCacheRoot = join(projectRoot, '.debrute/cache/canvas-image-previews', sourceKey);
      await mkdir(join(sourceCacheRoot, currentRevisionKey), { recursive: true });
      await writeFile(join(sourceCacheRoot, currentRevisionKey, 'preview-w32.jpg'), 'current');

      await reconcileCanvasImagePreviewCache({
        projectRoot,
        files: [{ projectRelativePath: 'images/cover.png', kind: 'file' }]
      });

      await expect(stat(sourceCacheRoot))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
