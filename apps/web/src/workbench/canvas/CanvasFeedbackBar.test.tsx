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
        onUpdate={async () => undefined}
        overlayRuntime={createCanvasOverlayRuntime()}
      />
    );

    expect(html).toContain('canvas-feedback-note');
    expect(html).toContain('db-floating-bar canvas-feedback-bar');
    expect(html).toContain('db-input');
    expect(html).toContain('db-icon-button');
    expect(html).toContain('data-canvas-local-wheel="true"');
  });
});
