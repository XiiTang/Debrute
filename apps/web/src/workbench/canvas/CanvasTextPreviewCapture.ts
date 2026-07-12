import { toBlob } from 'html-to-image';
import type { ProjectTextLanguageId } from '@debrute/project-core';
import {
  canvasTextPreviewFailureFromUnknown,
  type CanvasTextPreviewFailureFields
} from './CanvasTextPreviewFailure';
import {
  assertCanvasTextPreviewSnapshot,
  type CanvasTextPreviewSnapshot
} from './CanvasTextPreviewSnapshot';

export const CANVAS_TEXT_PREVIEW_SOURCE_SCALE = 4;

const CANVAS_TEXT_PREVIEW_VISUAL_VERSION = 'canvas-text-preview-v13';

export interface CanvasTextPreviewCandidate {
  canvasId: string;
  projectRelativePath: string;
  content: string;
  language: ProjectTextLanguageId;
  wordWrap: boolean;
  contentCssWidth: number;
  contentCssHeight: number;
  scrollTop: number;
  scrollLeft: number;
  styleKey: string;
}

export interface CanvasTextPreviewTarget extends CanvasTextPreviewCandidate {
  fingerprint: string;
}

export interface CanvasTextPreviewRasterResult {
  sourcePng: Blob;
  snapshotWidth: number;
  snapshotHeight: number;
  snapshotBytes: number;
  rasterDurationMs: number;
}

export async function captureCanvasTextPreviewSource(input: {
  snapshot: CanvasTextPreviewSnapshot;
  fields: CanvasTextPreviewFailureFields;
}): Promise<CanvasTextPreviewRasterResult> {
  assertCanvasTextPreviewSnapshot(input.snapshot, input.fields);
  const startedAt = performance.now();
  try {
    const sourcePng = await toBlob(input.snapshot.root, {
      pixelRatio: CANVAS_TEXT_PREVIEW_SOURCE_SCALE,
      width: input.snapshot.width,
      height: input.snapshot.height,
      backgroundColor: 'transparent',
      skipFonts: true,
      includeStyleProperties: []
    });
    if (!sourcePng) {
      throw new Error('Canvas text preview raster did not produce a PNG blob.');
    }
    return {
      sourcePng,
      snapshotWidth: input.snapshot.width,
      snapshotHeight: input.snapshot.height,
      snapshotBytes: input.snapshot.serializedBytes,
      rasterDurationMs: performance.now() - startedAt
    };
  } catch (error) {
    throw canvasTextPreviewFailureFromUnknown('raster_failed', {
      ...input.fields,
      snapshotWidth: input.snapshot.width,
      snapshotHeight: input.snapshot.height,
      snapshotBytes: input.snapshot.serializedBytes,
      durationMs: performance.now() - startedAt
    }, error);
  }
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
