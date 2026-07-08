import {
  CANVAS_RASTER_PREVIEW_MAX_SCALE,
  CANVAS_RASTER_PREVIEW_MIN_SCALE,
  canvasRasterPreviewSteppedScale,
  canvasRasterPreviewWidth,
  type ProjectedCanvasNode
} from '@debrute/canvas-core';

export const CANVAS_IMAGE_PREVIEW_MIN_SCALE = CANVAS_RASTER_PREVIEW_MIN_SCALE;
export const CANVAS_IMAGE_PREVIEW_MAX_SCALE = CANVAS_RASTER_PREVIEW_MAX_SCALE;

export interface CanvasImageSource {
  src: string;
  previewWidth: number;
}

export interface CanvasLoadedImage extends CanvasImageSource {
  loadKey: string;
}

export function canvasImageSource(input: {
  node: ProjectedCanvasNode;
  resourceZoom: number;
  devicePixelRatio: number;
}): CanvasImageSource | undefined {
  if (input.node.availability.state !== 'available' || !input.node.availability.fileUrl) {
    return undefined;
  }
  if (!isPreviewableImageNode(input.node)) {
    return undefined;
  }
  const previewWidth = canvasImagePreviewWidthForNode(input.node, input.resourceZoom, input.devicePixelRatio);
  const src = canvasImagePreviewUrl(
    input.node.availability.fileUrl,
    input.node.projectRelativePath,
    input.node.availability.revision,
    previewWidth
  );
  return {
    src,
    previewWidth
  };
}

export function canvasImagePreviewSteppedScale(screenScale: number): number {
  assertPositiveFinite(screenScale, 'Canvas image preview screen scale must be a positive finite number.');
  return canvasRasterPreviewSteppedScale(screenScale);
}

export function canvasImagePreviewWidth(input: {
  nodeDisplayWidth: number;
  sourceWidth: number;
  resourceZoom: number;
  devicePixelRatio: number;
}): number {
  assertPositiveFinite(input.nodeDisplayWidth, 'Canvas image preview node display width must be a positive finite number.');
  assertPositiveFinite(input.sourceWidth, 'Canvas image preview source width must be a positive finite number.');
  assertPositiveFinite(input.resourceZoom, 'Canvas image preview resource zoom must be a positive finite number.');
  assertPositiveFinite(input.devicePixelRatio, 'Canvas image devicePixelRatio must be a positive finite number.');

  const previewWidth = canvasRasterPreviewWidth(input);
  if (!Number.isInteger(previewWidth) || previewWidth <= 0) {
    throw new Error('Canvas image preview width must be a positive integer.');
  }
  return previewWidth;
}

export function canvasImagePreviewWidthForNode(
  node: Pick<ProjectedCanvasNode, 'width' | 'availability'>,
  resourceZoom: number,
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
    resourceZoom,
    devicePixelRatio
  });
}

function canvasImagePreviewUrl(fileUrl: string, projectRelativePath: string, revision: string, width: number): string {
  const sourceUrl = new URL(fileUrl, 'http://debrute.local');
  const projectMatch = sourceUrl.pathname.match(/^\/api\/projects\/([^/]+)\//);
  if (!projectMatch?.[1]) {
    throw new Error('Canvas preview file URL must include a project id.');
  }
  const params = new URLSearchParams({
    path: projectRelativePath,
    v: revision,
    w: String(width)
  });
  return `/api/projects/${projectMatch[1]}/canvas-image-preview?${params.toString()}`;
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
