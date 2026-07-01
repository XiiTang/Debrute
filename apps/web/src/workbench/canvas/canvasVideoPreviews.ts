import {
  canvasRasterPreviewWidth,
  type ProjectedCanvasNode
} from '@debrute/canvas-core';

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
    }).toString()
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
}): URL {
  const sourceUrl = new URL(input.fileUrl);
  const projectMatch = sourceUrl.pathname.match(/^\/api\/projects\/([^/]+)\//);
  if (!projectMatch?.[1]) {
    throw new Error('Canvas video preview file URL must include a project id.');
  }
  const url = new URL(`/api/projects/${projectMatch[1]}/canvas-video-preview`, sourceUrl);
  url.searchParams.set('canvasId', input.canvasId);
  url.searchParams.set('path', input.projectRelativePath);
  url.searchParams.set('videoRevision', input.videoRevision);
  url.searchParams.set('t', String(input.currentTimeSeconds));
  url.searchParams.set('sourceKey', input.sourceKey);
  url.searchParams.set('w', String(input.width));
  const daemonToken = sourceUrl.searchParams.get('debrute-token');
  if (daemonToken) {
    url.searchParams.set('debrute-token', daemonToken);
  }
  return url;
}
