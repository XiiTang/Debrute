import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGeneratedAssetMetadataService } from '../generated-assets/GeneratedAssetMetadataService.js';
import { buildCanvasVideoPresentation } from './CanvasVideoPresentationService.js';

describe('CanvasVideoPresentationService', () => {
  it('discovers conservative same-basename poster and VTT companions', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-presentation-companions-'));
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video', 'utf8');
      await writeFile(join(projectRoot, 'media/clip.poster.webp'), 'poster', 'utf8');
      await writeFile(join(projectRoot, 'media/clip.en.captions.vtt'), 'WEBVTT\n', 'utf8');
      await writeFile(join(projectRoot, 'media/clip.zh-CN.subtitles.vtt'), 'WEBVTT\n', 'utf8');
      await writeFile(join(projectRoot, 'media/clip.chapters.vtt'), 'WEBVTT\n', 'utf8');
      await writeFile(join(projectRoot, 'media/clip.thumbnails.vtt'), 'WEBVTT\n', 'utf8');
      await writeFile(join(projectRoot, 'media/cover.jpg'), 'not-a-poster', 'utf8');

      const presentation = await buildCanvasVideoPresentation({
        projectRoot,
        projectRelativePath: 'media/clip.mp4',
        durationSeconds: 5,
        generatedAssetLookup: async () => ({ status: 'unmatched', fingerprint: { algorithm: 'sha256', hash: 'none' } }),
        listGeneratedAssetsByModelRun: async () => [],
        findCurrentProjectPathForGeneratedAsset: async () => undefined
      });

      expect(presentation.kind).toBe('video');
      expect(presentation.durationSeconds).toBe(5);
      expect(presentation.poster).toMatchObject({
        projectRelativePath: 'media/clip.poster.webp',
        mimeType: 'image/webp',
        source: 'explicit'
      });
      expect(presentation.textTracks).toEqual([
        expect.objectContaining({ projectRelativePath: 'media/clip.en.captions.vtt', kind: 'captions', srclang: 'en', default: false }),
        expect.objectContaining({ projectRelativePath: 'media/clip.zh-CN.subtitles.vtt', kind: 'subtitles', srclang: 'zh-CN', default: false }),
        expect.objectContaining({ projectRelativePath: 'media/clip.chapters.vtt', kind: 'chapters', default: false }),
        expect.objectContaining({ projectRelativePath: 'media/clip.thumbnails.vtt', kind: 'metadata', label: 'thumbnails', default: false })
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses generated last-frame artifact from the same model run as poster after rename', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-presentation-generated-poster-'));
    try {
      await mkdir(join(projectRoot, 'generated'), { recursive: true });
      await writeFile(join(projectRoot, 'generated/clip.mp4'), 'video-bytes', 'utf8');
      await writeFile(join(projectRoot, 'generated/last-frame.png'), 'frame-bytes', 'utf8');
      const metadata = createGeneratedAssetMetadataService({
        now: () => '2026-06-30T00:00:00.000Z',
        createRecordId: (() => {
          let count = 0;
          return () => `record-${count += 1}`;
        })()
      });
      await metadata.recordGeneratedAsset(projectRoot, {
        modelRunId: 'video-run-1',
        projectRelativePath: 'generated/clip.mp4',
        artifactRole: 'primary-video',
        artifactIndex: 0,
        modelRun: { request: {}, output: {} }
      });
      await metadata.recordGeneratedAsset(projectRoot, {
        modelRunId: 'video-run-1',
        projectRelativePath: 'generated/last-frame.png',
        artifactRole: 'last-frame',
        artifactIndex: 1,
        modelRun: { request: {}, output: {} }
      });
      await rename(join(projectRoot, 'generated/last-frame.png'), join(projectRoot, 'generated/renamed-frame.png'));

      const presentation = await buildCanvasVideoPresentation({
        projectRoot,
        projectRelativePath: 'generated/clip.mp4',
        generatedAssetLookup: (input) => metadata.lookupGeneratedAssetMetadata(projectRoot, input),
        listGeneratedAssetsByModelRun: (input) => metadata.listGeneratedAssetsByModelRun(projectRoot, input),
        findCurrentProjectPathForGeneratedAsset: (input) => metadata.findCurrentProjectPathForGeneratedAsset(projectRoot, input)
      });

      expect(presentation.poster).toMatchObject({
        projectRelativePath: 'generated/renamed-frame.png',
        mimeType: 'image/png',
        source: 'generated-last-frame'
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not read unrelated generated records while finding a last-frame poster', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-presentation-unrelated-bad-record-'));
    try {
      await mkdir(join(projectRoot, 'generated'), { recursive: true });
      await writeFile(join(projectRoot, 'generated/clip.mp4'), 'video-bytes', 'utf8');
      await writeFile(join(projectRoot, 'generated/last-frame.png'), 'frame-bytes', 'utf8');
      const metadata = createGeneratedAssetMetadataService({
        now: () => '2026-06-30T00:00:00.000Z',
        createRecordId: (() => {
          let count = 0;
          return () => `record-${count += 1}`;
        })()
      });
      await metadata.recordGeneratedAsset(projectRoot, {
        modelRunId: 'video-run-1',
        projectRelativePath: 'generated/clip.mp4',
        artifactRole: 'primary-video',
        artifactIndex: 0,
        modelRun: { request: {}, output: {} }
      });
      await metadata.recordGeneratedAsset(projectRoot, {
        modelRunId: 'video-run-1',
        projectRelativePath: 'generated/last-frame.png',
        artifactRole: 'last-frame',
        artifactIndex: 1,
        modelRun: { request: {}, output: {} }
      });
      const indexPath = join(projectRoot, '.debrute/assets/generated-assets-index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
        records: Array<Record<string, unknown>>;
      };
      index.records.push({
        recordId: 'unrelated-bad-record',
        modelRunId: 'image-run-1',
        artifactRole: 'primary-image',
        artifactIndex: 0,
        createdAt: '2026-06-30T00:00:01.000Z',
        fingerprint: {
          algorithm: 'sha256',
          hash: '0000000000000000000000000000000000000000000000000000000000000000'
        },
        metadataPath: '.debrute/assets/generated/unrelated-bad-record.json'
      });
      await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

      const presentation = await buildCanvasVideoPresentation({
        projectRoot,
        projectRelativePath: 'generated/clip.mp4',
        generatedAssetLookup: (input) => metadata.lookupGeneratedAssetMetadata(projectRoot, input),
        listGeneratedAssetsByModelRun: (input) => metadata.listGeneratedAssetsByModelRun(projectRoot, input),
        findCurrentProjectPathForGeneratedAsset: (input) => metadata.findCurrentProjectPathForGeneratedAsset(projectRoot, input)
      });

      expect(presentation.poster).toMatchObject({
        projectRelativePath: 'generated/last-frame.png',
        source: 'generated-last-frame'
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not query generated metadata for unrelated image files while finding generated posters', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-presentation-targeted-poster-'));
    try {
      await mkdir(join(projectRoot, 'generated'), { recursive: true });
      await writeFile(join(projectRoot, 'generated/clip.mp4'), 'video-bytes', 'utf8');
      await writeFile(join(projectRoot, 'generated/a-unrelated.png'), 'unrelated-bytes', 'utf8');
      await writeFile(join(projectRoot, 'generated/last-frame.png'), 'frame-bytes', 'utf8');
      const metadata = createGeneratedAssetMetadataService({
        now: () => '2026-06-30T00:00:00.000Z',
        createRecordId: (() => {
          let count = 0;
          return () => `record-${count += 1}`;
        })()
      });
      await metadata.recordGeneratedAsset(projectRoot, {
        modelRunId: 'video-run-1',
        projectRelativePath: 'generated/clip.mp4',
        artifactRole: 'primary-video',
        artifactIndex: 0,
        modelRun: { request: {}, output: {} }
      });
      await metadata.recordGeneratedAsset(projectRoot, {
        modelRunId: 'video-run-1',
        projectRelativePath: 'generated/last-frame.png',
        artifactRole: 'last-frame',
        artifactIndex: 1,
        modelRun: { request: {}, output: {} }
      });
      const lookupPaths: string[] = [];

      const presentation = await buildCanvasVideoPresentation({
        projectRoot,
        projectRelativePath: 'generated/clip.mp4',
        generatedAssetLookup: async (input) => {
          lookupPaths.push(input.projectRelativePath);
          return metadata.lookupGeneratedAssetMetadata(projectRoot, input);
        },
        listGeneratedAssetsByModelRun: (input) => metadata.listGeneratedAssetsByModelRun(projectRoot, input),
        findCurrentProjectPathForGeneratedAsset: (input) => metadata.findCurrentProjectPathForGeneratedAsset(projectRoot, input)
      });

      expect(presentation.poster).toMatchObject({
        projectRelativePath: 'generated/last-frame.png',
        source: 'generated-last-frame'
      });
      expect(lookupPaths).toEqual(['generated/clip.mp4']);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('surfaces unsafe existing companion paths instead of hiding them as missing optional assets', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-presentation-companion-error-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'debrute-video-presentation-outside-'));
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video', 'utf8');
      await writeFile(join(outsideRoot, 'poster.png'), 'poster', 'utf8');
      await symlink(join(outsideRoot, 'poster.png'), join(projectRoot, 'media/clip.poster.png'));

      await expect(buildCanvasVideoPresentation({
        projectRoot,
        projectRelativePath: 'media/clip.mp4',
        generatedAssetLookup: async () => ({ status: 'unmatched', fingerprint: { algorithm: 'sha256', hash: 'none' } }),
        listGeneratedAssetsByModelRun: async () => [],
        findCurrentProjectPathForGeneratedAsset: async () => undefined
      })).rejects.toThrow('Project path escapes project root through a symlink: media/clip.poster.png');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
