import { describe, expect, it } from 'vitest';
import {
  canvasPreviewPriorityTier,
  orderCanvasPreviewTasks
} from './CanvasPreviewScheduling.js';

describe('CanvasPreviewScheduling', { tags: ['canvas-text', 'canvas-video'] }, () => {
  const visibleRect = { x: 0, y: 0, width: 100, height: 100 };

  it('uses the exact viewport only as a two-tier ordering signal', () => {
    const tasks = [
      task('outside.md', 500, -100),
      task('visible-b.md', 10, 30),
      task('priority.md', 120, 20),
      task('visible-a.md', 10, 10),
      task('outside-a.md', -500, -100)
    ];

    expect(orderCanvasPreviewTasks(tasks, visibleRect).map((item) => item.projectRelativePath)).toEqual([
      'visible-a.md',
      'visible-b.md',
      'outside-a.md',
      'outside.md',
      'priority.md'
    ]);
    expect(tasks).toHaveLength(5);
  });

  it('orders y then x then path inside a viewport tier', () => {
    const tasks = [
      task('z.md', 20, 20),
      task('b.md', 10, 20),
      task('a.md', 10, 20),
      task('first.md', 80, 10)
    ];

    expect(orderCanvasPreviewTasks(tasks, visibleRect).map((item) => item.projectRelativePath)).toEqual([
      'first.md',
      'a.md',
      'b.md',
      'z.md'
    ]);
  });

  it('classifies exact-viewport and background nodes without filtering either tier', () => {
    expect(canvasPreviewPriorityTier(task('visible.md', 10, 10), visibleRect)).toBe(0);
    expect(canvasPreviewPriorityTier(task('touching-edge.md', 100, 10), visibleRect)).toBe(0);
    expect(canvasPreviewPriorityTier(task('outside.md', 500, 10), visibleRect)).toBe(1);
  });
});

function task(projectRelativePath: string, x: number, y: number) {
  return { projectRelativePath, x, y, width: 20, height: 20 };
}
