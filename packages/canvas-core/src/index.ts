export { canvasRasterPreviewWidth } from './canvasRasterPreviews.js';
export {
  canvasPreviewContinuityKey,
  type CanvasPreviewContinuityKey
} from './canvasPreviewContinuity.js';
export {
  canvasPreviewTargetIdentity,
  canvasPreviewTargetIdentityFromDigest,
  canvasPreviewTargetKey,
  canvasPreviewVariantKey,
  type CanvasPreviewOwner,
  type CanvasPreviewTargetIdentity,
  type CanvasPreviewTargetKey,
  type CanvasPreviewVariantKey
} from './canvasPreviewIdentities.js';

export function normalizeCanvasVideoPlaybackTimeMs(currentTimeMs: number): number {
  if (!Number.isSafeInteger(currentTimeMs) || currentTimeMs < 0) {
    throw new Error('Canvas video playback time must be a non-negative safe integer in milliseconds.');
  }
  return currentTimeMs;
}
