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
  it('keeps short directory and unknown-file nodes at their minimum generic Canvas sizes', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'image-production',
      nodeKind: 'directory',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 1500, height: 960 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'image-production/archive.bin',
      nodeKind: 'file',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 1500, height: 1200 });
  });

  it('expands directory and unknown-file Canvas widths from long display names', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'references/long-folder-name-for-rendering-output-archive',
      nodeKind: 'directory',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 3600, height: 960 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'references/unsupported-reference-render-settings.archive',
      nodeKind: 'file',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 3600, height: 1200 });
  });

  it('caps generic Canvas widths for very long directory and unknown-file names', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'outputs/this-is-an-extremely-long-folder-name-that-should-hit-the-generic-node-width-cap',
      nodeKind: 'directory',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 4800, height: 960 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'outputs/this-is-an-extremely-long-unsupported-file-name-that-should-hit-the-generic-node-width-cap.bin',
      nodeKind: 'file',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 4800, height: 1200 });
  });

  it('counts full-width display name characters wider than Latin characters', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: process.cwd(),
      projectRelativePath: 'references/中文资料归档文件夹名称很长',
      nodeKind: 'directory',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 2080, height: 960 });
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
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-image-dimensions-'));
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
