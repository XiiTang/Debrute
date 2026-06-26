export interface CanvasTextPreviewDescriptor {
  fingerprint: string;
  sourceWidth: number;
  sourceHeight: number;
  contentCssWidth: number;
  contentCssHeight: number;
  scrollTop: number;
  scrollLeft: number;
  variants: number[];
}

export interface CanvasTextPreviewPathInput {
  canvasId: string;
  projectRelativePath: string;
}

export function canvasTextPreviewSourceProjectPath(input: CanvasTextPreviewPathInput): string {
  const base = canvasTextPreviewBaseProjectPath(input);
  return `${base}.source.png`;
}

export function canvasTextPreviewDescriptorProjectPath(input: CanvasTextPreviewPathInput): string {
  const base = canvasTextPreviewBaseProjectPath(input);
  return `${base}.preview.json`;
}

export function canvasTextPreviewVariantProjectPath(input: CanvasTextPreviewPathInput & { width: number }): string {
  assertPositiveInteger(input.width, 'Canvas text preview width must be a positive integer.');
  const base = canvasTextPreviewBaseProjectPath(input);
  return `${base}.preview-w${input.width}.png`;
}

export function normalizeCanvasTextPreviewDescriptor(value: CanvasTextPreviewDescriptor): CanvasTextPreviewDescriptor {
  if (typeof value.fingerprint !== 'string' || value.fingerprint.length === 0) {
    throw new Error('Canvas text preview fingerprint must be a non-empty string.');
  }
  assertPositiveFinite(value.sourceWidth, 'Canvas text preview source width must be a positive finite number.');
  assertPositiveFinite(value.sourceHeight, 'Canvas text preview source height must be a positive finite number.');
  assertPositiveFinite(value.contentCssWidth, 'Canvas text preview content CSS width must be a positive finite number.');
  assertPositiveFinite(value.contentCssHeight, 'Canvas text preview content CSS height must be a positive finite number.');
  assertNonNegativeFinite(value.scrollTop, 'Canvas text preview scrollTop must be a non-negative finite number.');
  assertNonNegativeFinite(value.scrollLeft, 'Canvas text preview scrollLeft must be a non-negative finite number.');
  return {
    fingerprint: value.fingerprint,
    sourceWidth: value.sourceWidth,
    sourceHeight: value.sourceHeight,
    contentCssWidth: value.contentCssWidth,
    contentCssHeight: value.contentCssHeight,
    scrollTop: value.scrollTop,
    scrollLeft: value.scrollLeft,
    variants: [...new Set(value.variants.map((width) => {
      assertPositiveInteger(width, 'Canvas text preview variant width must be a positive integer.');
      return width;
    }))].sort((left, right) => left - right)
  };
}

function canvasTextPreviewBaseProjectPath(input: CanvasTextPreviewPathInput): string {
  const canvasId = normalizeCanvasTextPreviewCanvasId(input.canvasId);
  const projectRelativePath = normalizeCanvasTextPreviewProjectRelativePath(input.projectRelativePath);
  return `.debrute/cache/canvas-text-previews/${canvasId}/${projectRelativePath}`;
}

function normalizeCanvasTextPreviewCanvasId(canvasId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(canvasId) || canvasId === '.' || canvasId === '..') {
    throw new Error('Canvas text preview canvas id must be a valid id.');
  }
  return canvasId;
}

function normalizeCanvasTextPreviewProjectRelativePath(projectRelativePath: string): string {
  const normalized = projectRelativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (!normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => segment === '' || segment === '..')) {
    throw new Error(`Invalid Canvas text preview project-relative path: ${projectRelativePath}`);
  }
  if (normalized === '.debrute' || normalized.startsWith('.debrute/')) {
    throw new Error('Canvas text preview cannot target Debrute internal files.');
  }
  return normalized;
}

function assertPositiveFinite(value: number, message: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }
}

function assertNonNegativeFinite(value: number, message: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(message);
  }
}

function assertPositiveInteger(value: number, message: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(message);
  }
}
