import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  createCanvasRasterPreviewService,
  readCanvasRasterPreviewMetadata
} from './CanvasRasterPreviewService';

describe('CanvasRasterPreviewService', () => {
  it('writes a resized PNG preview without enlarging the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-raster-preview-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    await sharp({
      create: {
        width: 100,
        height: 50,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0.5 }
      }
    }).png().toFile(join(root, 'assets/source.png'));

    const service = createCanvasRasterPreviewService({ generationConcurrency: 4, metadataConcurrency: 4 });
    const result = await service.generate({
      sourceAbsolutePath: join(root, 'assets/source.png'),
      outputAbsolutePath: join(root, '.debrute/cache/test.preview-w40.png'),
      width: 40
    });

    expect(result.absolutePath).toBe(join(root, '.debrute/cache/test.preview-w40.png'));
    const output = await sharp(result.absolutePath).toBuffer({ resolveWithObject: true });
    expect(output.info.width).toBe(40);
    expect(output.info.height).toBe(20);
    expect(output.info.hasAlpha).toBe(true);
  });

  it('writes a resized JPEG preview for opaque sources and reports output without alpha', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-raster-preview-opaque-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    await sharp({
      create: {
        width: 100,
        height: 50,
        channels: 3,
        background: { r: 255, g: 0, b: 0 }
      }
    }).jpeg().toFile(join(root, 'assets/source.jpg'));

    const service = createCanvasRasterPreviewService({ generationConcurrency: 4, metadataConcurrency: 4 });
    const result = await service.generate({
      sourceAbsolutePath: join(root, 'assets/source.jpg'),
      outputAbsolutePath: join(root, '.debrute/cache/test.preview-w40.jpg'),
      width: 40
    });

    expect(result.absolutePath).toBe(join(root, '.debrute/cache/test.preview-w40.jpg'));
    const output = await sharp(result.absolutePath).toBuffer({ resolveWithObject: true });
    expect(output.info.width).toBe(40);
    expect(output.info.height).toBe(20);
    expect(output.info.hasAlpha).toBe(false);
  });

  it('reads source metadata through the shared metadata helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-raster-metadata-'));
    const source = join(root, 'source.jpg');
    await sharp({
      create: {
        width: 80,
        height: 60,
        channels: 3,
        background: { r: 20, g: 30, b: 40 }
      }
    }).jpeg().toFile(source);

    await expect(readCanvasRasterPreviewMetadata(source, 'source.jpg')).resolves.toMatchObject({
      width: 80,
      height: 60
    });
  });

  it('rejects widths larger than the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-raster-width-'));
    const source = join(root, 'source.png');
    await sharp({
      create: {
        width: 50,
        height: 30,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      }
    }).png().toFile(source);

    const service = createCanvasRasterPreviewService({ generationConcurrency: 4, metadataConcurrency: 4 });
    await expect(service.generate({
      sourceAbsolutePath: source,
      outputAbsolutePath: join(root, 'preview.png'),
      width: 80
    })).rejects.toThrow('Canvas raster preview width exceeds source width.');
  });

  it('leaves only the final file after atomic write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-raster-atomic-'));
    const source = join(root, 'source.png');
    const output = join(root, 'cache/preview.png');
    await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 1 }
      }
    }).png().toFile(source);

    const service = createCanvasRasterPreviewService({ generationConcurrency: 4, metadataConcurrency: 4 });
    await service.generate({ sourceAbsolutePath: source, outputAbsolutePath: output, width: 32 });

    await expect(stat(output)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(readFile(output)).resolves.toBeInstanceOf(Buffer);
  });
});
