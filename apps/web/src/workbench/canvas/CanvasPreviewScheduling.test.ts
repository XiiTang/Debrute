import { describe, expect, it } from 'vitest';
import {
  canvasPreviewDistanceSquared,
  compareCanvasPreviewPaths,
  orderCanvasPreviewTasks
} from './CanvasPreviewScheduling.js';

describe('CanvasPreviewScheduling', { tags: ['canvas-text', 'canvas-video'] }, () => {
  const visibleRect = { x: 0, y: 0, width: 100, height: 100 };

  it('orders every target by the viewport center distance to its nearest rectangle point', () => {
    const tasks = [
      task('touching-corner.md', 100, 100),
      task('outside-near-center.md', 101, 40),
      { ...task('contains-center.md', 0, 0), width: 100, height: 100 }
    ];

    expect(orderCanvasPreviewTasks(tasks, visibleRect).map((item) => item.projectRelativePath)).toEqual([
      'contains-center.md',
      'outside-near-center.md',
      'touching-corner.md'
    ]);
    expect(tasks).toHaveLength(3);
  });

  it('uses project path only to make equal distances deterministic', () => {
    const tasks = [
      task('z.md', 10, 40),
      task('a.md', 70, 40)
    ];

    expect(orderCanvasPreviewTasks(tasks, visibleRect).map((item) => item.projectRelativePath)).toEqual([
      'a.md',
      'z.md'
    ]);
  });

  it('breaks exact path ties by raw code-unit order instead of locale equivalence', () => {
    const composed = '\u00e9.md';
    const decomposed = 'e\u0301.md';
    expect(composed.localeCompare(decomposed)).toBe(0);
    expect(compareCanvasPreviewPaths(decomposed, composed)).toBeLessThan(0);
    expect(orderCanvasPreviewTasks([
      task(composed, 10, 40),
      task(decomposed, 70, 40)
    ], visibleRect).map((item) => item.projectRelativePath)).toEqual([
      decomposed,
      composed
    ]);
  });

  it('gives a large node containing the viewport center zero distance', () => {
    expect(canvasPreviewDistanceSquared(
      { ...task('large.md', -500, -500), width: 1_000, height: 1_000 },
      visibleRect
    )).toBe(0);
    expect(canvasPreviewDistanceSquared(task('right.md', 100, 40), visibleRect)).toBe(2_500);
  });
});

function task(projectRelativePath: string, x: number, y: number) {
  return { projectRelativePath, x, y, width: 20, height: 20 };
}
