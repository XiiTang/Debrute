import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('canvas image preview active aborts', () => {
  afterEach(() => {
    vi.doUnmock('sharp');
    vi.resetModules();
  });

  it('keeps an active preview generation running for the cache after its last consumer aborts', async () => {
    vi.resetModules();
    const generation = deferred<void>();
    const finishGeneration = deferred<void>();
    let toBufferCalls = 0;
    vi.doMock('sharp', () => ({
      default: () => {
        const api = {
          metadata: async () => ({ width: 800, pages: 1, hasAlpha: false }),
          rotate: () => api,
          resize: () => api,
          jpeg: () => api,
          png: () => api,
          toBuffer: async () => {
            toBufferCalls += 1;
            generation.resolve();
            await finishGeneration.promise;
            return Buffer.from('preview-cache-bytes');
          }
        };
        return api;
      }
    }));
    const {
      canvasImageSourceRevision,
      createCanvasImagePreviewService
    } = await import('../apps/app-server/src/canvas/CanvasImagePreviewService');
    const projectRoot = await mkdtemp(join(tmpdir(), 'axis-canvas-preview-active-abort-'));
    try {
      await mkdir(join(projectRoot, 'images'), { recursive: true });
      await writeFile(join(projectRoot, 'images/cover.png'), Buffer.alloc(1_600_000, 1));
      const service = createCanvasImagePreviewService();
      const revision = await canvasImageSourceRevision(projectRoot, 'images/cover.png');
      const controller = new AbortController();

      const aborted = service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 512,
        abortSignal: controller.signal
      });
      await generation.promise;

      controller.abort();
      await expect(aborted).rejects.toThrow('Canvas image preview request was aborted.');
      finishGeneration.resolve();
      await nextTick();

      const cached = await service.resolve({
        projectRoot,
        projectRelativePath: 'images/cover.png',
        revision,
        width: 512
      });

      expect(toBufferCalls).toBe(1);
      await expect(readFile(cached.absolutePath, 'utf8')).resolves.toBe('preview-cache-bytes');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
