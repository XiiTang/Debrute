import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp, { type Metadata } from 'sharp';

export interface CanvasRasterPreviewService {
  generate(input: {
    sourceAbsolutePath: string;
    outputAbsolutePath: string;
    width: number;
    outputFormat?: 'png' | 'jpeg' | undefined;
    abortSignal?: AbortSignal | undefined;
  }): Promise<{ absolutePath: string }>;
}

export function createCanvasRasterPreviewService(input: {
  generationConcurrency: number;
  metadataConcurrency: number;
}): CanvasRasterPreviewService {
  return new LocalCanvasRasterPreviewService(input);
}

export function createCanvasRasterPreviewConcurrencyLimiter(concurrency: number): <T>(run: () => Promise<T>, abortSignal?: AbortSignal) => Promise<T> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(`Canvas raster preview concurrency must be a positive integer: ${concurrency}`);
  }
  const queue: Array<{
    start: () => void;
    reject: (error: Error) => void;
    onAbort: (() => void) | undefined;
    abortSignal: AbortSignal | undefined;
  }> = [];
  let active = 0;
  return async <T>(run: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> => {
    throwIfCanvasRasterPreviewAborted(abortSignal);
    if (active >= concurrency) {
      await new Promise<void>((resolve, reject) => {
        const queued = {
          start: () => {
            if (queued.abortSignal && queued.onAbort) {
              queued.abortSignal.removeEventListener('abort', queued.onAbort);
            }
            resolve();
          },
          reject: (_error: Error) => {},
          onAbort: undefined as (() => void) | undefined,
          abortSignal
        };
        queued.reject = (error: Error) => {
          if (queued.abortSignal && queued.onAbort) {
            queued.abortSignal.removeEventListener('abort', queued.onAbort);
          }
          const index = queue.indexOf(queued);
          if (index >= 0) {
            queue.splice(index, 1);
          }
          reject(error);
        };
        queued.onAbort = () => queued.reject(canvasRasterPreviewAbortError());
        if (abortSignal) {
          abortSignal.addEventListener('abort', queued.onAbort, { once: true });
        }
        queue.push(queued);
      });
    } else {
      active += 1;
    }
    try {
      throwIfCanvasRasterPreviewAborted(abortSignal);
      return await run();
    } finally {
      const next = queue.shift();
      if (next) {
        next.start();
      } else {
        active -= 1;
      }
    }
  };
}

export async function readCanvasRasterPreviewMetadata(
  absolutePath: string,
  label: string,
  abortSignal?: AbortSignal
): Promise<Metadata> {
  throwIfCanvasRasterPreviewAborted(abortSignal);
  const metadata = await sharp(absolutePath).metadata();
  throwIfCanvasRasterPreviewAborted(abortSignal);
  if ((metadata.pages ?? 1) > 1) {
    throw new Error(`Canvas raster preview source is not a single image: ${label}`);
  }
  return metadata;
}

class LocalCanvasRasterPreviewService implements CanvasRasterPreviewService {
  private readonly withGenerationSlot: <T>(run: () => Promise<T>, abortSignal?: AbortSignal) => Promise<T>;
  private readonly withMetadataSlot: <T>(run: () => Promise<T>, abortSignal?: AbortSignal) => Promise<T>;

  constructor(input: { generationConcurrency: number; metadataConcurrency: number }) {
    this.withGenerationSlot = createCanvasRasterPreviewConcurrencyLimiter(input.generationConcurrency);
    this.withMetadataSlot = createCanvasRasterPreviewConcurrencyLimiter(input.metadataConcurrency);
  }

  async generate(input: {
    sourceAbsolutePath: string;
    outputAbsolutePath: string;
    width: number;
    outputFormat?: 'png' | 'jpeg' | undefined;
    abortSignal?: AbortSignal | undefined;
  }): Promise<{ absolutePath: string }> {
    assertCanvasRasterPreviewWidth(input.width);
    const metadata = await this.withMetadataSlot(
      () => readCanvasRasterPreviewMetadata(input.sourceAbsolutePath, input.sourceAbsolutePath, input.abortSignal),
      input.abortSignal
    );
    const sourceWidth = metadata.width;
    if (typeof sourceWidth !== 'number' || !Number.isFinite(sourceWidth) || sourceWidth <= 0) {
      throw new Error('Canvas raster preview metadata does not include a valid source width.');
    }
    if (input.width > sourceWidth) {
      throw new Error('Canvas raster preview width exceeds source width.');
    }
    return this.withGenerationSlot(async () => {
      const pipeline = sharp(input.sourceAbsolutePath)
        .rotate()
        .resize({ width: input.width, withoutEnlargement: true });
      const outputFormat = input.outputFormat ?? (metadata.hasAlpha === true ? 'png' : 'jpeg');
      const output = outputFormat === 'png'
        ? await pipeline.png().toBuffer({ resolveWithObject: true })
        : await pipeline.jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
      throwIfCanvasRasterPreviewAborted(input.abortSignal);
      await writeFileAtomic(input.outputAbsolutePath, output.data);
      return { absolutePath: input.outputAbsolutePath };
    }, input.abortSignal);
  }
}

export function assertCanvasRasterPreviewWidth(width: number): void {
  if (!Number.isFinite(width) || !Number.isInteger(width) || width <= 0) {
    throw new Error(`Canvas raster preview width must be a positive integer: ${width}`);
  }
}

export async function writeFileAtomic(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, path);
}

export function throwIfCanvasRasterPreviewAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw canvasRasterPreviewAbortError();
  }
}

function canvasRasterPreviewAbortError(): Error {
  return new Error('Canvas raster preview request was aborted.');
}
