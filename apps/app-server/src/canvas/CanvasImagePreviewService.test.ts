import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  canvasImageSourceRevision,
  canvasImagePreviewSourceInfo,
  createCanvasImagePreviewService
} from './CanvasImagePreviewService';

const gzipBuffer = promisify(gzip);

describe('CanvasImagePreviewService image format support', () => {
  it('marks all supported project image formats previewable when sharp can read metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-formats-'));
    try {
      await writeSupportedPreviewFixtures(projectRoot);

      for (const [path, width] of [
        ['assets/cover.png', 64],
        ['assets/photo.jpe', 65],
        ['assets/photo.jfif', 65],
        ['assets/render.webp', 66],
        ['assets/render.avif', 67],
        ['assets/scan.tif', 68],
        ['assets/scan.tiff', 68],
        ['assets/icon.svg', 69],
        ['assets/icon.svgz', 69]
      ] as const) {
        await expect(canvasImagePreviewSourceInfo(projectRoot, path)).resolves.toEqual({
          previewable: true,
          sourceWidth: width
        });
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported image-like formats before reading preview metadata', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-excluded-'));
    try {
      await mkdir(join(projectRoot, 'assets'), { recursive: true });
      await writeFile(join(projectRoot, 'assets/animated.gif'), Buffer.from('GIF89a'));
      await writeFile(join(projectRoot, 'assets/internal.vips'), Buffer.from('vips'));

      await expect(canvasImagePreviewSourceInfo(projectRoot, 'assets/animated.gif')).resolves.toEqual({
        previewable: false
      });
      await expect(canvasImagePreviewSourceInfo(projectRoot, 'assets/internal.vips')).resolves.toEqual({
        previewable: false
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('resolves a preview for a newly supported AVIF source', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-canvas-preview-avif-'));
    try {
      await mkdir(join(projectRoot, 'assets'), { recursive: true });
      await writeFile(join(projectRoot, 'assets/render.avif'), await rasterFixture(80, 48).avif().toBuffer());
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'assets/render.avif');
      const result = await service.resolve({
        projectRoot,
        projectRelativePath: 'assets/render.avif',
        revision,
        width: 40
      });

      const metadata = await sharp(result.absolutePath).metadata();
      expect(metadata.width).toBe(40);
      expect(['jpeg', 'png']).toContain(metadata.format);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

async function writeSupportedPreviewFixtures(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, 'assets'), { recursive: true });
  await writeFile(join(projectRoot, 'assets/cover.png'), await rasterFixture(64, 40).png().toBuffer());
  await writeFile(join(projectRoot, 'assets/photo.jpe'), await rasterFixture(65, 40).jpeg().toBuffer());
  await writeFile(join(projectRoot, 'assets/photo.jfif'), await rasterFixture(65, 40).jpeg().toBuffer());
  await writeFile(join(projectRoot, 'assets/render.webp'), await rasterFixture(66, 40).webp().toBuffer());
  await writeFile(join(projectRoot, 'assets/render.avif'), await rasterFixture(67, 40).avif().toBuffer());
  await writeFile(join(projectRoot, 'assets/scan.tif'), await rasterFixture(68, 40).tiff().toBuffer());
  await writeFile(join(projectRoot, 'assets/scan.tiff'), await rasterFixture(68, 40).tiff().toBuffer());
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="69" height="40"><rect width="69" height="40" fill="#336699"/></svg>';
  await writeFile(join(projectRoot, 'assets/icon.svg'), svg, 'utf8');
  await writeFile(join(projectRoot, 'assets/icon.svgz'), await gzipBuffer(Buffer.from(svg)));
}

function rasterFixture(width: number, height: number): sharp.Sharp {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 51, g: 102, b: 153, alpha: 1 }
    }
  });
}
