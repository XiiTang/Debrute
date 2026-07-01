import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCanvasVideoPresentation } from './CanvasVideoPresentationService.js';

describe('CanvasVideoPresentationService', () => {
  it('builds playback metadata and VTT companions without poster data', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-presentation-tracks-'));
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
        durationSeconds: 5
      });

      expect(presentation).not.toHaveProperty('poster');
      expect(presentation.kind).toBe('video');
      expect(presentation.durationSeconds).toBe(5);
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

  it('surfaces unsafe existing VTT companion paths', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-video-presentation-track-error-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'debrute-video-presentation-outside-'));
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeFile(join(projectRoot, 'media/clip.mp4'), 'video', 'utf8');
      await writeFile(join(outsideRoot, 'clip.en.captions.vtt'), 'WEBVTT\n', 'utf8');
      await symlink(join(outsideRoot, 'clip.en.captions.vtt'), join(projectRoot, 'media/clip.en.captions.vtt'));

      await expect(buildCanvasVideoPresentation({
        projectRoot,
        projectRelativePath: 'media/clip.mp4'
      })).rejects.toThrow('Project path escapes project root through a symlink: media/clip.en.captions.vtt');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
