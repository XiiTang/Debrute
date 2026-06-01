import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  parseFfprobeDimensions,
  readCanvasNodeLayoutSize
} from '../apps/app-server/src/canvas/CanvasNodeDimensionsService';

describe('canvas node dimensions', () => {
  it('uses a fixed Canvas size for directory and unknown-file nodes', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'image-production',
      nodeKind: 'directory',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 2400, height: 960 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'image-production/archive.bin',
      nodeKind: 'file',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 2600, height: 1200 });
  });

  it('uses fixed intrinsic Canvas sizes for text and audio', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'notes/brief.md',
      nodeKind: 'file',
      mediaKind: 'text'
    })).resolves.toEqual({ width: 4200, height: 2800 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'audio/theme.mp3',
      nodeKind: 'file',
      mediaKind: 'audio'
    })).resolves.toEqual({ width: 3200, height: 960 });
  });

  it('reads intrinsic image dimensions with sharp', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-canvas-image-dimensions-'));
    try {
      await mkdir(join(projectRoot, 'generated'), { recursive: true });
      await sharp({
        create: {
          width: 37,
          height: 23,
          channels: 4,
          background: '#336699ff'
        }
      }).png().toFile(join(projectRoot, 'generated/cover.png'));

      await expect(readCanvasNodeLayoutSize({
        projectRoot,
        projectRelativePath: 'generated/cover.png',
        nodeKind: 'file',
        mediaKind: 'image'
      })).resolves.toEqual({ width: 37, height: 23 });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('parses ffprobe video stream dimensions', () => {
    expect(parseFfprobeDimensions(JSON.stringify({
      streams: [
        { codec_type: 'audio' },
        { codec_type: 'video', width: 1920, height: 1080 }
      ]
    }))).toEqual({ width: 1920, height: 1080 });
  });

});
