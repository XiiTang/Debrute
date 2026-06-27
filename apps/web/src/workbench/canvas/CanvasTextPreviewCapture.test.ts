import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toBlob } from 'html-to-image';
import {
  CANVAS_TEXT_PREVIEW_SOURCE_SCALE,
  captureCanvasTextPreviewSource,
  canvasTextPreviewFingerprint
} from './CanvasTextPreviewCapture';

vi.mock('html-to-image', () => ({
  toBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' }))
}));

describe('CanvasTextPreviewCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures a text body at the fixed source scale', async () => {
    const element = {
      clientWidth: 320,
      clientHeight: 160
    } as HTMLElement;

    const blob = await captureCanvasTextPreviewSource({ element });

    expect(blob.type).toBe('image/png');
    expect(toBlob).toHaveBeenCalledWith(element, expect.objectContaining({
      pixelRatio: 4,
      width: 320,
      height: 160,
      backgroundColor: 'transparent'
    }));
    expect(toBlob).toHaveBeenCalledWith(element, expect.not.objectContaining({
      canvasWidth: expect.any(Number)
    }));
    expect(toBlob).toHaveBeenCalledWith(element, expect.not.objectContaining({
      canvasHeight: expect.any(Number)
    }));
    expect(toBlob).toHaveBeenCalledWith(element, expect.not.objectContaining({
      filter: expect.any(Function)
    }));
  });

  it('hashes all pixel-affecting text preview inputs', async () => {
    const first = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0
    });
    const second = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: false,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0
    });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^sha256:/);
  });

  it('hashes the fixed text preview source scale', async () => {
    const fingerprint = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0
    });

    await expect(sha256({
      visualVersion: 'canvas-text-preview-v4',
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      sourceScale: CANVAS_TEXT_PREVIEW_SOURCE_SCALE
    })).resolves.toBe(fingerprint);
  });
});

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
