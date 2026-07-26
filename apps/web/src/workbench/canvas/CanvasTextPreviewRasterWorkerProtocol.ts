import type { CanvasTextPreparedFontFace } from './CanvasTextRenderProfile.js';

export interface CanvasTextPreviewRasterScene {
  background: string;
  commands: CanvasTextPreviewRasterCommand[];
}

export type CanvasTextPreviewRasterCommand =
  | CanvasTextPreviewRasterRect
  | CanvasTextPreviewRasterText;

export interface CanvasTextPreviewRasterRect {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export interface CanvasTextPreviewRasterText {
  kind: 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  textX: number;
  textAlign: 'left' | 'center' | 'right';
  color: string;
  background: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
  fontStretch: string;
  fontKerning: string;
  fontVariantCaps: string;
  fontVariantLigatures: string;
  fontVariantNumeric: string;
  fontFeatureSettings: string;
  fontVariationSettings: string;
  fontOpticalSizing: string;
  fontSynthesis: string;
  letterSpacing: string;
  wordSpacing: string;
  textDecorationLine: string;
  textDecorationColor: string;
  textDecorationStyle: string;
}

export interface CanvasTextPreviewRasterRequest {
  scene: CanvasTextPreviewRasterScene;
  fontResourceKey: string;
  fontFaces: readonly CanvasTextPreparedFontFace[];
  width: number;
  height: number;
  scale: number;
}

export interface CanvasTextPreviewRasterWorkerRequest {
  id: number;
  scene: CanvasTextPreviewRasterScene;
  fontResourceKey: string;
  fontFaces?: readonly CanvasTextPreparedFontFace[] | undefined;
  width: number;
  height: number;
  scale: number;
}

export type CanvasTextPreviewRasterWorkerResponse =
  | { id: number; ok: true; sourcePng: Blob }
  | { id: number; ok: false; message: string };
