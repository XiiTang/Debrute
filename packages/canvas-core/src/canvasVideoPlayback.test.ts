import { describe, expect, it } from 'vitest';
import { normalizeCanvasVideoPlaybackTime } from './index';

describe('Canvas video playback presentation', { tags: ['canvas-video'] }, () => {
  it('normalizes playback timestamps to millisecond precision', () => {
    expect(normalizeCanvasVideoPlaybackTime(12.34567)).toBe(12.346);
    expect(normalizeCanvasVideoPlaybackTime(0)).toBe(0);
  });

  it('rejects invalid playback timestamps', () => {
    expect(() => normalizeCanvasVideoPlaybackTime(Number.NaN))
      .toThrow('Canvas video playback time must be a non-negative finite number.');
    expect(() => normalizeCanvasVideoPlaybackTime(-1))
      .toThrow('Canvas video playback time must be a non-negative finite number.');
  });
});
