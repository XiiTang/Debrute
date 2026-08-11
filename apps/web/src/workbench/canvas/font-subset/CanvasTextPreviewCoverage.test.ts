import { describe, expect, it } from 'vitest';
import {
  canvasTextPreviewCoverageContains,
  collectCanvasTextPreviewCoverage,
  mergeCanvasTextPreviewCoverage
} from './CanvasTextPreviewCoverage';

describe('CanvasTextPreviewCoverage', { tags: ['canvas-text'] }, () => {
  it('collects the fixed baseline and raw Unicode codepoints exactly once', async () => {
    const result = await collectCanvasTextPreviewCoverage(
      ['A😀', '中A'],
      {
        signal: new AbortController().signal,
        isInteractionActive: () => false,
        waitForFrame: async () => undefined
      }
    );

    expect([...result.codepoints]).toContain(0x20);
    expect([...result.codepoints]).toContain(0x7e);
    expect([...result.codepoints]).toContain(0xfffd);
    expect([...result.codepoints]).toContain(0x1f600);
    expect([...result.codepoints]).toContain(0x4e2d);
    expect([...result.codepoints].filter((codepoint) => codepoint === 0x41)).toHaveLength(1);
    expect([...result.codepoints]).toEqual([...result.codepoints].sort((left, right) => left - right));
  });

  it('pauses before scanning while an interaction is active', async () => {
    let active = true;
    let frames = 0;
    const result = await collectCanvasTextPreviewCoverage(
      ['é'],
      {
        signal: new AbortController().signal,
        isInteractionActive: () => active,
        waitForFrame: async () => {
          frames += 1;
          active = false;
        }
      }
    );

    expect(frames).toBe(1);
    expect([...result.codepoints]).toContain(0xe9);
  });

  it('checks sorted active coverage without allocating historical unions', () => {
    const coverage = Uint32Array.from([0x20, 0x41, 0x4e2d]);
    expect(canvasTextPreviewCoverageContains(coverage, Uint32Array.from([0x20, 0x4e2d]))).toBe(true);
    expect(canvasTextPreviewCoverageContains(coverage, Uint32Array.from([0x20, 0x42]))).toBe(false);
  });

  it('merges sorted coverage without duplicates', () => {
    expect([...mergeCanvasTextPreviewCoverage(
      Uint32Array.from([0x20, 0x41, 0x4e2d]),
      Uint32Array.from([0x20, 0x42, 0x4e2d])
    )]).toEqual([0x20, 0x41, 0x42, 0x4e2d]);
  });
});
