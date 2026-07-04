import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CanvasFeedbackEntry } from '@debrute/canvas-core';
import {
  CanvasFeedbackFrame,
  canvasFeedbackEntryHasFeedback,
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
      items: [{
        id: 'comment-1',
        kind: 'comment',
        scope: 'file',
        comment: 'overall direction',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'region-1',
        label: 1,
        kind: 'pin',
        scope: 'file',
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

  it('renders one metadata-only feedback frame for one feedback type', () => {
    const html = renderStatic(<CanvasFeedbackFrame entry={entryFixture({ marks: ['like'] })} />);

    expect(html).toContain('class="canvas-feedback-frame"');
    expect(html).toContain('data-canvas-feedback-frame="true"');
    expect(html).toContain('data-canvas-feedback-frame-kinds="like"');
    expect(html).not.toContain('--canvas-feedback-frame-gradient');
    expect(html).not.toContain('conic-gradient');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('+');
  });

  it('renders one metadata-only frame for multiple feedback kinds without comments, counts, or icons', () => {
    const entry = entryFixture({
      marks: ['needs_revision', 'like'],
      items: [{
        id: 'comment-1',
        kind: 'comment',
        scope: 'file',
        comment: 'overall direction',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'comment-2',
        kind: 'comment',
        scope: 'file',
        comment: 'second pass',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'region-1',
        label: 1,
        kind: 'pin',
        scope: 'file',
        geometry: { type: 'point', x: 0.2, y: 0.3 },
        comment: 'face detail',
        createdAt: NOW,
        updatedAt: NOW
      }]
    });
    const html = renderStatic(<CanvasFeedbackFrame entry={entry} />);

    expect(canvasFeedbackEntryHasFeedback(entry)).toBe(true);
    expect(html).toContain('data-canvas-feedback-frame-kinds="like needs_revision comments regions"');
    expect(html).not.toContain('--canvas-feedback-frame-gradient');
    expect(html).not.toContain('conic-gradient');
    expect(html).not.toContain('overall direction');
    expect(html).not.toContain('second pass');
    expect(html).not.toContain('face detail');
    expect(html).not.toContain('<svg');
  });
});

function entryFixture(overrides: Partial<CanvasFeedbackEntry> = {}): CanvasFeedbackEntry {
  return {
    projectRelativePath: 'flow/cover.png',
    marks: [],
    nextMomentLabel: 1,
    nextSpatialLabel: 1,
    items: [],
    updatedAt: NOW,
    ...overrides
  };
}
