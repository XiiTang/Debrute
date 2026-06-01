import { CANVAS_IMAGE_PREVIEW_WIDTH_BUCKETS, type ProjectedCanvasNode } from '@axis/canvas-core';

export const CANVAS_IMAGE_PREVIEW_RESOURCE_SETTLE_MS = 500;

export interface CanvasLoadedImage {
  src: string;
  loadKey: string;
}

export function shouldUpdateCanvasImageResourceZoom(input: {
  imagePreviewsEnabled: boolean;
  nextZoom: number;
  currentResourceZoom: number;
  hasPendingTimer: boolean;
}): boolean {
  return input.imagePreviewsEnabled
    && (input.nextZoom !== input.currentResourceZoom || input.hasPendingTimer);
}

export function canvasImageRenderSources(input: {
  selectedSrc: string | undefined;
  loadKey: string | undefined;
  loadedImage: CanvasLoadedImage | undefined;
  loadError?: string | undefined;
}): {
  loadedImage?: CanvasLoadedImage;
  pendingImage?: CanvasLoadedImage;
  errorOverlay?: { message: string };
} {
  if (!input.selectedSrc || !input.loadKey) {
    return {};
  }
  if (!input.loadedImage) {
    return {
      pendingImage: {
        src: input.selectedSrc,
        loadKey: input.loadKey
      }
    };
  }
  if (input.loadError) {
    return {
      loadedImage: input.loadedImage,
      errorOverlay: { message: input.loadError }
    };
  }
  if (input.loadedImage.loadKey === input.loadKey) {
    return {
      loadedImage: input.loadedImage
    };
  }
  return {
    loadedImage: input.loadedImage,
    pendingImage: {
      src: input.selectedSrc,
      loadKey: input.loadKey
    }
  };
}

export function canvasImageSourceUrl(input: {
  node: ProjectedCanvasNode;
  imagePreviewsEnabled: boolean;
  viewportZoom: number;
  devicePixelRatio: number;
}): string | undefined {
  if (input.node.availability.state !== 'available' || !input.node.availability.fileUrl) {
    return undefined;
  }
  const bucket = input.imagePreviewsEnabled && isPreviewableImageNode(input.node)
    ? canvasImagePreviewBucketForNode(input.node, input.viewportZoom, input.devicePixelRatio)
    : undefined;
  const url = bucket === undefined
    ? new URL(input.node.availability.fileUrl)
    : canvasImagePreviewUrl(input.node.projectRelativePath, input.node.availability.revision, bucket);
  return url.toString();
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
  viewportZoom: number,
  devicePixelRatio: number
): number {
  return canvasImagePreviewBucket(canvasImagePreviewTargetWidth(node, viewportZoom, devicePixelRatio));
}

function canvasImagePreviewTargetWidth(
  node: Pick<ProjectedCanvasNode, 'width' | 'availability'>,
  viewportZoom: number,
  devicePixelRatio: number
): number {
  const targetWidth = node.width * viewportZoom * devicePixelRatio;
  if (node.availability.state !== 'available') {
    return targetWidth;
  }
  const sourceWidth = node.availability.canvasImagePreviewSourceWidth;
  if (typeof sourceWidth !== 'number' || !Number.isFinite(sourceWidth) || sourceWidth <= 0) {
    throw new Error('Canvas previewable image nodes must include a positive finite source width.');
  }
  return Math.min(targetWidth, sourceWidth);
}

function canvasImagePreviewUrl(projectRelativePath: string, revision: string, width: number): URL {
  const encodedPath = projectRelativePath.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`axis-canvas-preview://project/${encodedPath}`);
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
