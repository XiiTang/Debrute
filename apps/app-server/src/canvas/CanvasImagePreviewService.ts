import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { access, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import {
  CANVAS_IMAGE_PREVIEW_MIN_SOURCE_BYTES,
  CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS,
  type CanvasImagePreviewWidth
} from '@debrute/canvas-core';
import {
  normalizeProjectRelativePath,
  projectFileRevision,
  resolveExistingProjectPath,
  resolveProjectPathForWrite
} from '@debrute/project-core';

const CANVAS_IMAGE_PREVIEW_GENERATION_CONCURRENCY = 2;
const CANVAS_IMAGE_PREVIEW_METADATA_CONCURRENCY = 4;
export {
  CANVAS_IMAGE_PREVIEW_MIN_SOURCE_BYTES,
  CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS,
  type CanvasImagePreviewWidth
} from '@debrute/canvas-core';

export interface ResolveCanvasImagePreviewInput {
  projectRoot: string;
  projectRelativePath: string;
  revision: string;
  width: number;
  abortSignal?: AbortSignal;
}

export interface CanvasImagePreviewResult {
  absolutePath: string;
}

export interface CanvasImagePreviewSourceInfo {
  previewable: boolean;
  sourceWidth?: number;
}

export interface CanvasImagePreviewService {
  resolve(input: ResolveCanvasImagePreviewInput): Promise<CanvasImagePreviewResult>;
}

interface CanvasImagePreviewInFlightEntry {
  promise: Promise<CanvasImagePreviewResult>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
  generationStarted: boolean;
}

export function createCanvasImagePreviewService(): CanvasImagePreviewService {
  return new LocalCanvasImagePreviewService();
}

export function createCanvasImagePreviewConcurrencyLimiter(concurrency: number): <T>(run: () => Promise<T>, abortSignal?: AbortSignal) => Promise<T> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(`Canvas image preview concurrency must be a positive integer: ${concurrency}`);
  }
  const queue: Array<{
    start: () => void;
    reject: (error: Error) => void;
    onAbort: (() => void) | undefined;
    abortSignal: AbortSignal | undefined;
  }> = [];
  let active = 0;
  return async <T>(run: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> => {
    throwIfCanvasPreviewAborted(abortSignal);
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
        queued.onAbort = () => queued.reject(canvasPreviewAbortError());
        if (abortSignal) {
          abortSignal.addEventListener('abort', queued.onAbort, { once: true });
        }
        queue.push(queued);
      });
    } else {
      active += 1;
    }
    try {
      throwIfCanvasPreviewAborted(abortSignal);
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

export async function canvasImageSourceRevision(projectRoot: string, projectRelativePath: string): Promise<string> {
  const fileStat = await canvasImageSourceFileStat(projectRoot, projectRelativePath);
  return projectFileRevision(fileStat.size, fileStat.mtimeMs);
}

export function assertCanvasImagePreviewWidth(width: number): asserts width is CanvasImagePreviewWidth {
  if (!CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS.includes(width as CanvasImagePreviewWidth)) {
    throw new Error(`Unsupported Canvas preview width: ${width}`);
  }
}

export async function canvasImagePreviewSourceInfo(
  projectRoot: string,
  projectRelativePath: string,
  sourceSizeBytes: number
): Promise<CanvasImagePreviewSourceInfo> {
  const normalizedPath = normalizePreviewProjectRelativePath(projectRelativePath);
  if (!isPreviewableRasterImagePath(normalizedPath)) {
    return { previewable: false };
  }
  if (!isPreviewableSourceSize(sourceSizeBytes)) {
    return { previewable: false };
  }
  const absolutePath = await resolveExistingProjectPath(projectRoot, normalizedPath);
  const sourceMetadata = await readCanvasImagePreviewMetadata(absolutePath, projectRelativePath);
  const sourceWidth = sourceMetadata.width;
  if ((sourceMetadata.pages ?? 1) > 1 || typeof sourceWidth !== 'number' || !Number.isFinite(sourceWidth) || sourceWidth <= 0) {
    return { previewable: false };
  }
  return {
    previewable: true,
    sourceWidth
  };
}

class LocalCanvasImagePreviewService implements CanvasImagePreviewService {
  private readonly inFlight = new Map<string, CanvasImagePreviewInFlightEntry>();
  private readonly withGenerationSlot = createCanvasImagePreviewConcurrencyLimiter(CANVAS_IMAGE_PREVIEW_GENERATION_CONCURRENCY);

  async resolve(input: ResolveCanvasImagePreviewInput): Promise<CanvasImagePreviewResult> {
    throwIfCanvasPreviewAborted(input.abortSignal);
    assertCanvasImagePreviewWidth(input.width);
    const projectRelativePath = normalizePreviewProjectRelativePath(input.projectRelativePath);
    const key = `${input.projectRoot}\0${projectRelativePath}\0${input.revision}\0${input.width}`;
    let entry = this.inFlight.get(key);
    if (entry && entry.consumers <= 0 && entry.controller.signal.aborted && !entry.settled) {
      this.inFlight.delete(key);
      entry = undefined;
    }
    if (!entry) {
      entry = this.createInFlightEntry(key, {
        ...input,
        projectRelativePath,
        width: input.width
      });
      this.inFlight.set(key, entry);
    }
    return this.consumeInFlightEntry(entry, input.abortSignal);
  }

  private createInFlightEntry(
    key: string,
    input: ResolveCanvasImagePreviewInput & { width: CanvasImagePreviewWidth }
  ): CanvasImagePreviewInFlightEntry {
    const controller = new AbortController();
    let entry: CanvasImagePreviewInFlightEntry;
    const promise = this.resolvePreview({
      ...input,
      abortSignal: controller.signal,
      onGenerationStart: () => {
        entry.generationStarted = true;
      }
    }).finally(() => {
      entry.settled = true;
      if (this.inFlight.get(key) === entry) {
        this.inFlight.delete(key);
      }
    });
    entry = {
      promise,
      controller,
      consumers: 0,
      settled: false,
      generationStarted: false
    };
    return entry;
  }

  private consumeInFlightEntry(
    entry: CanvasImagePreviewInFlightEntry,
    abortSignal: AbortSignal | undefined
  ): Promise<CanvasImagePreviewResult> {
    throwIfCanvasPreviewAborted(abortSignal);
    entry.consumers += 1;
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      entry.consumers -= 1;
      if (entry.consumers <= 0 && !entry.settled && !entry.generationStarted) {
        entry.controller.abort();
      }
    };

    if (!abortSignal) {
      return entry.promise.finally(release);
    }

    return new Promise<CanvasImagePreviewResult>((resolve, reject) => {
      const cleanup = () => {
        abortSignal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        release();
        reject(canvasPreviewAbortError());
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      entry.promise.then(resolve, reject).finally(() => {
        cleanup();
        release();
      });
    });
  }

  private async resolvePreview(input: ResolveCanvasImagePreviewInput & {
    width: CanvasImagePreviewWidth;
    onGenerationStart?: () => void;
  }): Promise<CanvasImagePreviewResult> {
    throwIfCanvasPreviewAborted(input.abortSignal);
    if (!isPreviewableRasterImagePath(input.projectRelativePath)) {
      throw new Error(`Canvas image is not previewable: ${input.projectRelativePath}`);
    }
    const absoluteSourcePath = await resolveExistingProjectPath(input.projectRoot, input.projectRelativePath);
    throwIfCanvasPreviewAborted(input.abortSignal);
    const fileStat = await canvasImageSourceFileStat(input.projectRoot, input.projectRelativePath);
    throwIfCanvasPreviewAborted(input.abortSignal);
    const actualRevision = projectFileRevision(fileStat.size, fileStat.mtimeMs);
    if (actualRevision !== input.revision) {
      throw new Error(`Canvas preview revision does not match source: ${input.projectRelativePath}`);
    }
    if (!isPreviewableSourceSize(fileStat.size)) {
      throw new Error(`Canvas image is not previewable: ${input.projectRelativePath}`);
    }

    const previewBasePath = await canvasImagePreviewCacheBasePath(input.projectRoot, {
      projectRelativePath: input.projectRelativePath,
      revision: input.revision,
      width: input.width
    });
    throwIfCanvasPreviewAborted(input.abortSignal);
    const existingPreviewPath = await existingCanvasImagePreviewCachePath(previewBasePath);
    if (existingPreviewPath) {
      return {
        absolutePath: existingPreviewPath
      };
    }

    const sourceMetadata = await readCanvasImagePreviewMetadata(absoluteSourcePath, input.projectRelativePath, input.abortSignal);
    throwIfCanvasPreviewAborted(input.abortSignal);
    if ((sourceMetadata.pages ?? 1) > 1) {
      throw new Error(`Canvas image is not previewable: ${input.projectRelativePath}`);
    }
    const output = sourceMetadata.hasAlpha === true
      ? { extension: 'png' as const }
      : { extension: 'jpg' as const };
    const absolutePreviewPath = `${previewBasePath}.${output.extension}`;

    if (await fileExists(absolutePreviewPath)) {
      return {
        absolutePath: absolutePreviewPath
      };
    }

    return this.withGenerationSlot(async () => {
      input.onGenerationStart?.();
      if (await fileExists(absolutePreviewPath)) {
        return {
          absolutePath: absolutePreviewPath
        };
      }
      const pipeline = sharp(absoluteSourcePath)
        .rotate()
        .resize({ width: input.width, withoutEnlargement: true });
      const bytes = output.extension === 'png'
        ? await pipeline.png().toBuffer()
        : await pipeline.jpeg({ quality: 82 }).toBuffer();
      throwIfCanvasPreviewAborted(input.abortSignal);
      await writeFileAtomic(absolutePreviewPath, bytes);
      return {
        absolutePath: absolutePreviewPath
      };
    }, input.abortSignal);
  }
}

const withMetadataSlot = createCanvasImagePreviewConcurrencyLimiter(CANVAS_IMAGE_PREVIEW_METADATA_CONCURRENCY);

async function canvasImageSourceFileStat(projectRoot: string, projectRelativePath: string): Promise<Stats> {
  const fileStat = await stat(await resolveExistingProjectPath(projectRoot, normalizePreviewProjectRelativePath(projectRelativePath)));
  if (!fileStat.isFile()) {
    throw new Error(`Canvas preview source is not a file: ${projectRelativePath}`);
  }
  return fileStat;
}

async function readCanvasImagePreviewMetadata(
  absolutePath: string,
  projectRelativePath: string,
  abortSignal?: AbortSignal
): Promise<sharp.Metadata> {
  try {
    return await withMetadataSlot(() => {
      throwIfCanvasPreviewAborted(abortSignal);
      return sharp(absolutePath).metadata();
    }, abortSignal);
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    throw new Error(`Canvas image preview metadata could not be read: ${projectRelativePath}`);
  }
}

function isPreviewableSourceSize(sourceSizeBytes: number): boolean {
  return sourceSizeBytes >= CANVAS_IMAGE_PREVIEW_MIN_SOURCE_BYTES;
}

async function canvasImagePreviewCacheBasePath(
  projectRoot: string,
  input: {
    projectRelativePath: string;
    revision: string;
    width: CanvasImagePreviewWidth;
  }
): Promise<string> {
  const hash = createHash('sha256')
    .update(input.projectRelativePath)
    .update('\0')
    .update(input.revision)
    .update('\0')
    .update(String(input.width))
    .digest('hex');
  return resolveProjectPathForWrite(projectRoot, `.debrute/cache/canvas-image-previews/${hash}`);
}

async function existingCanvasImagePreviewCachePath(basePath: string): Promise<string | undefined> {
  for (const extension of ['jpg', 'png'] as const) {
    const candidate = `${basePath}.${extension}`;
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function normalizePreviewProjectRelativePath(projectRelativePath: string): string {
  return normalizeProjectRelativePath(projectRelativePath);
}

function isPreviewableRasterImagePath(projectRelativePath: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(projectRelativePath);
}

async function writeFileAtomic(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, path);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function throwIfCanvasPreviewAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw canvasPreviewAbortError();
  }
}

function canvasPreviewAbortError(): Error {
  return new Error('Canvas image preview request was aborted.');
}
