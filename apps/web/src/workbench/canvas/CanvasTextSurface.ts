export const CANVAS_TEXT_SURFACE_METRICS = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSizePx: 12,
  lineHeightPx: 16.8,
  linePaddingInlinePx: 8,
  gutterPaddingLeftPx: 5,
  gutterPaddingRightPx: 3,
  tabSize: 4
} as const;

export type CanvasTextSurfaceCssVariable =
  | '--canvas-text-editor-font-family'
  | '--canvas-text-editor-font-size'
  | '--canvas-text-editor-line-height'
  | '--canvas-text-editor-line-padding-inline'
  | '--canvas-text-editor-gutter-padding-left'
  | '--canvas-text-editor-gutter-padding-right'
  | '--canvas-text-editor-tab-size';

export function canvasTextSurfaceCssVariables(): Record<CanvasTextSurfaceCssVariable, string> {
  return {
    '--canvas-text-editor-font-family': CANVAS_TEXT_SURFACE_METRICS.fontFamily,
    '--canvas-text-editor-font-size': `${CANVAS_TEXT_SURFACE_METRICS.fontSizePx}px`,
    '--canvas-text-editor-line-height': `${CANVAS_TEXT_SURFACE_METRICS.lineHeightPx}px`,
    '--canvas-text-editor-line-padding-inline': `${CANVAS_TEXT_SURFACE_METRICS.linePaddingInlinePx}px`,
    '--canvas-text-editor-gutter-padding-left': `${CANVAS_TEXT_SURFACE_METRICS.gutterPaddingLeftPx}px`,
    '--canvas-text-editor-gutter-padding-right': `${CANVAS_TEXT_SURFACE_METRICS.gutterPaddingRightPx}px`,
    '--canvas-text-editor-tab-size': String(CANVAS_TEXT_SURFACE_METRICS.tabSize)
  };
}
