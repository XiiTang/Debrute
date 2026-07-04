import { toBlob } from 'html-to-image';
import type { ProjectTextLanguageId } from '@debrute/project-core';

export const CANVAS_TEXT_PREVIEW_SOURCE_SCALE = 4;

const CANVAS_TEXT_PREVIEW_VISUAL_VERSION = 'canvas-text-preview-v11';

export async function captureCanvasTextPreviewSource(input: {
  element: HTMLElement;
}): Promise<Blob> {
  const width = input.element.clientWidth;
  const height = input.element.clientHeight;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('Canvas text preview source element must have positive dimensions.');
  }
  const blob = await toBlob(input.element, {
    pixelRatio: CANVAS_TEXT_PREVIEW_SOURCE_SCALE,
    width,
    height,
    backgroundColor: 'transparent'
  });
  if (!blob) {
    throw new Error('Canvas text preview source capture did not produce a PNG blob.');
  }
  return blob;
}

export async function canvasTextPreviewFingerprint(input: {
  content: string;
  language: ProjectTextLanguageId;
  wordWrap: boolean;
  contentCssWidth: number;
  contentCssHeight: number;
  scrollTop: number;
  scrollLeft: number;
  styleKey: string;
}): Promise<string> {
  const payload = JSON.stringify({
    visualVersion: CANVAS_TEXT_PREVIEW_VISUAL_VERSION,
    content: input.content,
    language: input.language,
    wordWrap: input.wordWrap,
    contentCssWidth: input.contentCssWidth,
    contentCssHeight: input.contentCssHeight,
    scrollTop: input.scrollTop,
    scrollLeft: input.scrollLeft,
    sourceScale: CANVAS_TEXT_PREVIEW_SOURCE_SCALE,
    styleKey: input.styleKey
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
