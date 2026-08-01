import type { CanvasTextFontDigest } from '../CanvasTextRenderProfile.js';

export const CANVAS_TEXT_FONT_SUBSET_CONTRACT_VERSION = 1;

export interface CanvasTextFontSubsetFaceRequest {
  readonly family: string;
  readonly weight: string;
  readonly sourceUrl: string;
  readonly digest: CanvasTextFontDigest;
}

export interface CanvasTextFontSubsetRequest {
  readonly type: 'subset';
  readonly contractVersion: typeof CANVAS_TEXT_FONT_SUBSET_CONTRACT_VERSION;
  readonly codepoints: ArrayBuffer;
  readonly faces: readonly CanvasTextFontSubsetFaceRequest[];
}

export interface CanvasTextFontSubsetFaceResult {
  readonly family: string;
  readonly weight: string;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly durationMs: number;
  readonly bytes: ArrayBuffer;
}

export interface CanvasTextFontSubsetSuccess {
  readonly type: 'success';
  readonly contractVersion: typeof CANVAS_TEXT_FONT_SUBSET_CONTRACT_VERSION;
  readonly durationMs: number;
  readonly peakLinearMemoryBytes: number;
  readonly faces: readonly CanvasTextFontSubsetFaceResult[];
}

export interface CanvasTextFontSubsetError {
  readonly type: 'error';
  readonly contractVersion: typeof CANVAS_TEXT_FONT_SUBSET_CONTRACT_VERSION;
  readonly message: string;
}

export type CanvasTextFontSubsetResponse =
  | CanvasTextFontSubsetSuccess
  | CanvasTextFontSubsetError;
