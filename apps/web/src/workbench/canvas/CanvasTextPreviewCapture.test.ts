import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toBlob } from 'html-to-image';
import {
  CANVAS_TEXT_PREVIEW_SOURCE_SCALE,
  captureCanvasTextPreviewSource,
  canvasTextPreviewFingerprint
} from './CanvasTextPreviewCapture';
import type { CanvasTextPreviewSnapshot } from './CanvasTextPreviewSnapshot';

vi.mock('html-to-image', () => ({
  toBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' }))
}));

describe('CanvasTextPreviewCapture', { tags: ['canvas-text'] }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rasterizes only a bounded snapshot at the fixed source scale', async () => {
    const snapshot = snapshotFixture(320, 160);

    const result = await captureCanvasTextPreviewSource({
      snapshot,
      fields: failureFields()
    });

    expect(result.sourcePng.type).toBe('image/png');
    expect(result).toMatchObject({
      snapshotWidth: 320,
      snapshotHeight: 160,
      snapshotBytes: snapshot.serializedBytes
    });
    expect(toBlob).toHaveBeenCalledWith(snapshot.root, expect.objectContaining({
      pixelRatio: 4,
      width: 320,
      height: 160,
      backgroundColor: 'transparent',
      skipFonts: true,
      includeStyleProperties: []
    }));
    expect(toBlob).toHaveBeenCalledWith(snapshot.root, expect.not.objectContaining({
      canvasWidth: expect.any(Number)
    }));
    expect(toBlob).toHaveBeenCalledWith(snapshot.root, expect.not.objectContaining({
      canvasHeight: expect.any(Number)
    }));
    expect(toBlob).toHaveBeenCalledWith(snapshot.root, expect.not.objectContaining({
      filter: expect.any(Function)
    }));
  });

  it('reports raster_failed instead of exposing a raw Event', async () => {
    vi.mocked(toBlob).mockRejectedValueOnce(new Event('error'));

    await expect(captureCanvasTextPreviewSource({
      snapshot: snapshotFixture(320, 160),
      fields: failureFields()
    })).rejects.toMatchObject({
      stage: 'raster_failed',
      message: 'Canvas text preview raster failed (browser event: error).'
    });
  });

  it('measures raster wall duration through PNG blob completion', async () => {
    const raster = deferred<Blob>();
    let now = 10;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.mocked(toBlob).mockReturnValueOnce(raster.promise);

    const capture = captureCanvasTextPreviewSource({
      snapshot: snapshotFixture(320, 160),
      fields: failureFields()
    });
    now = 37;
    raster.resolve(new Blob(['png'], { type: 'image/png' }));

    await expect(capture).resolves.toMatchObject({ rasterDurationMs: 27 });
  });

  it('hashes all pixel-affecting text preview inputs', async () => {
    const first = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      styleKey: 'sha256:style-a'
    });
    const second = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: false,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      styleKey: 'sha256:style-a'
    });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^sha256:/);
  });

  it('hashes the text preview style key', async () => {
    const first = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      styleKey: 'sha256:style-a'
    });
    const second = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      styleKey: 'sha256:style-b'
    });

    expect(first).not.toBe(second);
  });

  it('hashes the fixed text preview source scale', async () => {
    const fingerprint = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      styleKey: 'sha256:style-a'
    });

    await expect(sha256({
      visualVersion: 'canvas-text-preview-v13',
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      sourceScale: CANVAS_TEXT_PREVIEW_SOURCE_SCALE,
      styleKey: 'sha256:style-a'
    })).resolves.toBe(fingerprint);
  });
});

function snapshotFixture(width: number, height: number): CanvasTextPreviewSnapshot {
  const outerHTML = `<div data-canvas-text-preview-snapshot="true" style="width:${width}px;height:${height}px;overflow:hidden"></div>`;
  const root = {
    dataset: { canvasTextPreviewSnapshot: 'true' },
    style: { width: `${width}px`, height: `${height}px`, overflow: 'hidden' },
    outerHTML,
    querySelector: () => null,
    querySelectorAll: () => []
  } as unknown as HTMLDivElement;
  return {
    root,
    width,
    height,
    serializedBytes: new TextEncoder().encode(root.outerHTML).byteLength
  };
}

function failureFields() {
  return {
    canvasId: 'canvas-1',
    projectRelativePath: 'notes/readme.md',
    fingerprint: 'sha256:current'
  };
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
