import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toBlob } from 'html-to-image';
import { captureCanvasTextPreviewSource, canvasTextPreviewFingerprint } from './CanvasTextPreviewCapture';

vi.mock('html-to-image', () => ({
  toBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' }))
}));

describe('CanvasTextPreviewCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures a text body at a fixed source scale', async () => {
    const element = {
      clientWidth: 320,
      clientHeight: 160
    } as HTMLElement;

    const blob = await captureCanvasTextPreviewSource({
      element,
      sourceScale: 2
    });

    expect(blob.type).toBe('image/png');
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
});
