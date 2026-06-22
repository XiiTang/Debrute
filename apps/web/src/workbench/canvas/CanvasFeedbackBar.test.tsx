import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CanvasFeedbackBar } from './CanvasFeedbackBar';
import { createCanvasOverlayRuntime } from './CanvasOverlayRuntime';

describe('CanvasFeedbackBar', () => {
  it('keeps wheel input local to the feedback note field', () => {
    const html = renderToStaticMarkup(
      <CanvasFeedbackBar
        projectRelativePath="flow/cover.png"
        entry={undefined}
        onUpdate={async () => true}
        overlayRuntime={createCanvasOverlayRuntime()}
      />
    );

    expect(html).toContain('canvas-feedback-note');
    expect(html).toContain('db-floating-bar canvas-feedback-bar');
    expect(html).toContain('db-input');
    expect(html).toContain('db-icon-button');
    expect(html).toContain('data-canvas-local-wheel="true"');
    expect(html).not.toContain('canvas-feedback-local-mode');
  });

  it('renders image-local feedback mode controls and region comments by label', () => {
    const html = renderToStaticMarkup(
      <CanvasFeedbackBar
        projectRelativePath="flow/cover.png"
        entry={{
          projectRelativePath: 'flow/cover.png',
          marks: [],
          note: '',
          nextRegionLabel: 2,
          regions: [{
            id: 'region-1',
            label: 1,
            kind: 'pin',
            geometry: { type: 'point', x: 0.2, y: 0.3 },
            comment: 'face is blurry',
            createdAt: '2026-05-26T12:00:00.000Z',
            updatedAt: '2026-05-26T12:00:00.000Z'
          }],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }}
        onUpdate={async () => true}
        overlayRuntime={createCanvasOverlayRuntime()}
        localFeedbackMode={undefined}
        onLocalFeedbackModeChange={() => undefined}
      />
    );

    expect(html).toContain('canvas-feedback-local-mode');
    expect(html).toContain('aria-label="Add feedback pin"');
    expect(html).toContain('aria-label="Add feedback rectangle"');
    expect(html).toContain('data-canvas-feedback-region-label="1"');
    expect(html).toContain('aria-label="Feedback for region 1"');
    expect(html).toContain('aria-label="Delete feedback region 1"');
    expect(html).toContain('face is blurry');
  });
});
