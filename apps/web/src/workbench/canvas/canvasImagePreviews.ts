export interface CanvasImageSource {
  src: string;
  previewWidth: number;
}

export function canvasImageSource(input: {
  bindingId: string;
  projectRelativePath: string;
  sourceRevision: string;
  previewWidth: number;
}): CanvasImageSource {
  const src = canvasImagePreviewUrl(
    input.bindingId,
    input.projectRelativePath,
    input.sourceRevision,
    input.previewWidth
  );
  return {
    src,
    previewWidth: input.previewWidth
  };
}

function canvasImagePreviewUrl(bindingId: string, projectRelativePath: string, revision: string, width: number): string {
  const params = new URLSearchParams({
    path: projectRelativePath,
    sourceRevision: revision,
    w: String(width)
  });
  return `/api/workbench/bindings/${bindingId}/canvas-image-preview?${params.toString()}`;
}
