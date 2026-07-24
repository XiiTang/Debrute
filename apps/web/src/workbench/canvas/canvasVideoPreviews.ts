import {
  canvasRasterPreviewWidth,
  type ProjectedCanvasNode
} from '@debrute/canvas-core';
import { canvasRawFileProjectId } from './canvasRawFileUrls';

export interface CanvasVideoPreviewSource {
  src: string;
  previewWidth: number;
}

export function canvasVideoPreviewSource(input: {
  canvasId: string;
  node: ProjectedCanvasNode;
  sourceKey: string;
  sourceWidth: number;
  currentTimeSeconds: number;
  resourceZoom: number;
  devicePixelRatio: number;
}): CanvasVideoPreviewSource | undefined {
  if (input.node.availability.state !== 'available' || !input.node.availability.fileUrl) {
    return undefined;
  }
  const previewWidth = canvasVideoPreviewWidthForNode({
    nodeDisplayWidth: input.node.width,
    sourceWidth: input.sourceWidth,
    resourceZoom: input.resourceZoom,
    devicePixelRatio: input.devicePixelRatio
  });
  return {
    previewWidth,
    src: canvasVideoPreviewUrl({
      fileUrl: input.node.availability.fileUrl,
      canvasId: input.canvasId,
      projectRelativePath: input.node.projectRelativePath,
      videoRevision: input.node.availability.revision,
      currentTimeSeconds: input.currentTimeSeconds,
      sourceKey: input.sourceKey,
      width: previewWidth
    })
  };
}

export function canvasVideoPreviewWidthForNode(input: {
  nodeDisplayWidth: number;
  sourceWidth: number;
  resourceZoom: number;
  devicePixelRatio: number;
}): number {
  return canvasRasterPreviewWidth(input);
}

export function canvasVideoPreviewUrl(input: {
  fileUrl: string;
  canvasId: string;
  projectRelativePath: string;
  videoRevision: string;
  currentTimeSeconds: number;
  sourceKey: string;
  width: number;
}): string {
  const projectId = canvasRawFileProjectId(input.fileUrl);
  const params = new URLSearchParams({
    canvasId: input.canvasId,
    path: input.projectRelativePath,
    videoRevision: input.videoRevision,
    t: String(input.currentTimeSeconds),
    sourceKey: input.sourceKey,
    w: String(input.width)
  });
  return `/api/projects/${projectId}/canvas-video-preview?${params.toString()}`;
}
