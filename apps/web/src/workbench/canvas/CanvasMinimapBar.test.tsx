import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createCanvasDocument, type CanvasProjection } from '@debrute/canvas-core';
import { CanvasMinimapBar } from './CanvasMinimapBar';
import { createCanvasOverlayRuntime } from './CanvasOverlayRuntime';
import type { CanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import { createCanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import { CANVAS_MINIMAP_PANEL_SIZE, canvasMinimapButtonRect, placeCanvasMinimapPanel } from '../shell/floatingBars';

describe('CanvasMinimapBar', () => {
  it('renders a disabled Mini Map button without valid navigation content', () => {
    const html = renderToStaticMarkup(
      <CanvasMinimapBar
        canvas={undefined}
        nodes={undefined}
        runtime={undefined}
        overlayRuntime={createCanvasOverlayRuntime()}
        open={false}
        onOpenChange={() => undefined}
        panelPlacement={panelPlacementFixture}
      />
    );

    expect(html).toContain('<button');
    expect(html).toContain('canvas-minimap-bar');
    expect(html).toContain('data-testid="canvas-minimap-bar"');
    expect(html).toContain('aria-label="Mini Map"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('db-icon-button');
    expect(html).not.toContain('db-floating-bar canvas-minimap-bar');
    expect(html).not.toContain('<div class="canvas-minimap-bar"');
    expect(html).not.toContain('data-testid="canvas-minimap-panel"');
  });

  it('renders simplified nodes, selected nodes, and the camera when open', () => {
    const canvas = createCanvasDocument({ id: 'minimap-canvas' });
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
    const runtime = runtimeFixture();

    const html = renderToStaticMarkup(
      <CanvasMinimapBar
        canvas={canvas}
        nodes={projection.nodes}
        runtime={runtime}
        overlayRuntime={createCanvasOverlayRuntime()}
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
    expect(html).not.toContain('/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/');
    expect(html).not.toContain('canvas-node-element');
    expect(html).not.toContain('flow/a.png</');
  });

  it('renders current node geometry instead of durable projection geometry', () => {
    const canvas = createCanvasDocument({ id: 'minimap-draft-canvas' });
    const durableNode = nodeFixture('flow/a.png', 0, 0);
    const runtime = createCanvasEditorRuntime({
      camera: { x: 0, y: 0, z: 1 },
      selection: { kind: 'node', projectRelativePath: durableNode.projectRelativePath }
    });
    runtime.bindSurface({
      surface: fakeElement({ left: 0, top: 0, width: 1000, height: 500 }) as unknown as HTMLElement
    });

    const html = renderToStaticMarkup(
      <CanvasMinimapBar
        canvas={canvas}
        nodes={[{ ...durableNode, width: 300, height: 160 }]}
        runtime={runtime}
        overlayRuntime={createCanvasOverlayRuntime()}
        open={true}
        onOpenChange={() => undefined}
        panelPlacement={panelPlacementFixture}
      />
    );

    expect(html).toContain('data-minimap-node-path="flow/a.png"');
    expect(html).toContain('width="60"');
    expect(html).toContain('height="32"');
    expect(html).not.toContain('width="40"');
    expect(html).not.toContain('height="24"');
  });

});

const panelPlacementFixture = placeCanvasMinimapPanel({
  buttonRect: canvasMinimapButtonRect({ x: 0, y: 0, width: 1000, height: 700 }),
  viewportRect: { x: 0, y: 0, width: 1000, height: 700 }
});

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
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'image/png',
      fileUrl: `http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${path}?v=rev`,
      revision: 'rev'
    }
  };
}

function runtimeFixture(): CanvasEditorRuntime {
  const runtime = createCanvasEditorRuntime({
    camera: { x: -100, y: -50, z: 0.5 },
    selection: { kind: 'node', projectRelativePath: 'flow/selected.png' }
  });
  runtime.bindSurface({
    surface: fakeElement({ left: 0, top: 0, width: 1000, height: 500 }) as unknown as HTMLElement
  });
  return runtime;
}

function fakeElement(rect: { left: number; top: number; width: number; height: number }): {
  style: {
    setProperty(): void;
    transform: string;
  };
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
} {
  return {
    style: {
      setProperty: () => undefined,
      transform: ''
    },
    getBoundingClientRect: () => rect
  };
}
