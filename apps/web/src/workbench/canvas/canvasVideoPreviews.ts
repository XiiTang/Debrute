import type { CanvasVideoPreviewTarget } from './CanvasVideoPreviewTaskRegistry.js';

export function canvasVideoPreviewUrl(input: {
  target: CanvasVideoPreviewTarget;
  width: number;
}): string {
  const params = new URLSearchParams({
    path: input.target.projectRelativePath,
    sourceRevision: input.target.sourceRevision,
    frameTimeMs: String(input.target.frameTimeMs),
    w: String(input.width)
  });
  return `/api/workbench/bindings/${input.target.bindingId}/canvas-video-preview?${params.toString()}`;
}
