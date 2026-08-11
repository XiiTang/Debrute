import { describe, expect, it } from 'vitest';
import type { CanvasFeedbackDocument } from '@debrute/app-protocol';
import { orderedFeedbackEntries } from './FeedbackPanel';

describe('orderedFeedbackEntries', () => {
  it('uses Explorer order and retains unresolved document paths last', () => {
    const feedback: CanvasFeedbackDocument = {
      updatedAt: '2026-08-10T00:00:00Z',
      entries: Object.fromEntries(['missing.png', 'b.png', '', 'a.png'].map((path) => [path, {
        projectRelativePath: path,
        marks: ['未配置'],
        nextMomentLabel: 1,
        nextSpatialLabel: 1,
        items: [],
        updatedAt: '2026-08-10T00:00:00Z'
      }]))
    };
    expect(orderedFeedbackEntries(feedback, [
      { projectRelativePath: 'a.png', kind: 'file' },
      { projectRelativePath: 'b.png', kind: 'file' }
    ]).map((entry) => entry.projectRelativePath)).toEqual(['', 'a.png', 'b.png', 'missing.png']);
  });
});
