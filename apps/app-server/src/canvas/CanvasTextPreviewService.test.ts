import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  canvasTextPreviewSourceProjectPath,
  canvasTextPreviewVariantProjectPath
} from '@debrute/canvas-core';
import {
  createCanvasTextPreviewService
} from './CanvasTextPreviewService';
import { readCanvasRasterPreviewMetadata } from './CanvasRasterPreviewService';

describe('CanvasTextPreviewService', () => {
  it('saves source.png as the only initial source artifact', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-preview-source-'));
    const sourceUpload = await writeFixturePng(projectRoot, 'upload.png', 1200, 640);
    const service = createCanvasTextPreviewService();

    await expect(service.saveSource({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a',
      sourceTemporaryPath: sourceUpload
    })).resolves.toEqual({
      ok: true,
      source: {
        projectRelativePath: 'notes/scene.md',
        fingerprint: 'fingerprint-a',
        available: true
      }
    });

    const sourcePath = join(projectRoot, canvasTextPreviewSourceProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a'
    }));
    await expect(pathExists(sourcePath)).resolves.toBe(true);
    await expect(readdir(dirname(sourcePath))).resolves.toEqual(['source.png']);
  });

  it('reads source availability by source key', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-preview-availability-'));
    const sourceUpload = await writeFixturePng(projectRoot, 'upload.png', 320, 160);
    const service = createCanvasTextPreviewService();
    await service.saveSource({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a',
      sourceTemporaryPath: sourceUpload
    });

    await expect(service.readSources({
      projectRoot,
      canvasId: 'canvas-1',
      sources: [
        { projectRelativePath: 'notes/scene.md', fingerprint: 'fingerprint-a' },
        { projectRelativePath: 'notes/missing.md', fingerprint: 'fingerprint-missing' }
      ]
    })).resolves.toEqual({
      sources: {
        'notes/scene.md': {
          projectRelativePath: 'notes/scene.md',
          fingerprint: 'fingerprint-a',
          available: true
        },
        'notes/missing.md': {
          projectRelativePath: 'notes/missing.md',
          fingerprint: 'fingerprint-missing',
          available: false
        }
      }
    });
  });

  it('generates a requested variant from source.png when missing', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-preview-variant-'));
    const sourceUpload = await writeFixturePng(projectRoot, 'upload.png', 320, 160);
    const service = createCanvasTextPreviewService();
    await service.saveSource({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a',
      sourceTemporaryPath: sourceUpload
    });

    const result = await service.resolveVariant({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a',
      width: 80
    });

    expect(result.absolutePath).toContain('preview-w80.png');
    await expect(readCanvasRasterPreviewMetadata(result.absolutePath, 'notes/scene.md'))
      .resolves.toMatchObject({ width: 80 });
  });

  it('deduplicates concurrent variant generation for the same source key and width', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-preview-dedupe-'));
    const sourceUpload = await writeFixturePng(projectRoot, 'upload.png', 320, 160);
    const service = createCanvasTextPreviewService();
    await service.saveSource({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a',
      sourceTemporaryPath: sourceUpload
    });

    const input = {
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a',
      width: 80
    };

    const [first, second] = await Promise.all([
      service.resolveVariant(input),
      service.resolveVariant(input)
    ]);

    expect(first).toBe(second);
    expect(first.absolutePath).toContain('preview-w80.png');
    await expect(readCanvasRasterPreviewMetadata(first.absolutePath, 'notes/scene.md'))
      .resolves.toMatchObject({ width: 80 });
  });

  it('fails variant resolution when source.png is missing', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-preview-missing-'));
    const service = createCanvasTextPreviewService();

    await expect(service.resolveVariant({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/missing.md',
      fingerprint: 'fingerprint-missing',
      width: 80
    })).rejects.toThrow('Canvas text preview source is not available: notes/missing.md');
  });

  it('keeps variant files isolated by fingerprint', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-text-preview-isolated-'));
    const firstSource = await writeFixturePng(projectRoot, 'first.png', 64, 32, { r: 255, g: 0, b: 0, alpha: 1 });
    const secondSource = await writeFixturePng(projectRoot, 'second.png', 64, 32, { r: 0, g: 0, b: 255, alpha: 1 });
    const service = createCanvasTextPreviewService();

    await service.saveSource({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a',
      sourceTemporaryPath: firstSource
    });
    const firstVariant = await service.resolveVariant({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-a',
      width: 64
    });
    const firstVariantHash = sha256(await readFile(firstVariant.absolutePath));

    await service.saveSource({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-b',
      sourceTemporaryPath: secondSource
    });
    const secondVariant = await service.resolveVariant({
      projectRoot,
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-b',
      width: 64
    });

    expect(secondVariant.absolutePath).not.toBe(firstVariant.absolutePath);
    expect(sha256(await readFile(firstVariant.absolutePath))).toBe(firstVariantHash);
    expect(sha256(await readFile(secondVariant.absolutePath))).not.toBe(firstVariantHash);
    expect(secondVariant.absolutePath).toBe(join(projectRoot, canvasTextPreviewVariantProjectPath({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/scene.md',
      fingerprint: 'fingerprint-b',
      width: 64
    })));
  });
});

async function writeFixturePng(
  projectRoot: string,
  name: string,
  width: number,
  height: number,
  background = { r: 30, g: 40, b: 50, alpha: 1 }
): Promise<string> {
  const outputPath = join(projectRoot, name);
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background
    }
  }).png().toFile(outputPath);
  return outputPath;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
