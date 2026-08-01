export const CANVAS_NODE_PRESENTATION_SCALE = 10;
export const CANVAS_TEXT_TITLEBAR_CSS_HEIGHT = 32;

export interface CanvasTextPresentationGeometry {
  readonly presentationScale: number;
  readonly frameCssWidth: number;
  readonly frameCssHeight: number;
  readonly contentCssWidth: number;
  readonly contentCssHeight: number;
  readonly titlebarCssHeight: number;
}

export function canvasTextPresentationGeometry(input: {
  readonly width: number;
  readonly height: number;
}): CanvasTextPresentationGeometry {
  if (!Number.isFinite(input.width)
    || input.width <= 0
    || !Number.isFinite(input.height)
    || input.height <= 0) {
    throw new Error('Canvas text presentation geometry requires positive finite node dimensions.');
  }
  const frameCssWidth = Math.max(1, Math.round(input.width / CANVAS_NODE_PRESENTATION_SCALE));
  const frameCssHeight = Math.max(
    CANVAS_TEXT_TITLEBAR_CSS_HEIGHT + 1,
    Math.round(input.height / CANVAS_NODE_PRESENTATION_SCALE)
  );
  return {
    presentationScale: CANVAS_NODE_PRESENTATION_SCALE,
    frameCssWidth,
    frameCssHeight,
    contentCssWidth: frameCssWidth,
    contentCssHeight: frameCssHeight - CANVAS_TEXT_TITLEBAR_CSS_HEIGHT,
    titlebarCssHeight: CANVAS_TEXT_TITLEBAR_CSS_HEIGHT
  };
}
