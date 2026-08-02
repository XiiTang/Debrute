import { describe, expect, it } from 'vitest';
import { normalizeCanvasVideoPlaybackTimeMs } from './index';

describe('Canvas video playback presentation', { tags: ['canvas-video'] }, () => {
  it('accepts non-negative integer millisecond playback timestamps', () => {
    expect(normalizeCanvasVideoPlaybackTimeMs(12_346)).toBe(12_346);
    expect(normalizeCanvasVideoPlaybackTimeMs(0)).toBe(0);
  });

  it('rejects invalid playback timestamps', () => {
    expect(() => normalizeCanvasVideoPlaybackTimeMs(12.5))
      .toThrow('Canvas video playback time must be a non-negative safe integer in milliseconds.');
    expect(() => normalizeCanvasVideoPlaybackTimeMs(-1))
      .toThrow('Canvas video playback time must be a non-negative safe integer in milliseconds.');
  });
});
