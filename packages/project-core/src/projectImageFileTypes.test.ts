import { describe, expect, it } from 'vitest';

import {
  isCanvasPreviewableProjectImagePath,
  isProjectImageReferencePath,
  isSupportedProjectImagePath,
  projectImageExtensionForMimeType,
  projectImageMimeTypeFromDataUrl,
  projectImageMimeTypeFromPath,
  projectImageMimeTypeMatchesPath
} from './projectImageFileTypes.js';

describe('project image file types', () => {
  it('classifies supported project image formats through one registry', () => {
    const cases: Array<{ path: string; mimeType: string }> = [
      { path: 'assets/cover.png', mimeType: 'image/png' },
      { path: 'assets/photo.jpg', mimeType: 'image/jpeg' },
      { path: 'assets/photo.jpeg', mimeType: 'image/jpeg' },
      { path: 'assets/photo.jpe', mimeType: 'image/jpeg' },
      { path: 'assets/photo.jfif', mimeType: 'image/jpeg' },
      { path: 'assets/render.webp', mimeType: 'image/webp' },
      { path: 'assets/render.avif', mimeType: 'image/avif' },
      { path: 'assets/scan.tif', mimeType: 'image/tiff' },
      { path: 'assets/scan.tiff', mimeType: 'image/tiff' },
      { path: 'assets/icon.svg', mimeType: 'image/svg+xml' },
      { path: 'assets/icon.svgz', mimeType: 'image/svg+xml' },
      { path: 'ASSETS/PHOTO.AVIF', mimeType: 'image/avif' }
    ];

    for (const item of cases) {
      expect(projectImageMimeTypeFromPath(item.path)).toBe(item.mimeType);
      expect(isCanvasPreviewableProjectImagePath(item.path)).toBe(true);
      expect(isSupportedProjectImagePath(item.path)).toBe(true);
      expect(isProjectImageReferencePath(item.path)).toBe(true);
    }

    expect(projectImageMimeTypeFromDataUrl('data:image/png;base64,AAAA')).toBe('image/png');
    expect(projectImageMimeTypeFromDataUrl('data:image/svg+xml;charset=utf-8;base64,AAAA')).toBe('image/svg+xml');
    expect(projectImageMimeTypeFromDataUrl('data:image/avif;base64,AAAA')).toBe('image/avif');

    expect(projectImageExtensionForMimeType('image/png')).toBe('png');
    expect(projectImageExtensionForMimeType('image/jpeg')).toBe('jpg');
    expect(projectImageExtensionForMimeType('image/webp')).toBe('webp');
    expect(projectImageExtensionForMimeType('image/avif')).toBe('avif');
    expect(projectImageExtensionForMimeType('image/tiff')).toBe('tiff');
    expect(projectImageExtensionForMimeType('image/svg+xml')).toBe('svg');
    expect(projectImageMimeTypeMatchesPath('image/png', 'assets/cover.png')).toBe(true);
    expect(projectImageMimeTypeMatchesPath('IMAGE/PNG', 'assets/cover.png')).toBe(true);
    expect(projectImageMimeTypeMatchesPath('image/jpeg', 'assets/photo.jpe')).toBe(true);
    expect(projectImageMimeTypeMatchesPath('image/svg+xml', 'assets/icon.svgz')).toBe(true);
    expect(projectImageMimeTypeMatchesPath('image/jpeg', 'assets/cover.png')).toBe(false);
    expect(projectImageMimeTypeMatchesPath('image/gif', 'assets/cover.png')).toBe(false);
    expect(projectImageMimeTypeMatchesPath(undefined, 'assets/cover.png')).toBe(false);

    for (const unsupported of [
      'assets/animated.gif',
      'assets/internal.v',
      'assets/internal.vips',
      'assets/photo.heic',
      'assets/photo.heif',
      'assets/photo.jxl',
      'assets/photo.jp2',
      'assets/raw.cr2',
      'assets/page.pdf',
      'assets/unknown.bmp'
    ]) {
      expect(projectImageMimeTypeFromPath(unsupported)).toBeUndefined();
      expect(isCanvasPreviewableProjectImagePath(unsupported)).toBe(false);
      expect(isSupportedProjectImagePath(unsupported)).toBe(false);
      expect(isProjectImageReferencePath(unsupported)).toBe(false);
    }

    expect(projectImageMimeTypeFromDataUrl('data:image/gif;base64,AAAA')).toBeUndefined();
    expect(projectImageMimeTypeFromDataUrl('data:image/bmp;base64,AAAA')).toBeUndefined();
    expect(projectImageMimeTypeFromDataUrl('data:application/octet-stream;base64,AAAA')).toBeUndefined();
  });
});
