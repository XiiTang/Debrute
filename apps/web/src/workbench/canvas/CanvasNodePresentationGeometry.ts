export const CANVAS_NODE_PRESENTATION_SCALE = 10;
export const CANVAS_NODE_TITLEBAR_CSS_HEIGHT = 32;
export const CANVAS_NODE_TITLEBAR_SCENE_HEIGHT =
  CANVAS_NODE_TITLEBAR_CSS_HEIGHT * CANVAS_NODE_PRESENTATION_SCALE;
export const CANVAS_VIDEO_FALLBACK_CONTENT_SIZE = Object.freeze({
  width: 3_200,
  height: 1_800
});

interface CanvasPresentationSize {
  readonly width: number;
  readonly height: number;
}

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
    CANVAS_NODE_TITLEBAR_CSS_HEIGHT + 1,
    Math.round(input.height / CANVAS_NODE_PRESENTATION_SCALE)
  );
  return {
    presentationScale: CANVAS_NODE_PRESENTATION_SCALE,
    frameCssWidth,
    frameCssHeight,
    contentCssWidth: frameCssWidth,
    contentCssHeight: frameCssHeight - CANVAS_NODE_TITLEBAR_CSS_HEIGHT,
    titlebarCssHeight: CANVAS_NODE_TITLEBAR_CSS_HEIGHT
  };
}

export function canvasVideoNodeSizeForContent(
  contentSize: CanvasPresentationSize
): CanvasPresentationSize {
  assertPositiveFiniteSize(contentSize, 'Canvas video content');
  return {
    width: contentSize.width,
    height: contentSize.height + CANVAS_NODE_TITLEBAR_SCENE_HEIGHT
  };
}

export function canvasVideoContentSizeForNode(
  nodeSize: CanvasPresentationSize
): CanvasPresentationSize {
  assertPositiveFiniteSize(nodeSize, 'Canvas video node');
  return {
    width: nodeSize.width,
    height: Math.max(1, nodeSize.height - CANVAS_NODE_TITLEBAR_SCENE_HEIGHT)
  };
}

function assertPositiveFiniteSize(size: CanvasPresentationSize, label: string): void {
  if (!Number.isFinite(size.width)
    || size.width <= 0
    || !Number.isFinite(size.height)
    || size.height <= 0) {
    throw new Error(`${label} geometry requires positive finite dimensions.`);
  }
}
