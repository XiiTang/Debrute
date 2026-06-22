import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CanvasFeedbackBarTarget, CanvasLocalFeedbackDraft } from './shell/floatingBars';
import { chooseInitialActiveCanvasId } from './canvas/canvasCardBarState';
import { sameCanvasFeedbackBarTarget } from './shell/floatingBars';

describe('WorkbenchApp feedback bar target equality', () => {
  it('requires local feedback drafts to carry the confirming image feedback target', () => {
    expectTypeOf<CanvasLocalFeedbackDraft['feedbackBarTarget']>().toEqualTypeOf<CanvasFeedbackBarTarget>();
  });

  it('treats equal feedback bar targets as unchanged', () => {
    const target = feedbackTarget();

    expect(sameCanvasFeedbackBarTarget(target, {
      ...target,
      nodeRect: { ...target.nodeRect },
      surfaceRect: { ...target.surfaceRect },
      camera: { ...target.camera },
      entry: target.entry ? {
        ...target.entry,
        marks: [...target.entry.marks],
        regions: [...target.entry.regions]
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

  it('detects feedback bar target local image feedback support changes', () => {
    const target = feedbackTarget();

    expect(sameCanvasFeedbackBarTarget(target, {
      ...target,
      supportsImageLocalFeedback: false
    })).toBe(false);
  });

  it('carries the confirming image target on local feedback drafts', () => {
    const draftTarget = feedbackTarget('flow/b.png');
    const draft: CanvasLocalFeedbackDraft = {
      projectRelativePath: 'flow/b.png',
      geometry: { type: 'point', x: 0.4, y: 0.5 },
      feedbackBarTarget: draftTarget
    };

    expect(draft.feedbackBarTarget).toBe(draftTarget);
  });
});

describe('WorkbenchApp canvas registry integration helpers', () => {
  it('restores the stored active canvas for the current project when present', () => {
    expect(chooseInitialActiveCanvasId({
      storedActiveCanvasId: 'canvas-2',
      canvasOrder: ['canvas-1', 'canvas-2']
    })).toBe('canvas-2');
  });
});

function feedbackTarget(projectRelativePath = 'flow/a.png'): CanvasFeedbackBarTarget {
  return {
    projectRelativePath,
    nodeRect: { x: 10, y: 20, width: 300, height: 180 },
    surfaceRect: { x: 0, y: 0, width: 1280, height: 720 },
    camera: { x: 12, y: 24, z: 1 },
    supportsImageLocalFeedback: true,
    entry: {
      projectRelativePath,
      marks: ['needs_revision'],
      comments: [{
        id: 'comment-1',
        comment: 'Needs revision',
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T00:00:00.000Z'
      }],
      nextRegionLabel: 1,
      regions: [],
      updatedAt: '2026-06-08T00:00:00.000Z'
    }
  };
}
