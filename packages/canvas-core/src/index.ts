export { canvasRasterPreviewWidth } from './canvasRasterPreviews.js';
export {
  canvasPreviewContinuityKey,
  type CanvasPreviewContinuityKey
} from './canvasPreviewContinuity.js';
export {
  canvasPreviewCanonicalSourceIdentity,
  canvasPreviewTargetIdentity,
  canvasPreviewTargetIdentityFromDigest,
  canvasPreviewTargetKey,
  canvasPreviewVariantIdentity,
  canvasPreviewVariantKey,
  type CanvasPreviewCanonicalSourceIdentity,
  type CanvasPreviewOwner,
  type CanvasPreviewTargetIdentity,
  type CanvasPreviewTargetKey,
  type CanvasPreviewVariantIdentity,
  type CanvasPreviewVariantKey
} from './canvasPreviewIdentities.js';

export function normalizeCanvasVideoPlaybackTimeMs(currentTimeMs: number): number {
  if (!Number.isSafeInteger(currentTimeMs) || currentTimeMs < 0) {
    throw new Error('Canvas video playback time must be a non-negative safe integer in milliseconds.');
  }
  return currentTimeMs;
}
