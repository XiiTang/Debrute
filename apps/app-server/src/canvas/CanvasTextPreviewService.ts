import { readFile, stat } from 'node:fs/promises';
import {
  canvasTextPreviewSourceProjectPath,
  canvasTextPreviewVariantProjectPath
} from '@debrute/canvas-core';
import {
  resolveNoSymlinkExistingProjectPath,
  resolveNoSymlinkProjectPathForWrite,
  resolveProjectPath
} from '@debrute/project-core';
import {
  createCanvasRasterPreviewService,
  writeFileAtomic
} from './CanvasRasterPreviewService.js';

const CANVAS_TEXT_PREVIEW_VARIANT_CONCURRENCY = 24;
const CANVAS_TEXT_PREVIEW_METADATA_CONCURRENCY = 8;

export interface CanvasTextPreviewSourceInput {
  projectRoot: string;
  canvasId: string;
  projectRelativePath: string;
  fingerprint: string;
}

export interface CanvasTextPreviewSaveSourceInput extends CanvasTextPreviewSourceInput {
  sourceTemporaryPath: string;
}

export interface CanvasTextPreviewSourceView {
  projectRelativePath: string;
  fingerprint: string;
  available: boolean;
}

export interface CanvasTextPreviewReadSourcesInput {
  projectRoot: string;
  canvasId: string;
  sources: Array<{
    projectRelativePath: string;
    fingerprint: string;
  }>;
}

export interface CanvasTextPreviewResolveVariantInput extends CanvasTextPreviewSourceInput {
  width: number;
}

export interface CanvasTextPreviewService {
  saveSource(input: CanvasTextPreviewSaveSourceInput): Promise<{
    ok: true;
    source: CanvasTextPreviewSourceView & { available: true };
  }>;
  readSources(input: CanvasTextPreviewReadSourcesInput): Promise<{ sources: Record<string, CanvasTextPreviewSourceView> }>;
  resolveVariant(input: CanvasTextPreviewResolveVariantInput): Promise<{ absolutePath: string }>;
}

export function createCanvasTextPreviewService(): CanvasTextPreviewService {
  return new LocalCanvasTextPreviewService();
}

class LocalCanvasTextPreviewService implements CanvasTextPreviewService {
  private readonly rasterPreviewService = createCanvasRasterPreviewService({
    generationConcurrency: CANVAS_TEXT_PREVIEW_VARIANT_CONCURRENCY,
    metadataConcurrency: CANVAS_TEXT_PREVIEW_METADATA_CONCURRENCY
  });
  private readonly inFlightVariants = new Map<string, Promise<{ absolutePath: string }>>();

  async saveSource(input: CanvasTextPreviewSaveSourceInput): Promise<{
    ok: true;
    source: CanvasTextPreviewSourceView & { available: true };
  }> {
    const absoluteSourcePath = await resolveNoSymlinkProjectPathForWrite(
      input.projectRoot,
      canvasTextPreviewSourceProjectPath(input)
    );
    await writeFileAtomic(absoluteSourcePath, await readFile(input.sourceTemporaryPath));
    return {
      ok: true,
      source: {
        projectRelativePath: input.projectRelativePath,
        fingerprint: input.fingerprint,
        available: true
      }
    };
  }

  async readSources(input: CanvasTextPreviewReadSourcesInput): Promise<{ sources: Record<string, CanvasTextPreviewSourceView> }> {
    const entries = await Promise.all(input.sources.map(async (source) => {
      const sourcePath = canvasTextPreviewSourceProjectPath({
        canvasId: input.canvasId,
        projectRelativePath: source.projectRelativePath,
        fingerprint: source.fingerprint
      });
      const available = await existingFilePath(input.projectRoot, sourcePath) !== undefined;
      return [source.projectRelativePath, {
        projectRelativePath: source.projectRelativePath,
        fingerprint: source.fingerprint,
        available
      }] as const;
    }));
    return { sources: Object.fromEntries(entries) };
  }

  async resolveVariant(input: CanvasTextPreviewResolveVariantInput): Promise<{ absolutePath: string }> {
    const key = canvasTextPreviewVariantInFlightKey(input);
    const existing = this.inFlightVariants.get(key);
    if (existing) {
      return existing;
    }
    const promise = this.resolveVariantNow(input).finally(() => {
      if (this.inFlightVariants.get(key) === promise) {
        this.inFlightVariants.delete(key);
      }
    });
    this.inFlightVariants.set(key, promise);
    return promise;
  }

  private async resolveVariantNow(input: CanvasTextPreviewResolveVariantInput): Promise<{ absolutePath: string }> {
    const sourceProjectPath = canvasTextPreviewSourceProjectPath(input);
    const absoluteSourcePath = await existingFilePath(input.projectRoot, sourceProjectPath);
    if (!absoluteSourcePath) {
      throw new CanvasTextPreviewServiceError(
        'canvas_text_preview_source_missing',
        `Canvas text preview source is not available: ${input.projectRelativePath}`,
        {
          projectRelativePath: input.projectRelativePath,
          canvasId: input.canvasId,
          fingerprint: input.fingerprint
        }
      );
    }
    const variantProjectPath = canvasTextPreviewVariantProjectPath(input);
    const existingVariant = await existingFilePath(input.projectRoot, variantProjectPath);
    if (existingVariant) {
      return { absolutePath: existingVariant };
    }
    const absoluteVariantPath = await resolveNoSymlinkProjectPathForWrite(input.projectRoot, variantProjectPath);
    await this.rasterPreviewService.generate({
      sourceAbsolutePath: absoluteSourcePath,
      outputAbsolutePath: absoluteVariantPath,
      width: input.width,
      outputFormat: 'png'
    });
    return {
      absolutePath: await resolveNoSymlinkExistingProjectPath(input.projectRoot, variantProjectPath)
    };
  }
}

function canvasTextPreviewVariantInFlightKey(input: CanvasTextPreviewResolveVariantInput): string {
  return [
    input.projectRoot,
    input.canvasId,
    input.projectRelativePath,
    input.fingerprint,
    String(input.width)
  ].join('\0');
}

class CanvasTextPreviewServiceError extends Error {
  constructor(
    readonly code: 'canvas_text_preview_source_missing',
    message: string,
    readonly fields: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CanvasTextPreviewServiceError';
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
    if (typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
