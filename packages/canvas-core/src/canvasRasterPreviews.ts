export const CANVAS_RASTER_PREVIEW_MIN_SCALE = 1 / 32;
export const CANVAS_RASTER_PREVIEW_MAX_SCALE = 1;

export function canvasRasterPreviewSteppedScale(screenScale: number): number {
  assertPositiveFinite(screenScale, 'Canvas raster preview screen scale must be a positive finite number.');
  const stepIndex = Math.ceil(Math.log2(screenScale) * 2);
  return 2 ** (stepIndex / 2);
}

export function canvasRasterPreviewWidth(input: {
  nodeDisplayWidth: number;
  sourceWidth: number;
  resourceZoom: number;
  devicePixelRatio: number;
}): number {
  assertPositiveFinite(input.nodeDisplayWidth, 'Canvas raster preview node display width must be a positive finite number.');
  assertPositiveFinite(input.sourceWidth, 'Canvas raster preview source width must be a positive finite number.');
  assertPositiveFinite(input.resourceZoom, 'Canvas raster preview resource zoom must be a positive finite number.');
  assertPositiveFinite(input.devicePixelRatio, 'Canvas raster preview devicePixelRatio must be a positive finite number.');

  const screenScale = input.resourceZoom * (input.nodeDisplayWidth / input.sourceWidth);
  const steppedScale = canvasRasterPreviewSteppedScale(screenScale);
  const clampedScale = Math.min(
    CANVAS_RASTER_PREVIEW_MAX_SCALE,
    Math.max(CANVAS_RASTER_PREVIEW_MIN_SCALE, steppedScale)
  );
  const previewWidth = Math.ceil(Math.min(
    input.sourceWidth * clampedScale * input.devicePixelRatio,
    input.sourceWidth
  ));
  assertPositiveInteger(previewWidth, 'Canvas raster preview width must be a positive integer.');
  return previewWidth;
}

export function canvasRasterPreviewWidthsForSource(input: {
  sourceWidth: number;
  devicePixelRatio: number;
}): number[] {
  assertPositiveFinite(input.sourceWidth, 'Canvas raster preview source width must be a positive finite number.');
  assertPositiveFinite(input.devicePixelRatio, 'Canvas raster preview devicePixelRatio must be a positive finite number.');
  const widths = new Set<number>();
  for (let stepIndex = -10; stepIndex <= 0; stepIndex += 1) {
    const scale = 2 ** (stepIndex / 2);
    const width = Math.ceil(Math.min(input.sourceWidth * scale * input.devicePixelRatio, input.sourceWidth));
    assertPositiveInteger(width, 'Canvas raster preview width must be a positive integer.');
    widths.add(width);
  }
  return [...widths].sort((left, right) => left - right);
}

function assertPositiveFinite(value: number, message: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }
}

function assertPositiveInteger(value: number, message: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(message);
  }
}
