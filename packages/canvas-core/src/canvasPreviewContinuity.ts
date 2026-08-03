export type CanvasPreviewContinuityKey = string & {
  readonly __canvasPreviewContinuityKey: unique symbol;
};

import type { CanvasPreviewOwner } from './canvasPreviewIdentities.js';

export function canvasPreviewContinuityKey(input: CanvasPreviewOwner & {
  continuityIdentity: string;
}): CanvasPreviewContinuityKey {
  assertNonEmptyString(input.projectId, 'Canvas preview continuity Project ID must be non-empty.');
  assertNonEmptyString(input.projectRelativePath, 'Canvas preview continuity Project path must be non-empty.');
  if (input.canvasId !== undefined) {
    assertNonEmptyString(input.canvasId, 'Canvas preview continuity Canvas ID must be non-empty.');
  }
  assertNonEmptyString(input.continuityIdentity, 'Canvas preview continuity identity must be non-empty.');
  return JSON.stringify([
    'canvas-preview-continuity-v1',
    input.mediaKind,
    input.projectId,
    input.canvasId ?? null,
    input.projectRelativePath,
    input.continuityIdentity
  ]) as CanvasPreviewContinuityKey;
}

function assertNonEmptyString(value: string, message: string): void {
  if (value.length === 0) {
    throw new Error(message);
  }
}
