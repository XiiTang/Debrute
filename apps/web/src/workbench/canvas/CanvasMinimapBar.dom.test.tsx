import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasDocument, CanvasProjection } from '@debrute/canvas-core';
import { CanvasMinimapBar, formatCanvasMinimapZoomLabel } from './CanvasMinimapBar';
import { createCanvasOverlayRuntime } from './CanvasOverlayRuntime';
import type { CanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import { createCanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import type { CanvasCamera } from './runtime/canvasCamera';
import { CANVAS_CAMERA_IDLE_MS } from './runtime/canvasCamera.js';
import type { CanvasSelection } from './runtime/canvasSelection.js';
import { CANVAS_MINIMAP_PANEL_SIZE, canvasMinimapButtonRect, placeCanvasMinimapPanel } from '../shell/floatingBars';
import { I18nProvider } from '../i18n';

function renderStaticWithI18n(element: ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      {element}
    </I18nProvider>
  );
}

function createCanvasDocument(input: { id: string }): CanvasDocument {
  return {
    id: input.id,
    name: input.id,
    nodeElements: [],
    annotations: [],
    preferences: { showDiagnostics: true }
  };
}

describe('CanvasMinimapBar', () => {
  it('formats zoom labels as integer percentages below one and decimals at or above one', () => {
    expect(formatCanvasMinimapZoomLabel(0.1234)).toBe('12%');
    expect(formatCanvasMinimapZoomLabel(0.5)).toBe('50%');
    expect(formatCanvasMinimapZoomLabel(9.99)).toBe('9.99');
  });

  it('renders a disabled Mini Map button without valid navigation content', () => {
    const html = renderStaticWithI18n(
      <CanvasMinimapBar
        canvas={undefined}
        runtime={undefined}
        overlayRuntime={createCanvasOverlayRuntime()}
        open={false}
        onOpenChange={() => undefined}
        panelPlacement={panelPlacementFixture}
      />
    );

    expect(html).toContain('<button');
    expect(html).toContain('canvas-minimap-bar');
    expect(html).toContain('db-canvas-control');
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
    const runtime = runtimeFixture(projection);

    const html = renderStaticWithI18n(
      <CanvasMinimapBar
        canvas={canvas}
        runtime={runtime}
        overlayRuntime={createCanvasOverlayRuntime()}
        open={true}
        onOpenChange={() => undefined}
        panelPlacement={placement}
      />
    );

    expect(html).toContain('data-testid="canvas-minimap-panel"');
    expect(html).toContain(`width:${CANVAS_MINIMAP_PANEL_SIZE.width}px`);
    expect(html).toContain('data-testid="canvas-minimap-button-zoom"');
    expect(html).toContain('data-minimap-node-path="flow/a.png"');
    expect(html).toContain('data-minimap-node-path="flow/selected.png"');
    expect(html).toContain('class="canvas-minimap-node selected"');
    expect(html).toContain('class="canvas-minimap-viewport"');
    expect(html).toContain('50%');
    expect(html).not.toContain('data-testid="canvas-minimap-zoom"');
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
    const runtime = createRuntime({
      canvasId: canvas.id,
      camera: { x: 0, y: 0, z: 1 },
      selection: { kind: 'nodes', projectRelativePaths: [durableNode.projectRelativePath] },
      nodes: [{ ...durableNode, width: 300, height: 160 }]
    });
    runtime.bindSurface({
      surface: fakeElement({ left: 0, top: 0, width: 1000, height: 500 }) as unknown as HTMLElement
    });

    const html = renderStaticWithI18n(
      <CanvasMinimapBar
        canvas={canvas}
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

  it('updates the zoom label when the canvas camera changes', async () => {
    const canvas = createCanvasDocument({ id: 'minimap-live-zoom-canvas' });
    const nodes = [
      nodeFixture('flow/a.png', 0, 0),
      nodeFixture('flow/selected.png', 800, 400)
    ];
    const runtime = runtimeFixture({ canvasId: canvas.id, nodes, edges: [], diagnostics: [] });

    await withRenderedMinimap({
      canvas,
      runtime
    }, async ({ container }) => {
      expect(readButtonZoomLabel(container)).toBe('50%');
      expect(container.querySelector('[data-testid="canvas-minimap-zoom"]')).toBeNull();

      await act(async () => {
        runtime.camera.setCamera({ x: 0, y: 0, z: 9.99 });
      });

      expect(readButtonZoomLabel(container)).toBe('9.99');
      expect(container.querySelector('[data-testid="canvas-minimap-zoom"]')).toBeNull();
    });
  });

  it('does not read or copy presented nodes after camera movement while closed', async () => {
    vi.useFakeTimers();
    const canvas = createCanvasDocument({ id: 'minimap-closed-canvas' });
    const projection = {
      canvasId: canvas.id,
      nodes: [nodeFixture('flow/a.png', 0, 0)],
      edges: [],
      diagnostics: []
    } satisfies CanvasProjection;
    const runtime = runtimeFixture(projection);
    const getPresentedNodes = vi.spyOn(runtime.scene, 'getPresentedNodes');

    try {
      await withRenderedMinimap({ canvas, runtime, open: false }, async () => {
        getPresentedNodes.mockClear();
        await act(async () => {
          runtime.camera.setCamera({ x: -200, y: 0, z: 0.5 });
          vi.advanceTimersByTime(CANVAS_CAMERA_IDLE_MS);
        });
        expect(getPresentedNodes).not.toHaveBeenCalled();
      });
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('rejects a Runtime owned by a different Canvas', () => {
    const canvas = createCanvasDocument({ id: 'current-canvas' });
    const runtime = createRuntime({
      canvasId: 'stale-canvas',
      camera: { x: 0, y: 0, z: 1 },
      selection: undefined,
      nodes: [nodeFixture('flow/a.png', 0, 0)]
    });
    runtime.bindSurface({
      surface: fakeElement({ left: 0, top: 0, width: 1000, height: 500 }) as unknown as HTMLElement
    });
    const getPresentedNodes = vi.spyOn(runtime.scene, 'getPresentedNodes');

    const html = renderStaticWithI18n(
      <CanvasMinimapBar
        canvas={canvas}
        runtime={runtime}
        overlayRuntime={createCanvasOverlayRuntime()}
        open={true}
        onOpenChange={() => undefined}
        panelPlacement={panelPlacementFixture}
      />
    );

    expect(html).toContain('disabled=""');
    expect(html).not.toContain('data-testid="canvas-minimap-panel"');
    expect(html).not.toContain('data-testid="canvas-minimap-button-zoom"');
    expect(getPresentedNodes).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('coalesces open Minimap selection updates to one render per frame', async () => {
    const canvas = createCanvasDocument({ id: 'minimap-selection-frame-canvas' });
    const nodes = [
      nodeFixture('flow/a.png', 0, 0),
      nodeFixture('flow/b.png', 300, 0),
      nodeFixture('flow/c.png', 600, 0)
    ];
    const runtime = createCanvasEditorRuntime({
      canvasId: canvas.id,
      initialProjection: { canvasId: canvas.id, nodes, edges: [], diagnostics: [] },
      submitManualLayout: async () => undefined,
      selection: { kind: 'nodes', projectRelativePaths: ['flow/a.png'] }
    });
    runtime.bindSurface({
      surface: fakeElement({ left: 0, top: 0, width: 1000, height: 500 }) as unknown as HTMLElement
    });
    let pendingFrame: FrameRequestCallback | undefined;
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        pendingFrame = callback;
        return 1;
      });
    const cancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    try {
      await withRenderedMinimap({ canvas, runtime }, async ({ container }) => {
        expect(container.querySelector('[data-minimap-node-path="flow/a.png"]')?.classList.contains('selected')).toBe(true);

        await act(async () => {
          runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['flow/b.png'] });
          runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['flow/c.png'] });
        });

        expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
        expect(container.querySelector('[data-minimap-node-path="flow/a.png"]')?.classList.contains('selected')).toBe(true);
        await act(async () => {
          pendingFrame?.(0);
        });
        expect(container.querySelector('[data-minimap-node-path="flow/c.png"]')?.classList.contains('selected')).toBe(true);
      });
    } finally {
      runtime.dispose();
      requestAnimationFrame.mockRestore();
      cancelAnimationFrame.mockRestore();
    }
  });

  it('coalesces live Scene geometry to one local Minimap render per frame', async () => {
    const canvas = createCanvasDocument({ id: 'minimap-presentation-frame-canvas' });
    const nodes = [
      nodeFixture('flow/a.png', 0, 0),
      nodeFixture('flow/b.png', 300, 0),
      nodeFixture('flow/c.png', 600, 0)
    ];
    const runtime = createCanvasEditorRuntime({
      canvasId: canvas.id,
      initialProjection: { canvasId: canvas.id, nodes, edges: [], diagnostics: [] },
      submitManualLayout: async () => undefined
    });
    runtime.bindSurface({
      surface: fakeElement({ left: 0, top: 0, width: 1000, height: 500 }) as unknown as HTMLElement
    });
    let pendingFrame: FrameRequestCallback | undefined;
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        pendingFrame = callback;
        return 1;
      });
    const cancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    try {
      await withRenderedMinimap({ canvas, runtime }, async ({ container }) => {
        const before = container.querySelector('[data-minimap-node-path="flow/b.png"]')?.getAttribute('x');

        await act(async () => {
          runtime.input.beginNodeMove({
            pointerId: 1,
            projectRelativePath: 'flow/b.png',
            screenPoint: { x: 0, y: 0 }
          });
          runtime.input.updatePointerInteraction({ pointerId: 1, screenPoint: { x: 25, y: 0 } });
          runtime.input.updatePointerInteraction({ pointerId: 1, screenPoint: { x: 50, y: 0 } });
        });

        expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
        expect(container.querySelector('[data-minimap-node-path="flow/b.png"]')?.getAttribute('x')).toBe(before);
        await act(async () => {
          pendingFrame?.(0);
        });
        expect(container.querySelector('[data-minimap-node-path="flow/b.png"]')?.getAttribute('x')).not.toBe(before);
      });
    } finally {
      runtime.input.cancelPointerInteraction(1);
      runtime.dispose();
      requestAnimationFrame.mockRestore();
      cancelAnimationFrame.mockRestore();
    }
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
      fileUrl: `/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${path}?v=rev`,
      revision: 'rev'
    }
  };
}

function runtimeFixture(projection?: CanvasProjection): CanvasEditorRuntime {
  const runtime = createRuntime({
    canvasId: projection?.canvasId,
    camera: { x: -100, y: -50, z: 0.5 },
    selection: { kind: 'nodes', projectRelativePaths: ['flow/selected.png'] },
    nodes: projection?.nodes
  });
  runtime.bindSurface({
    surface: fakeElement({ left: 0, top: 0, width: 1000, height: 500 }) as unknown as HTMLElement
  });
  return runtime;
}

function createRuntime(input: {
  canvasId?: string | undefined;
  camera: CanvasCamera;
  selection: CanvasSelection | undefined;
  nodes?: CanvasProjection['nodes'] | undefined;
}): CanvasEditorRuntime {
  return createCanvasEditorRuntime({
    canvasId: input.canvasId ?? 'minimap-canvas',
    initialProjection: {
      canvasId: input.canvasId ?? 'minimap-canvas',
      nodes: input.nodes ?? (input.selection?.kind === 'nodes'
        ? input.selection.projectRelativePaths.map((path) => nodeFixture(path, 0, 0))
        : []),
      edges: [],
      diagnostics: []
    },
    submitManualLayout: async () => undefined,
    camera: input.camera,
    selection: input.selection
  });
}

async function withRenderedMinimap(
  input: {
    canvas: ReturnType<typeof createCanvasDocument>;
    runtime: CanvasEditorRuntime;
    open?: boolean | undefined;
  },
  callback: (input: { container: HTMLDivElement; root: Root }) => Promise<void>
): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <CanvasMinimapBar
            canvas={input.canvas}
            runtime={input.runtime}
            overlayRuntime={createCanvasOverlayRuntime()}
            open={input.open ?? true}
            onOpenChange={() => undefined}
            panelPlacement={panelPlacementFixture}
          />
        </I18nProvider>
      );
    });
    await callback({ container, root });
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}

function readButtonZoomLabel(container: ParentNode): string {
  const label = container.querySelector('[data-testid="canvas-minimap-button-zoom"]');
  if (!label) {
    throw new Error('Expected minimap button zoom label');
  }
  return label.textContent ?? '';
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
