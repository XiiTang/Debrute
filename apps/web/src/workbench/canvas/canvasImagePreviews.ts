import { CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS, type ProjectedCanvasNode } from '@debrute/canvas-core';

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
  const previewWidth = canvasImagePreviewBucketForNode(input.node, input.cameraZoom, input.devicePixelRatio);
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

export function canvasImagePreviewBucket(targetWidth: number): number {
  if (!Number.isFinite(targetWidth) || targetWidth <= 0) {
    throw new Error('Canvas image preview target width must be a positive finite number.');
  }
  return CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS.find((bucket) => bucket >= targetWidth)
    ?? CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS[3];
}

export function canvasImagePreviewBucketForNode(
  node: Pick<ProjectedCanvasNode, 'width' | 'availability'>,
  cameraZoom: number,
  devicePixelRatio: number
): number {
  return canvasImagePreviewBucket(canvasImagePreviewTargetWidth(node, cameraZoom, devicePixelRatio));
}

function canvasImagePreviewTargetWidth(
  node: Pick<ProjectedCanvasNode, 'width' | 'availability'>,
  cameraZoom: number,
  devicePixelRatio: number
): number {
  const targetWidth = node.width * cameraZoom * devicePixelRatio;
  if (node.availability.state !== 'available') {
    return targetWidth;
  }
  const sourceWidth = node.availability.canvasImagePreviewSourceWidth;
  if (typeof sourceWidth !== 'number' || !Number.isFinite(sourceWidth) || sourceWidth <= 0) {
    throw new Error('Canvas previewable image nodes must include a positive finite source width.');
  }
  return Math.min(targetWidth, sourceWidth);
}

function canvasImagePreviewUrl(fileUrl: string, projectRelativePath: string, revision: string, width: number): URL {
  const projectMatch = new URL(fileUrl).pathname.match(/^\/api\/projects\/([^/]+)\//);
  if (!projectMatch?.[1]) {
    throw new Error('Canvas preview file URL must include a project id.');
  }
  const url = new URL(`/api/projects/${projectMatch[1]}/canvas-image-preview`, fileUrl);
  url.searchParams.set('path', projectRelativePath);
  url.searchParams.set('v', revision);
  url.searchParams.set('w', String(width));
  return url;
}

function isPreviewableImageNode(node: ProjectedCanvasNode): boolean {
  if (node.nodeKind !== 'file' || node.mediaKind !== 'image' || node.availability.state !== 'available') {
    return false;
  }
  return node.availability.canvasImagePreviewable === true;
}
