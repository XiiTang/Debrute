import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CanvasFeedbackEntry } from '@debrute/canvas-core';
import {
  CanvasFeedbackFrame,
  canvasFeedbackEntryHasFeedback,
  canvasFeedbackFrameGradient,
  orderedCanvasFeedbackFrameKinds
} from './CanvasFeedbackFrame';

const NOW = '2026-07-01T12:00:00.000Z';

function renderStatic(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe('CanvasFeedbackFrame', () => {
  it('renders nothing for missing or empty feedback', () => {
    expect(renderStatic(<CanvasFeedbackFrame entry={undefined} />)).toBe('');
    expect(renderStatic(<CanvasFeedbackFrame entry={entryFixture()} />)).toBe('');
    expect(canvasFeedbackEntryHasFeedback(undefined)).toBe(false);
    expect(canvasFeedbackEntryHasFeedback(entryFixture())).toBe(false);
  });

  it('orders marks, comments, and regions as frame kinds', () => {
    const entry = entryFixture({
      marks: ['needs_revision', 'important', 'like', 'check'],
      comments: [{
        id: 'comment-1',
        comment: 'overall direction',
        createdAt: NOW,
        updatedAt: NOW
      }],
      regions: [{
        id: 'region-1',
        label: 1,
        kind: 'pin',
        geometry: { type: 'point', x: 0.2, y: 0.3 },
        comment: 'face detail',
        createdAt: NOW,
        updatedAt: NOW
      }]
    });

    expect(orderedCanvasFeedbackFrameKinds(entry)).toEqual([
      'like',
      'check',
      'important',
      'needs_revision',
      'comments',
      'regions'
    ]);
  });

  it('renders one full-frame color segment for one feedback type', () => {
    const html = renderStatic(<CanvasFeedbackFrame entry={entryFixture({ marks: ['like'] })} />);

    expect(html).toContain('class="canvas-feedback-frame"');
    expect(html).toContain('data-canvas-feedback-frame="true"');
    expect(html).toContain('data-canvas-feedback-frame-kinds="like"');
    expect(html).toContain('--canvas-feedback-frame-gradient:conic-gradient(#22c55e 0% 100%)');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('+');
  });

  it('renders multiple equal color segments without comments, counts, or icons', () => {
    const entry = entryFixture({
      marks: ['needs_revision', 'like'],
      comments: [{
        id: 'comment-1',
        comment: 'overall direction',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'comment-2',
        comment: 'second pass',
        createdAt: NOW,
        updatedAt: NOW
      }],
      regions: [{
        id: 'region-1',
        label: 1,
        kind: 'pin',
        geometry: { type: 'point', x: 0.2, y: 0.3 },
        comment: 'face detail',
        createdAt: NOW,
        updatedAt: NOW
      }]
    });
    const html = renderStatic(<CanvasFeedbackFrame entry={entry} />);

    expect(canvasFeedbackEntryHasFeedback(entry)).toBe(true);
    expect(html).toContain('data-canvas-feedback-frame-kinds="like needs_revision comments regions"');
    expect(html).toContain('--canvas-feedback-frame-gradient:conic-gradient(#22c55e 0% 25%, #f97316 25% 50%, #3b82f6 50% 75%, #facc15 75% 100%)');
    expect(html).not.toContain('overall direction');
    expect(html).not.toContain('second pass');
    expect(html).not.toContain('face detail');
    expect(html).not.toContain('<svg');
  });

  it('builds deterministic conic gradients from frame kinds', () => {
    expect(canvasFeedbackFrameGradient(['comments'])).toBe(
      'conic-gradient(#3b82f6 0% 100%)'
    );
    expect(canvasFeedbackFrameGradient(['like', 'pending', 'regions'])).toBe(
      'conic-gradient(#22c55e 0% 33.3333%, #f59e0b 33.3333% 66.6667%, #facc15 66.6667% 100%)'
    );
  });
});

function entryFixture(overrides: Partial<CanvasFeedbackEntry> = {}): CanvasFeedbackEntry {
  return {
    projectRelativePath: 'flow/cover.png',
    marks: [],
    comments: [],
    nextRegionLabel: 1,
    regions: [],
    updatedAt: NOW,
    ...overrides
  };
}
