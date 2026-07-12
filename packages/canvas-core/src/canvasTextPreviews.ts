import { projectRelativePathCacheKey } from '@debrute/project-core/projectCacheKeys';

export interface CanvasTextPreviewPathInput {
  canvasId: string;
  projectRelativePath: string;
  fingerprint: string;
}

export function canvasTextPreviewSourceProjectPath(input: CanvasTextPreviewPathInput): string {
  return `${canvasTextPreviewBaseProjectPath(input)}/source.png`;
}

export function canvasTextPreviewVariantProjectPath(input: CanvasTextPreviewPathInput & { width: number }): string {
  assertPositiveInteger(input.width, 'Canvas text preview width must be a positive integer.');
  return `${canvasTextPreviewBaseProjectPath(input)}/preview-w${input.width}.png`;
}

function canvasTextPreviewBaseProjectPath(input: CanvasTextPreviewPathInput): string {
  const canvasId = normalizeCanvasTextPreviewCanvasId(input.canvasId);
  const sourceKey = projectRelativePathCacheKey(input.projectRelativePath);
  const fingerprintKey = normalizeCanvasTextPreviewFingerprint(input.fingerprint);
  return `.debrute/cache/canvas-text-previews/${canvasId}/${sourceKey}/${fingerprintKey}`;
}

function normalizeCanvasTextPreviewCanvasId(canvasId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(canvasId) || canvasId === '.' || canvasId === '..') {
    throw new Error('Canvas text preview canvas id must be a valid id.');
  }
  return canvasId;
}

function normalizeCanvasTextPreviewFingerprint(fingerprint: string): string {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new Error('Canvas text preview fingerprint must be a non-empty string.');
  }
  return assertCachePathSegment(encodeURIComponent(fingerprint), 'Canvas text preview fingerprint key');
}

function assertCachePathSegment(segment: string, label: string): string {
  if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
    throw new Error(`${label} must be a filesystem-safe path segment.`);
  }
  return segment;
}

function assertPositiveInteger(value: number, message: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(message);
  }
}
