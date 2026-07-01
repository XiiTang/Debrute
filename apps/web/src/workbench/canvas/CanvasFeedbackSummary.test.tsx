import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CanvasFeedbackEntry } from '@debrute/canvas-core';
import {
  CanvasFeedbackSummary,
  canvasFeedbackEntryHasFeedback,
  orderedCanvasFeedbackMarks
} from './CanvasFeedbackSummary';
import { I18nProvider } from '../i18n';

const NOW = '2026-07-01T12:00:00.000Z';

function renderStatic(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      {element}
    </I18nProvider>
  );
}

describe('CanvasFeedbackSummary', () => {
  it('renders nothing for missing or empty feedback', () => {
    expect(renderStatic(<CanvasFeedbackSummary entry={undefined} />)).toBe('');
    expect(renderStatic(<CanvasFeedbackSummary entry={entryFixture()} />)).toBe('');
    expect(canvasFeedbackEntryHasFeedback(undefined)).toBe(false);
    expect(canvasFeedbackEntryHasFeedback(entryFixture())).toBe(false);
  });

  it('renders selected marks in feedback mark order with overflow', () => {
    const entry = entryFixture({
      marks: ['needs_revision', 'important', 'like', 'check']
    });
    const html = renderStatic(<CanvasFeedbackSummary entry={entry} />);

    expect(orderedCanvasFeedbackMarks(['needs_revision', 'like', 'like', 'check'])).toEqual([
      'like',
      'check',
      'needs_revision'
    ]);
    expect(html).toContain('data-canvas-feedback-summary="true"');
    expect(html.indexOf('data-canvas-feedback-summary-mark="like"')).toBeLessThan(
      html.indexOf('data-canvas-feedback-summary-mark="check"')
    );
    expect(html.indexOf('data-canvas-feedback-summary-mark="check"')).toBeLessThan(
      html.indexOf('data-canvas-feedback-summary-mark="important"')
    );
    expect(html).toContain('data-canvas-feedback-summary-overflow="1"');
    expect(html).not.toContain('data-canvas-feedback-summary-mark="needs_revision"');
    expect(html).toContain('aria-label="Feedback: Like, Check, Important, Needs revision"');
  });

  it('renders grouped comment and region counts without comment text', () => {
    const entry = entryFixture({
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
    const html = renderStatic(<CanvasFeedbackSummary entry={entry} />);

    expect(canvasFeedbackEntryHasFeedback(entry)).toBe(true);
    expect(html).toContain('data-canvas-feedback-summary-comments="2"');
    expect(html).toContain('data-canvas-feedback-summary-regions="1"');
    expect(html).toContain('aria-label="Feedback: Comments: 2, Annotations: 1"');
    expect(html).not.toContain('overall direction');
    expect(html).not.toContain('second pass');
    expect(html).not.toContain('face detail');
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
