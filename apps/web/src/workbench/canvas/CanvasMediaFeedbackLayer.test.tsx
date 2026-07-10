import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CanvasFeedbackSpatialItem } from '@debrute/canvas-core';
import { CanvasMediaFeedbackLayer } from './CanvasMediaFeedbackLayer';

const NOW = '2026-06-21T12:00:00.000Z';

describe('CanvasMediaFeedbackLayer', () => {
  it('renders numbered pins and rectangles without comments', () => {
    const html = renderToStaticMarkup(
      <CanvasMediaFeedbackLayer
        items={spatialItemsFixture()}
        mode={undefined}
        onRegionDraft={() => undefined}
      />
    );

    expect(html).toContain('canvas-media-feedback-layer');
    expect(html).toContain('data-canvas-feedback-label="1"');
    expect(html).toContain('data-canvas-feedback-label="2"');
    expect(html).toContain('canvas-media-feedback-pin');
    expect(html).toContain('canvas-media-feedback-region--rect');
    expect(html).not.toContain('pin comment');
    expect(html).not.toContain('rect comment');
  });

  it('renders numbered pending draft geometry from Workbench state after pointer interaction finishes', () => {
    const pointHtml = renderToStaticMarkup(
      <CanvasMediaFeedbackLayer
        items={[]}
        mode={undefined}
        draftRegion={{
          label: 3,
          geometry: { type: 'point', x: 0.4, y: 0.6 }
        }}
        onRegionDraft={() => undefined}
      />
    );
    const rectHtml = renderToStaticMarkup(
      <CanvasMediaFeedbackLayer
        items={[]}
        mode={undefined}
        draftRegion={{
          label: 4,
          geometry: { type: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
        }}
        onRegionDraft={() => undefined}
      />
    );

    expect(pointHtml).toContain('canvas-media-feedback-pin');
    expect(pointHtml).toContain('draft');
    expect(pointHtml).toContain('data-canvas-feedback-label="3"');
    expect(pointHtml).toContain('>3</span>');
    expect(pointHtml).toContain('left:40%');
    expect(pointHtml).toContain('top:60%');
    expect(rectHtml).toContain('canvas-media-feedback-region--rect');
    expect(rectHtml).toContain('draft');
    expect(rectHtml).toContain('data-canvas-feedback-label="4"');
    expect(rectHtml).toContain('>4</span>');
    expect(rectHtml).toContain('width:30%');
    expect(rectHtml).toContain('height:40%');
  });

});

function spatialItemsFixture(): CanvasFeedbackSpatialItem[] {
  return [{
      id: 'region-1',
      label: 1,
      kind: 'pin',
      scope: 'file',
      geometry: { type: 'point', x: 0.25, y: 0.5 },
      comment: 'pin comment',
      createdAt: NOW,
      updatedAt: NOW
    }, {
      id: 'region-2',
      label: 2,
      kind: 'region',
      scope: 'file',
      geometry: { type: 'rect', x: 0.4, y: 0.2, width: 0.25, height: 0.2 },
      comment: 'rect comment',
      createdAt: NOW,
      updatedAt: NOW
    }];
}
