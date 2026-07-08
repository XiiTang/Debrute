import type { Dirent } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import {
  isCanvasPreviewableProjectImagePath,
  projectFileRevision,
  projectImageMimeTypeMatchesPath,
  projectRelativePathCacheKey,
  projectRevisionCacheKey,
  resolveProjectPath,
  type ProjectFileEntry
} from '@debrute/project-core';
import { readCanvasRasterPreviewMetadata } from './CanvasRasterPreviewService.js';

const CANVAS_IMAGE_PREVIEW_CACHE_PROJECT_PATH = '.debrute/cache/canvas-image-previews';

export async function reconcileCanvasImagePreviewCache(input: {
  projectRoot: string;
  files: ProjectFileEntry[];
}): Promise<void> {
  const expected = new Map<string, string>();
  for (const file of input.files) {
    if (file.kind !== 'file' || !isCanvasPreviewableProjectImagePath(file.projectRelativePath)) {
      continue;
    }
    const currentRevisionKey = await currentCanvasImagePreviewRevisionKey(input.projectRoot, file.projectRelativePath);
    if (!currentRevisionKey) {
      continue;
    }
    expected.set(
      projectRelativePathCacheKey(file.projectRelativePath),
      currentRevisionKey
    );
  }

  const sourceEntries = await cacheDirectoryEntries(
    resolveProjectPath(input.projectRoot, CANVAS_IMAGE_PREVIEW_CACHE_PROJECT_PATH)
  );
  for (const sourceEntry of sourceEntries) {
    const sourceCacheProjectPath = `${CANVAS_IMAGE_PREVIEW_CACHE_PROJECT_PATH}/${sourceEntry.name}`;
    if (!sourceEntry.isDirectory()) {
      await rm(resolveProjectPath(input.projectRoot, sourceCacheProjectPath), { recursive: true, force: true });
      continue;
    }
    const expectedRevision = expected.get(sourceEntry.name);
    if (!expectedRevision) {
      await rm(resolveProjectPath(input.projectRoot, sourceCacheProjectPath), { recursive: true, force: true });
      continue;
    }
    const revisionEntries = await readdir(resolveProjectPath(input.projectRoot, sourceCacheProjectPath), { withFileTypes: true });
    for (const revisionEntry of revisionEntries) {
      if (revisionEntry.name !== expectedRevision || !revisionEntry.isDirectory()) {
        await rm(resolveProjectPath(input.projectRoot, `${sourceCacheProjectPath}/${revisionEntry.name}`), { recursive: true, force: true });
      }
    }
  }
}

async function currentCanvasImagePreviewRevisionKey(
  projectRoot: string,
  projectRelativePath: string
): Promise<string | undefined> {
  const sourcePath = resolveProjectPath(projectRoot, projectRelativePath);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) {
    return undefined;
  }
  try {
    const metadata = await readCanvasRasterPreviewMetadata(sourcePath, projectRelativePath);
    if (!projectImageMimeTypeMatchesPath(metadata.mediaType, projectRelativePath)) {
      return undefined;
    }
    const sourceWidth = metadata.width;
    if (typeof sourceWidth !== 'number' || !Number.isFinite(sourceWidth) || sourceWidth <= 0) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return projectRevisionCacheKey(projectFileRevision(sourceStat.size, sourceStat.mtimeMs));
}

async function cacheDirectoryEntries(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
