import { describe, expect, it } from 'vitest';
import type { CanvasProjection } from '@axis/canvas-core';
import {
  beginCanvasMinimapDrag,
  buildCanvasMinimapModel,
  canvasPointToMinimapPoint,
  canvasViewportForMinimapCenter,
  clientPointToMinimapPoint,
  minimapPointToCanvasPoint,
  updateCanvasMinimapDrag
} from './canvasMinimap';

describe('canvasMinimap geometry', () => {
  it('builds content bounds from valid visible nodes and the current viewport', () => {
    const model = buildCanvasMinimapModel({
      nodes: [
        nodeFixture('flow/a.png', 0, 0, 100, 100),
        nodeFixture('flow/selected.png', 800, 400, 200, 100),
        { ...nodeFixture('flow/hidden.png', -1000, -1000, 100, 100), visible: false },
        nodeFixture('flow/invalid.png', Number.NaN, 0, 100, 100)
      ],
      selection: { kind: 'node', projectRelativePath: 'flow/selected.png' },
      viewport: { x: -100, y: -50, zoom: 0.5 },
      surfaceSize: { width: 1000, height: 500 },
      minimapSize: { width: 220, height: 150 },
      padding: 10
    });

    expect(model).toBeDefined();
    expect(model?.transform.contentBounds).toEqual({ x: 0, y: 0, width: 2200, height: 1100 });
    expect(model?.nodeRects.map((node) => node.projectRelativePath)).toEqual([
      'flow/a.png',
      'flow/selected.png'
    ]);
    expect(model?.nodeRects.find((node) => node.projectRelativePath === 'flow/selected.png')?.selected).toBe(true);
    expect(model?.transform.scale).toBeCloseTo(0.090909, 5);
    expect(model?.viewportRect.x).toBeCloseTo(28.1818, 4);
    expect(model?.viewportRect.y).toBeCloseTo(34.0909, 4);
    expect(model?.viewportRect.width).toBeCloseTo(181.8182, 4);
    expect(model?.viewportRect.height).toBeCloseTo(90.9091, 4);
  });

  it('round trips Canvas and minimap points through the model transform', () => {
    const model = buildCanvasMinimapModel({
      nodes: [nodeFixture('flow/a.png', 0, 0, 100, 100)],
      selection: undefined,
      viewport: { x: -100, y: -50, zoom: 0.5 },
      surfaceSize: { width: 1000, height: 500 },
      minimapSize: { width: 220, height: 150 },
      padding: 10
    });

    expect(model).toBeDefined();
    const minimapPoint = canvasPointToMinimapPoint({ x: 1200, y: 600 }, model!.transform);
    const canvasPoint = minimapPointToCanvasPoint(minimapPoint, model!.transform);

    expect(canvasPoint.x).toBeCloseTo(1200, 5);
    expect(canvasPoint.y).toBeCloseTo(600, 5);
  });

  it('creates a viewport centered on a minimap Canvas point without changing zoom', () => {
    expect(canvasViewportForMinimapCenter({
      center: { x: 1000, y: 500 },
      viewport: { x: -40, y: -20, zoom: 0.5 },
      surfaceSize: { width: 1000, height: 500 }
    })).toEqual({ x: 0, y: 0, zoom: 0.5 });
  });

  it('preserves pointer offset when dragging from inside the current viewport rectangle', () => {
    const model = buildCanvasMinimapModel({
      nodes: [nodeFixture('flow/a.png', 0, 0, 100, 100)],
      selection: undefined,
      viewport: { x: -100, y: -50, zoom: 0.5 },
      surfaceSize: { width: 1000, height: 500 },
      minimapSize: { width: 220, height: 150 },
      padding: 10
    })!;
    const startPoint = canvasPointToMinimapPoint({ x: 1200, y: 600 }, model.transform);
    const drag = beginCanvasMinimapDrag({
      pointerId: 7,
      minimapPoint: startPoint,
      model,
      viewport: { x: -100, y: -50, zoom: 0.5 },
      surfaceSize: { width: 1000, height: 500 }
    });
    const nextPoint = canvasPointToMinimapPoint({ x: 1300, y: 700 }, model.transform);

    expect(drag.viewport).toEqual({ x: -100, y: -50, zoom: 0.5 });
    expect(updateCanvasMinimapDrag({
      dragState: drag.dragState,
      minimapPoint: nextPoint,
      viewport: { x: -100, y: -50, zoom: 0.5 },
      surfaceSize: { width: 1000, height: 500 }
    })).toEqual({ x: -150, y: -100, zoom: 0.5 });
  });

  it('keeps using the drag-start transform when viewport updates change minimap bounds', () => {
    const surfaceSize = { width: 1000, height: 500 };
    const viewport = { x: 0, y: 0, zoom: 1 };
    const initialModel = buildCanvasMinimapModel({
      nodes: [nodeFixture('flow/a.png', 0, 0, 100, 100)],
      selection: undefined,
      viewport,
      surfaceSize,
      minimapSize: { width: 220, height: 150 },
      padding: 10
    })!;
    const startPoint = {
      x: initialModel.viewportRect.x + initialModel.viewportRect.width / 2,
      y: initialModel.viewportRect.y + initialModel.viewportRect.height / 2
    };
    const drag = beginCanvasMinimapDrag({
      pointerId: 7,
      minimapPoint: startPoint,
      model: initialModel,
      viewport,
      surfaceSize
    });
    const firstViewport = updateCanvasMinimapDrag({
      dragState: drag.dragState,
      minimapPoint: { x: startPoint.x + 80, y: startPoint.y },
      viewport,
      surfaceSize
    });
    const updatedModel = buildCanvasMinimapModel({
      nodes: [nodeFixture('flow/a.png', 0, 0, 100, 100)],
      selection: undefined,
      viewport: firstViewport,
      surfaceSize,
      minimapSize: { width: 220, height: 150 },
      padding: 10
    })!;

    expect(updatedModel.transform.contentBounds.width).toBeGreaterThan(initialModel.transform.contentBounds.width);
    expect(updateCanvasMinimapDrag({
      dragState: drag.dragState,
      minimapPoint: { x: startPoint.x + 100, y: startPoint.y },
      viewport: firstViewport,
      surfaceSize
    })).toEqual({ x: -500, y: 0, zoom: 1 });
  });

  it('maps pointer client coordinates into the minimap viewBox', () => {
    expect(clientPointToMinimapPoint({
      clientPoint: { x: 111, y: 86 },
      minimapRect: { x: 10, y: 20, width: 202, height: 132 },
      minimapSize: { width: 220, height: 150 }
    })).toEqual({
      x: 110,
      y: 75
    });
  });

  it('returns undefined when there are no valid visible nodes or the viewport zoom is invalid', () => {
    expect(buildCanvasMinimapModel({
      nodes: [{ ...nodeFixture('flow/hidden.png', 0, 0, 100, 100), visible: false }],
      selection: undefined,
      viewport: { x: 0, y: 0, zoom: 1 },
      surfaceSize: { width: 1000, height: 500 },
      minimapSize: { width: 220, height: 150 }
    })).toBeUndefined();

    expect(buildCanvasMinimapModel({
      nodes: [nodeFixture('flow/a.png', 0, 0, 100, 100)],
      selection: undefined,
      viewport: { x: 0, y: 0, zoom: 0 },
      surfaceSize: { width: 1000, height: 500 },
      minimapSize: { width: 220, height: 150 }
    })).toBeUndefined();
  });
});

function nodeFixture(
  path: string,
  x: number,
  y: number,
  width: number,
  height: number
): CanvasProjection['nodes'][number] {
  return {
    projectRelativePath: path,
    nodeKind: 'file',
    mediaKind: 'image',
    x,
    y,
    width,
    height,
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
