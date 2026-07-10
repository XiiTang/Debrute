import { describe, expect, it } from 'vitest';
import type { CanvasFeedbackBarTarget } from '../shell/floatingBars';
import {
  canvasFeedbackAddItemForPending,
  pendingCanvasFeedbackItemLabel
} from './canvasFeedbackDraft';

describe('canvas feedback drafts', () => {
  it('uses the next spatial label for pin and region drafts', () => {
    expect(pendingCanvasFeedbackItemLabel({
      projectRelativePath: 'image.png',
      kind: 'pin',
      scope: 'file',
      geometry: { type: 'point', x: 0.25, y: 0.5 },
      feedbackBarTarget: feedbackTarget()
    }, {
      projectRelativePath: 'image.png',
      marks: [],
      nextMomentLabel: 1,
      nextSpatialLabel: 4,
      items: [],
      updatedAt: '2026-07-10T00:00:00.000Z'
    })).toBe(4);
  });

  it('converts a complete pending region into one add-item payload', () => {
    expect(canvasFeedbackAddItemForPending({
      projectRelativePath: 'image.png',
      kind: 'region',
      scope: 'file',
      geometry: { type: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      label: 2
    }, 'Tighten crop')).toEqual({
      kind: 'region',
      scope: 'file',
      geometry: { type: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      comment: 'Tighten crop'
    });
  });

  it('does not create incomplete spatial or moment items', () => {
    expect(canvasFeedbackAddItemForPending({
      projectRelativePath: 'image.png',
      kind: 'pin',
      scope: 'file'
    }, 'Missing point')).toBeUndefined();
    expect(canvasFeedbackAddItemForPending({
      projectRelativePath: 'video.mp4',
      kind: 'comment',
      scope: 'moment'
    }, 'Missing moment')).toBeUndefined();
  });
});

function feedbackTarget(): CanvasFeedbackBarTarget {
  return {
    projectRelativePath: 'image.png',
    nodeRect: { x: 10, y: 20, width: 300, height: 180 },
    surfaceRect: { x: 0, y: 0, width: 1280, height: 720 },
    camera: { x: 12, y: 24, z: 1 },
    localToolset: 'image',
    canStartVideoMomentFeedback: false,
    entry: undefined
  };
}
