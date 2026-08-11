export type CanvasPreviewTargetIdentity = string & {
  readonly __canvasPreviewTargetIdentity: unique symbol;
};

export type CanvasPreviewVariantIdentity = string & {
  readonly __canvasPreviewVariantIdentity: unique symbol;
};

export type CanvasPreviewTargetKey = string & {
  readonly __canvasPreviewTargetKey: unique symbol;
};

export type CanvasPreviewVariantKey = string & {
  readonly __canvasPreviewVariantKey: unique symbol;
};

type CanvasPreviewIdentityPart = string | number;

export interface CanvasPreviewOwner {
  mediaKind: 'image' | 'text' | 'video';
  bindingId: string;
  projectRelativePath: string;
}

export function canvasPreviewTargetIdentity(
  parts: readonly CanvasPreviewIdentityPart[]
): CanvasPreviewTargetIdentity {
  assertIdentityParts(parts, 'Canvas preview target identity');
  return JSON.stringify(['canvas-preview-target-v1', ...parts]) as CanvasPreviewTargetIdentity;
}

export function canvasPreviewTargetIdentityFromDigest(digest: string): CanvasPreviewTargetIdentity {
  assertNonEmptyString(digest, 'Canvas preview target identity digest must be non-empty.');
  return digest as CanvasPreviewTargetIdentity;
}

export function canvasPreviewVariantIdentity(input: {
  targetIdentity: CanvasPreviewTargetIdentity;
  width: number;
}): CanvasPreviewVariantIdentity {
  assertNonEmptyString(input.targetIdentity, 'Canvas preview target identity must be non-empty.');
  assertPositiveInteger(input.width, 'Canvas preview variant width must be a positive integer.');
  return JSON.stringify([
    'canvas-preview-variant-v1',
    input.targetIdentity,
    input.width
  ]) as CanvasPreviewVariantIdentity;
}

export function canvasPreviewTargetKey(input: CanvasPreviewOwner & {
  targetIdentity: CanvasPreviewTargetIdentity;
}): CanvasPreviewTargetKey {
  assertOwner(input);
  assertNonEmptyString(input.targetIdentity, 'Canvas preview target identity must be non-empty.');
  return JSON.stringify([
    'canvas-preview-target-key-v1',
    input.mediaKind,
    input.bindingId,
    input.projectRelativePath,
    input.targetIdentity
  ]) as CanvasPreviewTargetKey;
}

export function canvasPreviewVariantKey(input: CanvasPreviewOwner & {
  targetIdentity: CanvasPreviewTargetIdentity;
  width: number;
}): CanvasPreviewVariantKey {
  assertOwner(input);
  const variantIdentity = canvasPreviewVariantIdentity(input);
  return JSON.stringify([
    'canvas-preview-variant-key-v1',
    input.mediaKind,
    input.bindingId,
    input.projectRelativePath,
    variantIdentity
  ]) as CanvasPreviewVariantKey;
}

function assertOwner(owner: CanvasPreviewOwner): void {
  assertNonEmptyString(owner.bindingId, 'Canvas preview Binding ID must be non-empty.');
  assertNonEmptyString(owner.projectRelativePath, 'Canvas preview Project path must be non-empty.');
}

function assertIdentityParts(parts: readonly CanvasPreviewIdentityPart[], label: string): void {
  if (parts.length === 0) {
    throw new Error(`${label} must include at least one part.`);
  }
  for (const part of parts) {
    if (typeof part === 'number') {
      if (!Number.isFinite(part)) {
        throw new Error(`${label} numeric parts must be finite.`);
      }
    } else {
      assertNonEmptyString(part, `${label} string parts must be non-empty.`);
    }
  }
}

function assertNonEmptyString(value: string, message: string): void {
  if (value.length === 0) {
    throw new Error(message);
  }
}

function assertPositiveInteger(value: number, message: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(message);
  }
}
