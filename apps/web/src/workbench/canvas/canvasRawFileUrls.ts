const CANVAS_RAW_FILE_URL = /^\/api\/projects\/([^/?#]+)\/files\/raw\/[^?#]+\?v=[^&#]+$/;

export function canvasRawFileProjectId(fileUrl: string): string {
  const match = CANVAS_RAW_FILE_URL.exec(fileUrl);
  if (!match?.[1]) {
    throw new Error('Canvas file URL must be a relative Runtime raw-file URL.');
  }
  return match[1];
}
