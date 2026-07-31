import { canvasRawFileProjectId } from './canvasRawFileUrls';

export interface CanvasImageSource {
  src: string;
  previewWidth: number;
}

export interface CanvasLoadedImage extends CanvasImageSource {
  loadKey: string;
}

export function canvasImageSource(input: {
  projectRelativePath: string;
  fileUrl: string;
  revision: string;
  previewWidth: number;
}): CanvasImageSource {
  const src = canvasImagePreviewUrl(
    input.fileUrl,
    input.projectRelativePath,
    input.revision,
    input.previewWidth
  );
  return {
    src,
    previewWidth: input.previewWidth
  };
}

function canvasImagePreviewUrl(fileUrl: string, projectRelativePath: string, revision: string, width: number): string {
  const projectId = canvasRawFileProjectId(fileUrl);
  const params = new URLSearchParams({
    path: projectRelativePath,
    v: revision,
    w: String(width)
  });
  return `/api/projects/${projectId}/canvas-image-preview?${params.toString()}`;
}
