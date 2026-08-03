export interface CanvasImageSource {
  src: string;
  previewWidth: number;
}

export function canvasImageSource(input: {
  projectId: string;
  projectRelativePath: string;
  sourceRevision: string;
  previewWidth: number;
}): CanvasImageSource {
  const src = canvasImagePreviewUrl(
    input.projectId,
    input.projectRelativePath,
    input.sourceRevision,
    input.previewWidth
  );
  return {
    src,
    previewWidth: input.previewWidth
  };
}

function canvasImagePreviewUrl(projectId: string, projectRelativePath: string, revision: string, width: number): string {
  const params = new URLSearchParams({
    path: projectRelativePath,
    sourceRevision: revision,
    w: String(width)
  });
  return `/api/projects/${projectId}/canvas-image-preview?${params.toString()}`;
}
