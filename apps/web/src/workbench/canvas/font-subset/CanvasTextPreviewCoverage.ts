const CANVAS_TEXT_PREVIEW_COVERAGE_SLICE_MS = 4;
const CANVAS_TEXT_PREVIEW_REPLACEMENT_CODEPOINT = 0xfffd;

export interface CanvasTextPreviewCoverageResult {
  readonly codepoints: Uint32Array;
  readonly durationMs: number;
  readonly activeScanDurationMs: number;
  readonly maxSynchronousSliceMs: number;
}

export async function collectCanvasTextPreviewCoverage(
  contents: readonly string[],
  options: {
    readonly signal: AbortSignal;
    readonly isInteractionActive: () => boolean;
    readonly now?: (() => number) | undefined;
    readonly waitForFrame?: (() => Promise<void>) | undefined;
  }
): Promise<CanvasTextPreviewCoverageResult> {
  const now = options.now ?? (() => performance.now());
  const waitForFrame = options.waitForFrame ?? waitForAnimationFrame;
  const startedAt = now();
  const codepoints = baselineCodepoints();
  let contentIndex = 0;
  let offset = 0;
  let activeScanDurationMs = 0;
  let maxSynchronousSliceMs = 0;
  while (contentIndex < contents.length) {
    throwIfAborted(options.signal);
    if (options.isInteractionActive()) {
      await waitForFrame();
      continue;
    }
    const sliceStartedAt = now();
    do {
      const content = contents[contentIndex]!;
      if (offset >= content.length) {
        contentIndex += 1;
        offset = 0;
        continue;
      }
      const codepoint = content.codePointAt(offset);
      if (codepoint !== undefined) {
        codepoints.add(codepoint);
        offset += codepoint > 0xffff ? 2 : 1;
      }
    } while (contentIndex < contents.length
      && now() - sliceStartedAt < CANVAS_TEXT_PREVIEW_COVERAGE_SLICE_MS);
    const sliceDurationMs = now() - sliceStartedAt;
    activeScanDurationMs += sliceDurationMs;
    maxSynchronousSliceMs = Math.max(maxSynchronousSliceMs, sliceDurationMs);
    if (contentIndex < contents.length) {
      await waitForFrame();
    }
  }
  throwIfAborted(options.signal);
  const sorted = [...codepoints].sort((left, right) => left - right);
  return {
    codepoints: Uint32Array.from(sorted),
    durationMs: now() - startedAt,
    activeScanDurationMs,
    maxSynchronousSliceMs
  };
}

export function canvasTextPreviewCoverageContains(
  coverage: Uint32Array,
  requested: Uint32Array
): boolean {
  let coverageIndex = 0;
  let requestedIndex = 0;
  while (coverageIndex < coverage.length && requestedIndex < requested.length) {
    const available = coverage[coverageIndex]!;
    const needed = requested[requestedIndex]!;
    if (available < needed) {
      coverageIndex += 1;
    } else if (available === needed) {
      coverageIndex += 1;
      requestedIndex += 1;
    } else {
      return false;
    }
  }
  return requestedIndex === requested.length;
}

export function mergeCanvasTextPreviewCoverage(
  left: Uint32Array,
  right: Uint32Array
): Uint32Array {
  const merged = new Uint32Array(left.length + right.length);
  let leftIndex = 0;
  let rightIndex = 0;
  let outputIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftValue = leftIndex < left.length ? left[leftIndex]! : Number.POSITIVE_INFINITY;
    const rightValue = rightIndex < right.length ? right[rightIndex]! : Number.POSITIVE_INFINITY;
    const value = Math.min(leftValue, rightValue);
    if (value !== merged[outputIndex - 1]) {
      merged[outputIndex] = value;
      outputIndex += 1;
    }
    if (leftValue === value) {
      leftIndex += 1;
    }
    if (rightValue === value) {
      rightIndex += 1;
    }
  }
  return merged.slice(0, outputIndex);
}

function baselineCodepoints(): Set<number> {
  const codepoints = new Set<number>();
  for (let codepoint = 0x20; codepoint <= 0x7e; codepoint += 1) {
    codepoints.add(codepoint);
  }
  codepoints.add(CANVAS_TEXT_PREVIEW_REPLACEMENT_CODEPOINT);
  return codepoints;
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Canvas text preview coverage collection was aborted.', 'AbortError');
  }
}
