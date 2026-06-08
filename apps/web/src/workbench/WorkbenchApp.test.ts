import { describe, expect, it } from 'vitest';
import type { CanvasFeedbackBarTarget } from './shell/floatingBars';
import { sameCanvasFeedbackBarTarget } from './shell/floatingBars';

describe('WorkbenchApp feedback bar target equality', () => {
  it('treats equal feedback bar targets as unchanged', () => {
    const target = feedbackTarget();

    expect(sameCanvasFeedbackBarTarget(target, {
      ...target,
      nodeRect: { ...target.nodeRect },
      surfaceRect: { ...target.surfaceRect },
      camera: { ...target.camera },
      entry: target.entry ? {
        ...target.entry,
        marks: [...target.entry.marks]
      } : undefined
    })).toBe(true);
  });

  it('detects feedback bar target camera changes', () => {
    const target = feedbackTarget();

    expect(sameCanvasFeedbackBarTarget(target, {
      ...target,
      camera: { ...target.camera, z: 0.5 }
    })).toBe(false);
  });
});

function feedbackTarget(): CanvasFeedbackBarTarget {
  return {
    projectRelativePath: 'flow/a.png',
    nodeRect: { x: 10, y: 20, width: 300, height: 180 },
    surfaceRect: { x: 0, y: 0, width: 1280, height: 720 },
    camera: { x: 12, y: 24, z: 1 },
    entry: {
      projectRelativePath: 'flow/a.png',
      marks: ['needs_revision'],
      note: 'Needs revision',
      updatedAt: '2026-06-08T00:00:00.000Z'
    }
  };
}
