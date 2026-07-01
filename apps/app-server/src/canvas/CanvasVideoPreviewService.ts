import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  normalizeProjectRelativePath,
  projectFileRevision,
  resolveExistingProjectPath,
  resolveNoSymlinkExistingProjectPath,
  resolveNoSymlinkProjectPathForWrite,
  resolveProjectPath
} from '@debrute/project-core';
import {
  createCanvasRasterPreviewService,
  readCanvasRasterPreviewMetadata
} from './CanvasRasterPreviewService.js';
import {
  readCanvasVideoMetadata,
  type CanvasVideoMetadata
} from './CanvasNodeDimensionsService.js';
import {
  createCanvasVideoFrameExtractor,
  type CanvasVideoFrameExtractor
} from './CanvasVideoFrameExtractor.js';
import {
  canvasVideoInitialAutoSourceKey,
  canvasVideoInitialExplicitSourceKey,
  canvasVideoPlaybackFrameSourceKey,
  canvasVideoPreviewSourceDirectoryProjectPath,
  canvasVideoPreviewSourceProjectPath,
  canvasVideoPreviewTimestampKey,
  canvasVideoPreviewVariantProjectPath,
  sourceExtensionForProjectPath,
  type CanvasVideoPreviewSourceKind
} from './CanvasVideoPreviewPaths.js';

const CANVAS_VIDEO_PREVIEW_VARIANT_CONCURRENCY = 16;
const CANVAS_VIDEO_PREVIEW_METADATA_CONCURRENCY = 8;
const INITIAL_POSTER_STRONG_SUFFIXES = ['.poster.png', '.poster.jpg', '.poster.jpeg', '.poster.webp', '.poster.avif'] as const;
const INITIAL_POSTER_SAME_BASENAME_SUFFIXES = ['.png', '.jpg', '.jpeg', '.webp', '.avif'] as const;

export interface CanvasVideoPreviewSourceTarget {
  projectRelativePath: string;
  videoRevision: string;
  currentTimeSeconds: number;
}

export type CanvasVideoPreviewSourceView = CanvasVideoPreviewSourceTarget & (
  | {
      status: 'available';
      sourceKind: CanvasVideoPreviewSourceKind;
      sourceKey: string;
      sourceWidth: number;
    }
  | {
      status: 'error';
      sourceKind: CanvasVideoPreviewSourceKind;
      message: string;
    }
);

export interface CanvasVideoPreviewReadSourcesInput {
  projectRoot: string;
  canvasId: string;
  targets: CanvasVideoPreviewSourceTarget[];
}

export interface CanvasVideoPreviewResolveVariantInput extends CanvasVideoPreviewSourceTarget {
  canvasId: string;
  projectRoot: string;
  sourceKey: string;
  width: number;
}

export interface CanvasVideoPreviewService {
  readSources(input: CanvasVideoPreviewReadSourcesInput): Promise<{ sources: Record<string, CanvasVideoPreviewSourceView> }>;
  resolveVariant(input: CanvasVideoPreviewResolveVariantInput): Promise<{ absolutePath: string }>;
}

export function createCanvasVideoPreviewService(input: {
  frameExtractor?: CanvasVideoFrameExtractor | undefined;
  readVideoMetadata?: ((input: { projectRoot: string; projectRelativePath: string }) => Promise<CanvasVideoMetadata>) | undefined;
  envPath?: string | undefined;
} = {}): CanvasVideoPreviewService {
  return new LocalCanvasVideoPreviewService({
    frameExtractor: input.frameExtractor ?? createCanvasVideoFrameExtractor({
      ...(input.envPath !== undefined ? { envPath: input.envPath } : {})
    }),
    readVideoMetadata: input.readVideoMetadata ?? ((metadataInput) => readCanvasVideoMetadata({
      ...metadataInput,
      ...(input.envPath !== undefined ? { envPath: input.envPath } : {})
    }))
  });
}

class LocalCanvasVideoPreviewService implements CanvasVideoPreviewService {
  private readonly rasterPreviewService = createCanvasRasterPreviewService({
    generationConcurrency: CANVAS_VIDEO_PREVIEW_VARIANT_CONCURRENCY,
    metadataConcurrency: CANVAS_VIDEO_PREVIEW_METADATA_CONCURRENCY
  });
  private readonly inFlightSources = new Map<string, Promise<CanvasVideoPreviewSourceView>>();
  private readonly inFlightVariants = new Map<string, Promise<{ absolutePath: string }>>();

  constructor(private readonly dependencies: {
    frameExtractor: CanvasVideoFrameExtractor;
    readVideoMetadata(input: { projectRoot: string; projectRelativePath: string }): Promise<CanvasVideoMetadata>;
  }) {}

  async readSources(input: CanvasVideoPreviewReadSourcesInput): Promise<{ sources: Record<string, CanvasVideoPreviewSourceView> }> {
    const entries = await Promise.all(input.targets.map(async (target) => [
      target.projectRelativePath,
      await this.readSource({
        ...target,
        canvasId: input.canvasId,
        projectRoot: input.projectRoot
      })
    ] as const));
    return { sources: Object.fromEntries(entries) };
  }

  async resolveVariant(input: CanvasVideoPreviewResolveVariantInput): Promise<{ absolutePath: string }> {
    const sourceKind = sourceKindForPlaybackTime(input.currentTimeSeconds);
    const key = [
      input.projectRoot,
      input.canvasId,
      input.projectRelativePath,
      input.videoRevision,
      sourceKind,
      input.currentTimeSeconds,
      input.sourceKey,
      input.width
    ].join('\0');
    const existing = this.inFlightVariants.get(key);
    if (existing) {
      return existing;
    }
    const promise = this.resolveVariantNow(input, sourceKind).finally(() => {
      if (this.inFlightVariants.get(key) === promise) {
        this.inFlightVariants.delete(key);
      }
    });
    this.inFlightVariants.set(key, promise);
    return promise;
  }

  private async readSource(input: CanvasVideoPreviewSourceTarget & { canvasId: string; projectRoot: string }): Promise<CanvasVideoPreviewSourceView> {
    const sourceKind = sourceKindForPlaybackTime(input.currentTimeSeconds);
    const sourceKeyHint = sourceKind === 'playback-frame'
      ? canvasVideoPlaybackFrameSourceKey(input.currentTimeSeconds)
      : undefined;
    const key = [
      input.projectRoot,
      input.canvasId,
      input.projectRelativePath,
      input.videoRevision,
      sourceKind,
      input.currentTimeSeconds,
      sourceKeyHint ?? 'initial'
    ].join('\0');
    const existing = this.inFlightSources.get(key);
    if (existing) {
      return existing;
    }
    const promise = this.readSourceNow(input, sourceKind).finally(() => {
      if (this.inFlightSources.get(key) === promise) {
        this.inFlightSources.delete(key);
      }
    });
    this.inFlightSources.set(key, promise);
    return promise;
  }

  private async readSourceNow(
    input: CanvasVideoPreviewSourceTarget & { canvasId: string; projectRoot: string },
    sourceKind: CanvasVideoPreviewSourceKind
  ): Promise<CanvasVideoPreviewSourceView> {
    try {
      await assertCanvasVideoPreviewVideoRevision(input);
      const source = sourceKind === 'initial-poster'
        ? await this.resolveInitialPosterSource(input)
        : await this.resolvePlaybackFrameSource(input);
      return {
        projectRelativePath: input.projectRelativePath,
        videoRevision: input.videoRevision,
        currentTimeSeconds: input.currentTimeSeconds,
        status: 'available',
        sourceKind,
        sourceKey: source.sourceKey,
        sourceWidth: source.sourceWidth
      };
    } catch (error) {
      return {
        projectRelativePath: input.projectRelativePath,
        videoRevision: input.videoRevision,
        currentTimeSeconds: input.currentTimeSeconds,
        status: 'error',
        sourceKind,
        message: errorMessage(error)
      };
    }
  }

  private async resolveInitialPosterSource(input: CanvasVideoPreviewSourceTarget & { canvasId: string; projectRoot: string }): Promise<ResolvedCanvasVideoPreviewSource> {
    const explicit = await findExplicitPoster(input.projectRoot, input.projectRelativePath);
    if (explicit) {
      return this.resolveExplicitPosterSource(input, explicit);
    }
    return this.resolveAutoInitialFrameSource(input);
  }

  private async resolveExplicitPosterSource(
    input: CanvasVideoPreviewSourceTarget & { canvasId: string; projectRoot: string },
    explicit: ExplicitPosterCandidate
  ): Promise<ResolvedCanvasVideoPreviewSource> {
    const sourceKey = canvasVideoInitialExplicitSourceKey({
      posterProjectRelativePath: explicit.projectRelativePath,
      posterRevision: explicit.revision
    });
    const sourceProjectPath = canvasVideoPreviewSourceProjectPath({
      canvasId: input.canvasId,
      projectRelativePath: input.projectRelativePath,
      videoRevision: input.videoRevision,
      sourceKind: 'initial-poster',
      sourceKey,
      sourceExtension: explicit.sourceExtension
    });
    const existingSource = await existingFilePath(input.projectRoot, sourceProjectPath);
    const absoluteSourcePath = existingSource ?? await resolveNoSymlinkProjectPathForWrite(input.projectRoot, sourceProjectPath);
    if (!existingSource) {
      await mkdir(dirname(absoluteSourcePath), { recursive: true });
      await copyFile(explicit.absolutePath, absoluteSourcePath);
    }
    const metadata = await readCanvasVideoPreviewSourceMetadata(absoluteSourcePath, explicit.projectRelativePath);
    return {
      sourceKey,
      sourceWidth: sourceWidthFromMetadata(metadata, explicit.projectRelativePath)
    };
  }

  private async resolveAutoInitialFrameSource(input: CanvasVideoPreviewSourceTarget & { canvasId: string; projectRoot: string }): Promise<ResolvedCanvasVideoPreviewSource> {
    const sourceKey = canvasVideoInitialAutoSourceKey(input.videoRevision);
    return this.resolveExtractedFrameSource({
      ...input,
      sourceKind: 'initial-poster',
      sourceKey,
      currentTimeSeconds: 0
    });
  }

  private async resolvePlaybackFrameSource(input: CanvasVideoPreviewSourceTarget & { canvasId: string; projectRoot: string }): Promise<ResolvedCanvasVideoPreviewSource> {
    const metadata = await this.dependencies.readVideoMetadata({
      projectRoot: input.projectRoot,
      projectRelativePath: input.projectRelativePath
    });
    if (metadata.durationSeconds !== undefined && input.currentTimeSeconds > metadata.durationSeconds) {
      throw new Error(`Canvas video playback time exceeds video duration: ${input.projectRelativePath}`);
    }
    const sourceKey = canvasVideoPlaybackFrameSourceKey(input.currentTimeSeconds);
    return this.resolveExtractedFrameSource({
      ...input,
      sourceKind: 'playback-frame',
      sourceKey
    });
  }

  private async resolveExtractedFrameSource(
    input: CanvasVideoPreviewSourceTarget & {
      canvasId: string;
      projectRoot: string;
      sourceKind: CanvasVideoPreviewSourceKind;
      sourceKey: string;
    }
  ): Promise<ResolvedCanvasVideoPreviewSource> {
    const sourceProjectPath = canvasVideoPreviewSourceProjectPath({
      canvasId: input.canvasId,
      projectRelativePath: input.projectRelativePath,
      videoRevision: input.videoRevision,
      sourceKind: input.sourceKind,
      sourceKey: input.sourceKey,
      sourceExtension: '.jpg'
    });
    const existingSource = await existingFilePath(input.projectRoot, sourceProjectPath);
    const absoluteSourcePath = existingSource ?? await resolveNoSymlinkProjectPathForWrite(input.projectRoot, sourceProjectPath);
    if (!existingSource) {
      const videoAbsolutePath = await resolveExistingProjectPath(input.projectRoot, input.projectRelativePath);
      await this.dependencies.frameExtractor.extractFrame({
        videoAbsolutePath,
        outputAbsolutePath: absoluteSourcePath,
        projectRelativePath: input.projectRelativePath,
        currentTimeSeconds: input.currentTimeSeconds
      });
    }
    const metadata = await readCanvasVideoPreviewSourceMetadata(absoluteSourcePath, input.projectRelativePath);
    return {
      sourceKey: input.sourceKey,
      sourceWidth: sourceWidthFromMetadata(metadata, input.projectRelativePath)
    };
  }

  private async resolveVariantNow(
    input: CanvasVideoPreviewResolveVariantInput,
    sourceKind: CanvasVideoPreviewSourceKind
  ): Promise<{ absolutePath: string }> {
    await assertCanvasVideoPreviewVideoRevision(input);
    const sourceDirectory = canvasVideoPreviewSourceDirectoryProjectPath({
      canvasId: input.canvasId,
      projectRelativePath: input.projectRelativePath,
      videoRevision: input.videoRevision,
      sourceKind,
      sourceKey: input.sourceKey
    });
    const absoluteSourceDirectory = resolveProjectPath(input.projectRoot, sourceDirectory);
    const sourceName = await sourceFileName(absoluteSourceDirectory);
    if (!sourceName) {
      throw new CanvasVideoPreviewServiceError(
        'canvas_video_preview_source_missing',
        `Canvas video preview source is not available: ${input.projectRelativePath}`,
        {
          canvasId: input.canvasId,
          projectRelativePath: input.projectRelativePath,
          videoRevision: input.videoRevision,
          currentTimeSeconds: input.currentTimeSeconds,
          sourceKey: input.sourceKey
        }
      );
    }
    const absoluteSourcePath = await resolveNoSymlinkExistingProjectPath(input.projectRoot, `${sourceDirectory}/${sourceName}`);
    const variantProjectPath = canvasVideoPreviewVariantProjectPath({
      canvasId: input.canvasId,
      projectRelativePath: input.projectRelativePath,
      videoRevision: input.videoRevision,
      sourceKind,
      sourceKey: input.sourceKey,
      width: input.width
    });
    const existingVariant = await existingFilePath(input.projectRoot, variantProjectPath);
    if (existingVariant) {
      return { absolutePath: existingVariant };
    }
    const absoluteVariantPath = await resolveNoSymlinkProjectPathForWrite(input.projectRoot, variantProjectPath);
    await this.rasterPreviewService.generate({
      sourceAbsolutePath: absoluteSourcePath,
      outputAbsolutePath: absoluteVariantPath,
      width: input.width,
      outputFormat: 'jpeg'
    });
    return {
      absolutePath: await resolveNoSymlinkExistingProjectPath(input.projectRoot, variantProjectPath)
    };
  }
}

interface ExplicitPosterCandidate {
  projectRelativePath: string;
  absolutePath: string;
  revision: string;
  sourceExtension: string;
}

interface ResolvedCanvasVideoPreviewSource {
  sourceKey: string;
  sourceWidth: number;
}

async function findExplicitPoster(projectRoot: string, videoProjectRelativePath: string): Promise<ExplicitPosterCandidate | undefined> {
  const videoPath = normalizeProjectRelativePath(videoProjectRelativePath);
  const base = basenameWithoutMediaExtension(videoPath);
  const directory = dirname(videoPath);
  const candidates = [
    ...INITIAL_POSTER_STRONG_SUFFIXES.map((suffix) => `${base}${suffix}`),
    ...INITIAL_POSTER_SAME_BASENAME_SUFFIXES.map((suffix) => `${base}${suffix}`)
  ].map((name) => normalizeProjectRelativePath(join(directory, name)));
  for (const projectRelativePath of candidates) {
    const candidate = await explicitPosterCandidate(projectRoot, projectRelativePath);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

async function explicitPosterCandidate(projectRoot: string, projectRelativePath: string): Promise<ExplicitPosterCandidate | undefined> {
  let absolutePath: string;
  try {
    absolutePath = await resolveExistingProjectPath(projectRoot, projectRelativePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error(`Canvas video preview explicit poster is not a file: ${projectRelativePath}`);
  }
  return {
    projectRelativePath,
    absolutePath,
    revision: projectFileRevision(fileStat.size, fileStat.mtimeMs),
    sourceExtension: sourceExtensionForProjectPath(projectRelativePath)
  };
}

async function assertCanvasVideoPreviewVideoRevision(input: {
  projectRoot: string;
  projectRelativePath: string;
  videoRevision: string;
}): Promise<void> {
  const fileStat = await stat(await resolveExistingProjectPath(input.projectRoot, normalizeProjectRelativePath(input.projectRelativePath)));
  if (!fileStat.isFile()) {
    throw new Error(`Canvas video preview source is not a file: ${input.projectRelativePath}`);
  }
  const actualRevision = projectFileRevision(fileStat.size, fileStat.mtimeMs);
  if (actualRevision !== input.videoRevision) {
    throw new CanvasVideoPreviewServiceError(
      'canvas_video_preview_revision_mismatch',
      `Canvas video preview revision does not match source: ${input.projectRelativePath}`,
      {
        projectRelativePath: input.projectRelativePath,
        videoRevision: input.videoRevision,
        actualRevision
      }
    );
  }
}

async function existingFilePath(projectRoot: string, projectRelativePath: string): Promise<string | undefined> {
  const absolutePath = resolveProjectPath(projectRoot, projectRelativePath);
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      return undefined;
    }
    return await resolveNoSymlinkExistingProjectPath(projectRoot, projectRelativePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function sourceFileName(absoluteSourceDirectory: string): Promise<string | undefined> {
  try {
    const names = await readdir(absoluteSourceDirectory);
    return names.find((name) => /^source\.[a-z0-9]+$/.test(name));
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function sourceKindForPlaybackTime(currentTimeSeconds: number): CanvasVideoPreviewSourceKind {
  canvasVideoPreviewTimestampKey(currentTimeSeconds);
  return currentTimeSeconds === 0 ? 'initial-poster' : 'playback-frame';
}

function sourceWidthFromMetadata(metadata: { width?: number | undefined }, label: string): number {
  if (typeof metadata.width !== 'number' || !Number.isFinite(metadata.width) || metadata.width <= 0) {
    throw new Error(`Canvas video preview source metadata does not include a valid width: ${label}`);
  }
  return metadata.width;
}

async function readCanvasVideoPreviewSourceMetadata(absolutePath: string, label: string): Promise<{ width?: number | undefined }> {
  try {
    return await readCanvasRasterPreviewMetadata(absolutePath, label);
  } catch (error) {
    throw new Error(`${label}: ${errorMessage(error)}`);
  }
}

function basenameWithoutMediaExtension(projectRelativePath: string): string {
  const name = projectRelativePath.split('/').pop() ?? projectRelativePath;
  const dotIndex = name.lastIndexOf('.');
  return dotIndex >= 0 ? name.slice(0, dotIndex) : name;
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CanvasVideoPreviewServiceError extends Error {
  constructor(
    readonly code: 'canvas_video_preview_source_missing' | 'canvas_video_preview_revision_mismatch',
    message: string,
    readonly fields: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CanvasVideoPreviewServiceError';
  }
}

export type { CanvasVideoFrameExtractor };
