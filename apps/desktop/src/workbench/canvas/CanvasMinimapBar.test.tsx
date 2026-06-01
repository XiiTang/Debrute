import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createCanvasDocument, type CanvasProjection } from '@axis/canvas-core';
import { CanvasMinimapBar } from './CanvasMinimapBar';
import type { CanvasNavigationState } from './canvasMinimap';
import { CANVAS_MINIMAP_PANEL_SIZE, canvasMinimapButtonRect, placeCanvasMinimapPanel } from '../shell/floatingBars';

describe('CanvasMinimapBar', () => {
  it('renders a disabled Mini Map button without valid navigation content', () => {
    const html = renderToStaticMarkup(
      <CanvasMinimapBar
        canvas={undefined}
        projection={undefined}
        selection={undefined}
        navigationState={undefined}
        open={false}
        onOpenChange={() => undefined}
        panelPlacement={panelPlacementFixture}
      />
    );

    expect(html).toContain('<button');
    expect(html).toContain('class="canvas-minimap-bar"');
    expect(html).toContain('data-testid="canvas-minimap-bar"');
    expect(html).toContain('aria-label="Mini Map"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('<div class="canvas-minimap-bar"');
    expect(html).not.toContain('data-testid="canvas-minimap-panel"');
  });

  it('renders simplified nodes, selected nodes, and the viewport when open', () => {
    const canvas = createCanvasDocument({ id: 'minimap-canvas', title: 'Minimap Canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [
        nodeFixture('flow/a.png', 0, 0),
        nodeFixture('flow/selected.png', 800, 400)
      ],
      edges: [],
      diagnostics: []
    };
    const placement = placeCanvasMinimapPanel({
      buttonRect: canvasMinimapButtonRect({ x: 0, y: 0, width: 1000, height: 700 }),
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 }
    });

    const html = renderToStaticMarkup(
      <CanvasMinimapBar
        canvas={canvas}
        projection={projection}
        selection={{ kind: 'node', projectRelativePath: 'flow/selected.png' }}
        navigationState={navigationState}
        open={true}
        onOpenChange={() => undefined}
        panelPlacement={placement}
      />
    );

    expect(html).toContain('data-testid="canvas-minimap-panel"');
    expect(html).toContain(`width:${CANVAS_MINIMAP_PANEL_SIZE.width}px`);
    expect(html).toContain('data-minimap-node-path="flow/a.png"');
    expect(html).toContain('data-minimap-node-path="flow/selected.png"');
    expect(html).toContain('class="canvas-minimap-node selected"');
    expect(html).toContain('class="canvas-minimap-viewport"');
    expect(html).not.toContain('Close Mini Map');
    expect(html).not.toContain('canvas-minimap-close');
    expect(html).not.toContain('<div class="canvas-minimap-bar"');
    expect(html).not.toContain('axis-project-file://');
    expect(html).not.toContain('canvas-node-element');
    expect(html).not.toContain('flow/a.png</');
  });

});

const panelPlacementFixture = placeCanvasMinimapPanel({
  buttonRect: canvasMinimapButtonRect({ x: 0, y: 0, width: 1000, height: 700 }),
  viewportRect: { x: 0, y: 0, width: 1000, height: 700 }
});

const navigationState: CanvasNavigationState = {
  canvasId: 'minimap-canvas',
  surfaceSize: { width: 1000, height: 500 },
  viewport: { x: -100, y: -50, zoom: 0.5 },
  requestViewportChange: () => undefined
};

function nodeFixture(path: string, x: number, y: number): CanvasProjection['nodes'][number] {
  return {
    projectRelativePath: path,
    nodeKind: 'file',
    mediaKind: 'image',
    x,
    y,
    width: 200,
    height: 120,
    z: 0,
    visible: true,
    locked: false,
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'image/png',
      fileUrl: `axis-project-file://project/${path}`,
      revision: 'rev'
    }
  };
}
