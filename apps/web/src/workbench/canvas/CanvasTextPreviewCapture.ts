import type { ProjectTextLanguageId } from '@debrute/app-protocol';
import {
  canvasTextPreviewFailureFromUnknown,
  type CanvasTextPreviewFailureFields
} from './CanvasTextPreviewFailure';
import {
  type CanvasTextPreviewBuiltScene
} from './CanvasTextPreviewScene';
import type { CanvasTextRenderProfile } from './CanvasTextRenderProfile.js';
import { rasterizeCanvasTextPreviewInWorker } from './CanvasTextPreviewRasterWorkerClient.js';

export const CANVAS_TEXT_PREVIEW_SOURCE_SCALE = 4;

const CANVAS_TEXT_PREVIEW_VISUAL_VERSION = 'canvas-text-preview-v15';

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
  sceneWidth: number;
  sceneHeight: number;
  rasterDurationMs: number;
}

export async function captureCanvasTextPreviewSource(input: {
  builtScene: CanvasTextPreviewBuiltScene;
  document: Document;
  renderProfile: CanvasTextRenderProfile;
  fields: CanvasTextPreviewFailureFields;
}): Promise<CanvasTextPreviewRasterResult> {
  const startedAt = performance.now();
  try {
    const font = await input.renderProfile.prepare(input.document);
    const sourcePng = await rasterizeCanvasTextPreviewInWorker({
      scene: input.builtScene.scene,
      fontResourceKey: font.identity,
      fontFaces: font.faces,
      width: input.builtScene.width,
      height: input.builtScene.height,
      scale: CANVAS_TEXT_PREVIEW_SOURCE_SCALE
    });
    if (sourcePng.type !== 'image/png') {
      throw new Error('Canvas text preview raster did not produce a PNG blob.');
    }
    return {
      sourcePng,
      sceneWidth: input.builtScene.width,
      sceneHeight: input.builtScene.height,
      rasterDurationMs: performance.now() - startedAt
    };
  } catch (error) {
    throw canvasTextPreviewFailureFromUnknown('raster_failed', {
      ...input.fields,
      sceneWidth: input.builtScene.width,
      sceneHeight: input.builtScene.height,
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
