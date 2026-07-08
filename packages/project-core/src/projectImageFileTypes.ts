export type ProjectImageMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/avif'
  | 'image/tiff'
  | 'image/svg+xml';

export interface ProjectImageFileType {
  mimeType: ProjectImageMimeType;
  preferredExtension: string;
  extensions: readonly string[];
}

const projectImageFileTypes: readonly ProjectImageFileType[] = [
  imageType('image/png', 'png', ['.png']),
  imageType('image/jpeg', 'jpg', ['.jpg', '.jpeg', '.jpe', '.jfif']),
  imageType('image/webp', 'webp', ['.webp']),
  imageType('image/avif', 'avif', ['.avif']),
  imageType('image/tiff', 'tiff', ['.tif', '.tiff']),
  imageType('image/svg+xml', 'svg', ['.svg', '.svgz'])
] as const;

const projectImageMimeTypes = new Set<ProjectImageMimeType>(
  projectImageFileTypes.map((entry) => entry.mimeType)
);

export function projectImageFileTypeForPath(projectRelativePath: string): ProjectImageFileType | undefined {
  const lowerPath = projectRelativePath.replaceAll('\\', '/').toLowerCase();
  return projectImageFileTypes.find((entry) => (
    entry.extensions.some((extension) => lowerPath.endsWith(extension))
  ));
}

export function projectImageMimeTypeFromPath(projectRelativePath: string): ProjectImageMimeType | undefined {
  return projectImageFileTypeForPath(projectRelativePath)?.mimeType;
}

export function projectImageMimeTypeMatchesPath(mimeType: string | undefined, projectRelativePath: string): boolean {
  const expectedMimeType = projectImageMimeTypeFromPath(projectRelativePath);
  return expectedMimeType !== undefined && normalizeImageMimeType(mimeType ?? '') === expectedMimeType;
}

export function isSupportedProjectImagePath(projectRelativePath: string): boolean {
  return projectImageFileTypeForPath(projectRelativePath) !== undefined;
}

export function isCanvasPreviewableProjectImagePath(projectRelativePath: string): boolean {
  return isSupportedProjectImagePath(projectRelativePath);
}

export function isProjectImageReferencePath(projectRelativePath: string): boolean {
  return isSupportedProjectImagePath(projectRelativePath);
}

export function projectImageExtensionForMimeType(mimeType: string): string | undefined {
  return projectImageFileTypes.find((entry) => entry.mimeType === normalizeImageMimeType(mimeType))?.preferredExtension;
}

export function projectImageMimeTypeFromDataUrl(value: string): ProjectImageMimeType | undefined {
  if (!value.startsWith('data:')) {
    return undefined;
  }
  const mimeType = normalizeImageMimeType(value.replace(/^data:/, '').split(';', 1)[0] ?? '');
  return mimeType && projectImageMimeTypes.has(mimeType) ? mimeType : undefined;
}

function imageType(
  mimeType: ProjectImageMimeType,
  preferredExtension: string,
  extensions: readonly string[]
): ProjectImageFileType {
  return { mimeType, preferredExtension, extensions };
}

function normalizeImageMimeType(mimeType: string): ProjectImageMimeType | undefined {
  const normalized = mimeType.trim().toLowerCase();
  return projectImageMimeTypes.has(normalized as ProjectImageMimeType)
    ? normalized as ProjectImageMimeType
    : undefined;
}
