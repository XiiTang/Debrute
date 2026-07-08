import type { Stats } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { Metadata } from 'sharp';
import {
  isCanvasPreviewableProjectImagePath,
  normalizeProjectRelativePath,
  projectFileRevision,
  projectImageMimeTypeMatchesPath,
  projectRelativePathCacheKey,
  projectRevisionCacheKey,
  resolveExistingProjectPath,
  resolveNoSymlinkExistingProjectPath,
  resolveNoSymlinkProjectPathForWrite,
  resolveProjectPath
} from '@debrute/project-core';
import {
  assertCanvasRasterPreviewWidth,
  createCanvasRasterPreviewConcurrencyLimiter,
  createCanvasRasterPreviewService,
  readCanvasRasterPreviewMetadata
} from './CanvasRasterPreviewService.js';

const CANVAS_IMAGE_PREVIEW_GENERATION_CONCURRENCY = 2;
const CANVAS_IMAGE_PREVIEW_METADATA_CONCURRENCY = 4;

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
  const limit = createCanvasRasterPreviewConcurrencyLimiter(concurrency);
  return (run, abortSignal) => limit(run, abortSignal).catch((error: unknown) => {
    if (abortSignal?.aborted) {
      throw canvasPreviewAbortError();
    }
    throw error;
  });
}

export async function canvasImageSourceRevision(projectRoot: string, projectRelativePath: string): Promise<string> {
  const fileStat = await canvasImageSourceFileStat(projectRoot, projectRelativePath);
  return projectFileRevision(fileStat.size, fileStat.mtimeMs);
}

export function assertCanvasImagePreviewWidth(width: number): void {
  try {
    assertCanvasRasterPreviewWidth(width);
  } catch {
    throw new Error(`Canvas preview width must be a positive integer: ${width}`);
  }
}

function assertCanvasImagePreviewWidthWithinSource(
  width: number,
  sourceWidth: number | undefined,
  projectRelativePath: string
): void {
  if (typeof sourceWidth !== 'number' || !Number.isFinite(sourceWidth) || sourceWidth <= 0) {
    throw new Error(`Canvas image preview metadata could not be read: ${projectRelativePath}`);
  }
  if (width > sourceWidth) {
    throw new Error(`Canvas preview width exceeds source width: ${projectRelativePath}`);
  }
}

export async function canvasImagePreviewSourceInfo(
  projectRoot: string,
  projectRelativePath: string
): Promise<CanvasImagePreviewSourceInfo> {
  const normalizedPath = normalizePreviewProjectRelativePath(projectRelativePath);
  if (!isPreviewableRasterImagePath(normalizedPath)) {
    return { previewable: false };
  }
  const absolutePath = await resolveExistingProjectPath(projectRoot, normalizedPath);
  const sourceMetadata = await readCanvasImagePreviewMetadata(absolutePath, projectRelativePath);
  const sourceWidth = previewableRasterImageSourceWidth(normalizedPath, sourceMetadata);
  if (sourceWidth === undefined) {
    return { previewable: false };
  }
  return {
    previewable: true,
    sourceWidth
  };
}

class LocalCanvasImagePreviewService implements CanvasImagePreviewService {
  private readonly inFlight = new Map<string, CanvasImagePreviewInFlightEntry>();
  private readonly rasterPreviewService = createCanvasRasterPreviewService({
    generationConcurrency: CANVAS_IMAGE_PREVIEW_GENERATION_CONCURRENCY,
    metadataConcurrency: CANVAS_IMAGE_PREVIEW_METADATA_CONCURRENCY
  });

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
    input: ResolveCanvasImagePreviewInput
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
    const sourceMetadata = await readCanvasImagePreviewMetadata(absoluteSourcePath, input.projectRelativePath, input.abortSignal);
    throwIfCanvasPreviewAborted(input.abortSignal);
    const sourceWidth = previewableRasterImageSourceWidth(input.projectRelativePath, sourceMetadata);
    if (sourceWidth === undefined) {
      throw new Error(`Canvas image is not previewable: ${input.projectRelativePath}`);
    }
    assertCanvasImagePreviewWidthWithinSource(input.width, sourceWidth, input.projectRelativePath);

    const previewBaseProjectPath = canvasImagePreviewCacheBaseProjectPath({
      projectRelativePath: input.projectRelativePath,
      revision: input.revision,
      width: input.width
    });
    throwIfCanvasPreviewAborted(input.abortSignal);
    const existingPreviewPath = await existingCanvasImagePreviewCachePath(input.projectRoot, previewBaseProjectPath);
    if (existingPreviewPath) {
      return {
        absolutePath: existingPreviewPath
      };
    }

    const output = sourceMetadata.hasAlpha === true
      ? { extension: 'png' as const }
      : { extension: 'jpg' as const };
    const previewProjectPath = `${previewBaseProjectPath}.${output.extension}`;
    const absolutePreviewPath = await resolveNoSymlinkProjectPathForWrite(input.projectRoot, previewProjectPath);

    input.onGenerationStart?.();
    const generatedByAnotherRequest = await existingCanvasImagePreviewCachePath(input.projectRoot, previewBaseProjectPath);
    if (generatedByAnotherRequest) {
      return {
        absolutePath: generatedByAnotherRequest
      };
    }
    return this.rasterPreviewService.generate({
      sourceAbsolutePath: absoluteSourcePath,
      outputAbsolutePath: absolutePreviewPath,
      width: input.width,
      abortSignal: input.abortSignal
    });
  }
}

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
): Promise<Metadata> {
  try {
    return await readCanvasRasterPreviewMetadata(absolutePath, projectRelativePath, abortSignal);
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    throw new Error(`Canvas image preview metadata could not be read: ${projectRelativePath}`);
  }
}

function canvasImagePreviewCacheBaseProjectPath(
  input: {
    projectRelativePath: string;
    revision: string;
    width: number;
  }
): string {
  const sourceKey = projectRelativePathCacheKey(input.projectRelativePath);
  const revisionKey = projectRevisionCacheKey(input.revision);
  return `.debrute/cache/canvas-image-previews/${sourceKey}/${revisionKey}/preview-w${input.width}`;
}

async function existingCanvasImagePreviewCachePath(projectRoot: string, baseProjectPath: string): Promise<string | undefined> {
  for (const extension of ['jpg', 'png'] as const) {
    const candidateProjectPath = `${baseProjectPath}.${extension}`;
    if (!await fileExists(resolveProjectPath(projectRoot, candidateProjectPath))) {
      continue;
    }
    const candidate = await resolveNoSymlinkExistingProjectPath(projectRoot, candidateProjectPath);
    const candidateStat = await stat(candidate);
    if (!candidateStat.isFile()) {
      throw new Error(`Canvas preview cache candidate is not a file: ${candidateProjectPath}`);
    }
    return candidate;
  }
  return undefined;
}

function normalizePreviewProjectRelativePath(projectRelativePath: string): string {
  return normalizeProjectRelativePath(projectRelativePath);
}

function isPreviewableRasterImagePath(projectRelativePath: string): boolean {
  return isCanvasPreviewableProjectImagePath(projectRelativePath);
}

function previewableRasterImageSourceWidth(projectRelativePath: string, metadata: Metadata): number | undefined {
  const sourceWidth = metadata.width;
  if (!projectImageMimeTypeMatchesPath(metadata.mediaType, projectRelativePath)) {
    return undefined;
  }
  if ((metadata.pages ?? 1) > 1) {
    return undefined;
  }
  if (typeof sourceWidth !== 'number' || !Number.isFinite(sourceWidth) || sourceWidth <= 0) {
    return undefined;
  }
  return sourceWidth;
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
