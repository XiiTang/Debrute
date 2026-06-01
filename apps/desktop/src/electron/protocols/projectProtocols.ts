import { CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS } from '@axis/canvas-core';
import { projectFileRevision } from '@axis/project-core';

export const PROJECT_FILE_PROTOCOL = 'axis-project-file';
export const CANVAS_PREVIEW_PROTOCOL = 'axis-canvas-preview';
const CANVAS_PREVIEW_WIDTH_PARAMS = new Set(CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS.map((width) => String(width)));

export function projectRelativePathFromProtocolUrl(rawUrl: string, protocolName: string): string {
  const url = projectProtocolUrl(rawUrl, protocolName, 'project file');
  const encodedPath = url.pathname.replace(/^\/+/, '');
  if (!encodedPath) {
    throw new Error(`Project file URL is missing a path: ${rawUrl}`);
  }
  return encodedPath.split('/').map(decodeURIComponent).join('/');
}

export function projectFileRequestFromProtocolUrl(rawUrl: string): { projectRelativePath: string; revision: string } {
  const url = projectProtocolUrl(rawUrl, PROJECT_FILE_PROTOCOL, 'project file');
  assertOnlySearchParams(url, ['v'], 'project file');
  return {
    projectRelativePath: projectRelativePathFromProtocolUrl(rawUrl, PROJECT_FILE_PROTOCOL),
    revision: requiredSearchParam(url, 'v', 'Project file URL is missing a revision', rawUrl)
  };
}

export function assertProjectFileRevision(input: {
  projectRelativePath: string;
  revision: string;
  size: number;
  mtimeMs: number;
}): void {
  const actualRevision = projectFileRevision(input.size, input.mtimeMs);
  if (actualRevision !== input.revision) {
    throw new Error(`Project file revision does not match source: ${input.projectRelativePath}`);
  }
}

export function canvasPreviewRequestFromProtocolUrl(rawUrl: string): { projectRelativePath: string; revision: string; width: number } {
  const url = projectProtocolUrl(rawUrl, CANVAS_PREVIEW_PROTOCOL, 'Canvas preview');
  assertOnlySearchParams(url, ['v', 'w'], 'Canvas preview');
  const revision = requiredSearchParam(url, 'v', 'Canvas preview URL is missing a revision', rawUrl);
  const widthParam = requiredSearchParam(url, 'w', 'Canvas preview URL is missing a width', rawUrl);
  if (!CANVAS_PREVIEW_WIDTH_PARAMS.has(widthParam)) {
    throw new Error(`Unsupported Canvas preview width: ${widthParam}`);
  }
  const width = Number(widthParam);
  return {
    projectRelativePath: projectRelativePathFromProtocolUrl(rawUrl, CANVAS_PREVIEW_PROTOCOL),
    revision,
    width
  };
}

function projectProtocolUrl(rawUrl: string, protocolName: string, label: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== `${protocolName}:` || url.hostname !== 'project') {
    throw new Error(`Invalid ${label} URL: ${rawUrl}`);
  }
  return url;
}

function assertOnlySearchParams(url: URL, allowedParams: string[], label: string): void {
  const allowed = new Set(allowedParams);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new Error(`Unexpected ${label} URL parameter: ${key}`);
    }
  }
  for (const key of allowed) {
    if (url.searchParams.getAll(key).length > 1) {
      throw new Error(`Unexpected duplicate ${label} URL parameter: ${key}`);
    }
  }
}

function requiredSearchParam(url: URL, key: string, message: string, rawUrl: string): string {
  const value = url.searchParams.get(key) ?? '';
  if (!value) {
    throw new Error(`${message}: ${rawUrl}`);
  }
  return value;
}
