import { extname } from 'node:path';
import {
  projectRelativePathCacheKey,
  projectRevisionCacheKey
} from '@debrute/project-core';
import { assertCanvasDocumentId } from '@debrute/canvas-core';

export type CanvasVideoPreviewSourceKind = 'initial-poster' | 'playback-frame';

export const CANVAS_VIDEO_PREVIEW_VERSION = 'v1';

export interface CanvasVideoPreviewPathInput {
  canvasId: string;
  projectRelativePath: string;
  videoRevision: string;
  sourceKind: CanvasVideoPreviewSourceKind;
  sourceKey: string;
}

export function canvasVideoPreviewSourceProjectPath(input: CanvasVideoPreviewPathInput & { sourceExtension: string }): string {
  return `${canvasVideoPreviewSourceDirectoryProjectPath(input)}/source${normalizeSourceExtension(input.sourceExtension)}`;
}

export function canvasVideoPreviewVariantProjectPath(input: CanvasVideoPreviewPathInput & { width: number }): string {
  assertPositiveInteger(input.width, 'Canvas video preview width must be a positive integer.');
  return `${canvasVideoPreviewSourceDirectoryProjectPath(input)}/preview-w${input.width}.jpg`;
}

export function canvasVideoPreviewSourceDirectoryProjectPath(input: CanvasVideoPreviewPathInput): string {
  const canvasId = assertCanvasDocumentId(input.canvasId);
  const videoPathKey = projectRelativePathCacheKey(input.projectRelativePath);
  const revisionKey = projectRevisionCacheKey(input.videoRevision);
  const sourceKind = normalizeSourceKind(input.sourceKind);
  const sourceKey = normalizeCanvasVideoPreviewSourceKey(input.sourceKey);
  return `.debrute/cache/canvas-video-previews/${canvasId}/${videoPathKey}/${revisionKey}/${sourceKind}/${sourceKey}`;
}

export function canvasVideoInitialExplicitSourceKey(input: {
  posterProjectRelativePath: string;
  posterRevision: string;
}): string {
  return normalizeCanvasVideoPreviewSourceKey([
    CANVAS_VIDEO_PREVIEW_VERSION,
    'explicit',
    projectRelativePathCacheKey(input.posterProjectRelativePath),
    projectRevisionCacheKey(input.posterRevision)
  ].join('--'));
}

export function canvasVideoInitialAutoSourceKey(videoRevision: string): string {
  return normalizeCanvasVideoPreviewSourceKey([
    CANVAS_VIDEO_PREVIEW_VERSION,
    'auto-0s',
    projectRevisionCacheKey(videoRevision)
  ].join('--'));
}

export function canvasVideoPlaybackFrameSourceKey(currentTimeSeconds: number): string {
  return normalizeCanvasVideoPreviewSourceKey([
    CANVAS_VIDEO_PREVIEW_VERSION,
    'playback',
    canvasVideoPreviewTimestampKey(currentTimeSeconds)
  ].join('--'));
}

export function canvasVideoPreviewTimestampKey(currentTimeSeconds: number): string {
  assertNonNegativeFinite(currentTimeSeconds, 'Canvas video preview timestamp must be a non-negative finite number.');
  return `t-${encodeURIComponent(String(currentTimeSeconds))}`;
}

export function sourceExtensionForProjectPath(projectRelativePath: string): string {
  const extension = extname(projectRelativePath).toLowerCase();
  return normalizeSourceExtension(extension || '.jpg');
}

function normalizeSourceKind(sourceKind: CanvasVideoPreviewSourceKind): CanvasVideoPreviewSourceKind {
  if (sourceKind !== 'initial-poster' && sourceKind !== 'playback-frame') {
    throw new Error(`Invalid Canvas video preview source kind: ${sourceKind}`);
  }
  return sourceKind;
}

function normalizeCanvasVideoPreviewSourceKey(sourceKey: string): string {
  if (!sourceKey || sourceKey === '.' || sourceKey === '..' || sourceKey.includes('/') || sourceKey.includes('\\')) {
    throw new Error('Canvas video preview source key must be a filesystem-safe path segment.');
  }
  return sourceKey;
}

function normalizeSourceExtension(extension: string): string {
  if (!/^\.[a-z0-9]+$/.test(extension)) {
    throw new Error(`Canvas video preview source extension must be safe: ${extension}`);
  }
  return extension;
}

function assertPositiveInteger(value: number, message: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(message);
  }
}

function assertNonNegativeFinite(value: number, message: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(message);
  }
}
