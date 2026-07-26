import type { CanvasTextAppearance } from '@debrute/app-protocol';
import { canvasTextRenderProfileForAppearance } from './CanvasFontCatalog.js';

export const TEST_CANVAS_TEXT_APPEARANCE = {
  fontId: 'noto-sans-mono-cjk-sc',
  fontSizePx: 12,
  lineHeightRatio: 1.4,
  fontWeight: 400,
  letterSpacingPx: 0,
  ligatures: true
} as const satisfies CanvasTextAppearance;

export const DEFAULT_CANVAS_TEXT_RENDER_PROFILE = canvasTextRenderProfileForAppearance(
  TEST_CANVAS_TEXT_APPEARANCE
);
