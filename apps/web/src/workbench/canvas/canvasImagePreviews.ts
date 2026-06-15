import type { ProjectedCanvasNode } from '@debrute/canvas-core';

export const CANVAS_IMAGE_PREVIEW_MIN_SCALE = 1 / 32;
export const CANVAS_IMAGE_PREVIEW_MAX_SCALE = 1;
export const CANVAS_IMAGE_PREVIEW_RESOURCE_SETTLE_MS = 500;

export interface CanvasImageSource {
  src: string;
  previewWidth: number;
}

export interface CanvasLoadedImage extends CanvasImageSource {
  loadKey: string;
}

export function canvasImageSource(input: {
  node: ProjectedCanvasNode;
  cameraZoom: number;
  devicePixelRatio: number;
}): CanvasImageSource | undefined {
  if (input.node.availability.state !== 'available' || !input.node.availability.fileUrl) {
    return undefined;
  }
  if (!isPreviewableImageNode(input.node)) {
    return undefined;
  }
  const previewWidth = canvasImagePreviewWidthForNode(input.node, input.cameraZoom, input.devicePixelRatio);
  const src = canvasImagePreviewUrl(
    input.node.availability.fileUrl,
    input.node.projectRelativePath,
    input.node.availability.revision,
    previewWidth
  ).toString();
  return {
    src,
    previewWidth
  };
}

export function canvasImagePreviewSteppedScale(screenScale: number): number {
  assertPositiveFinite(screenScale, 'Canvas image preview screen scale must be a positive finite number.');
  const stepIndex = Math.ceil(Math.log2(screenScale) * 2);
  return 2 ** (stepIndex / 2);
}

export function canvasImagePreviewWidth(input: {
  nodeDisplayWidth: number;
  sourceWidth: number;
  imageResourceZoom: number;
  devicePixelRatio: number;
}): number {
  assertPositiveFinite(input.nodeDisplayWidth, 'Canvas image preview node display width must be a positive finite number.');
  assertPositiveFinite(input.sourceWidth, 'Canvas image preview source width must be a positive finite number.');
  assertPositiveFinite(input.imageResourceZoom, 'Canvas image preview resource zoom must be a positive finite number.');
  assertPositiveFinite(input.devicePixelRatio, 'Canvas image devicePixelRatio must be a positive finite number.');

  const screenScale = input.imageResourceZoom * (input.nodeDisplayWidth / input.sourceWidth);
  const steppedScale = canvasImagePreviewSteppedScale(screenScale);
  const clampedScale = Math.min(
    CANVAS_IMAGE_PREVIEW_MAX_SCALE,
    Math.max(CANVAS_IMAGE_PREVIEW_MIN_SCALE, steppedScale)
  );
  const previewWidth = Math.ceil(Math.min(
    input.sourceWidth * clampedScale * input.devicePixelRatio,
    input.sourceWidth
  ));
  if (!Number.isInteger(previewWidth) || previewWidth <= 0) {
    throw new Error('Canvas image preview width must be a positive integer.');
  }
  return previewWidth;
}

export function canvasImagePreviewWidthForNode(
  node: Pick<ProjectedCanvasNode, 'width' | 'availability'>,
  cameraZoom: number,
  devicePixelRatio: number
): number {
  if (node.availability.state !== 'available') {
    throw new Error('Canvas previewable image nodes must be available.');
  }
  const sourceWidth = node.availability.canvasImagePreviewSourceWidth;
  if (typeof sourceWidth !== 'number' || !Number.isFinite(sourceWidth) || sourceWidth <= 0) {
    throw new Error('Canvas previewable image nodes must include a positive finite source width.');
  }
  return canvasImagePreviewWidth({
    nodeDisplayWidth: node.width,
    sourceWidth,
    imageResourceZoom: cameraZoom,
    devicePixelRatio
  });
}

function canvasImagePreviewUrl(fileUrl: string, projectRelativePath: string, revision: string, width: number): URL {
  const sourceUrl = new URL(fileUrl);
  const projectMatch = sourceUrl.pathname.match(/^\/api\/projects\/([^/]+)\//);
  if (!projectMatch?.[1]) {
    throw new Error('Canvas preview file URL must include a project id.');
  }
  const url = new URL(`/api/projects/${projectMatch[1]}/canvas-image-preview`, sourceUrl);
  url.searchParams.set('path', projectRelativePath);
  url.searchParams.set('v', revision);
  url.searchParams.set('w', String(width));
  const daemonToken = sourceUrl.searchParams.get('debrute-token');
  if (daemonToken) {
    url.searchParams.set('debrute-token', daemonToken);
  }
  return url;
}

function isPreviewableImageNode(node: ProjectedCanvasNode): boolean {
  if (node.nodeKind !== 'file' || node.mediaKind !== 'image' || node.availability.state !== 'available') {
    return false;
  }
  return node.availability.canvasImagePreviewable === true;
}

function assertPositiveFinite(value: number, message: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }
}
