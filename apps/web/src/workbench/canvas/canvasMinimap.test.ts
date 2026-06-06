import { describe, expect, it } from 'vitest';
import type { CanvasProjection } from '@debrute/canvas-core';
import {
  beginCanvasMinimapDrag,
  buildCanvasMinimapStaticModel,
  buildCanvasMinimapModel,
  buildCanvasMinimapViewportModel,
  canvasPointToMinimapPoint,
  canvasCameraForMinimapCenter,
  clientPointToMinimapPoint,
  minimapPointToCanvasPoint,
  updateCanvasMinimapDrag
} from './canvasMinimap';

describe('canvasMinimap geometry', () => {
  it('builds content bounds from valid visible nodes and the current camera', () => {
    const model = buildCanvasMinimapModel({
      nodes: [
        nodeFixture('flow/a.png', 0, 0, 100, 100),
        nodeFixture('flow/selected.png', 800, 400, 200, 100),
        { ...nodeFixture('flow/hidden.png', -1000, -1000, 100, 100), visible: false },
        nodeFixture('flow/invalid.png', Number.NaN, 0, 100, 100)
      ],
      selection: { kind: 'node', projectRelativePath: 'flow/selected.png' },
      camera: { x: -100, y: -50, z: 0.5 },
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

  it('splits static node geometry from dynamic viewport geometry', () => {
    const staticModel = buildCanvasMinimapStaticModel({
      nodes: [
        nodeFixture('flow/a.png', 0, 0, 100, 100),
        nodeFixture('flow/selected.png', 800, 400, 200, 100)
      ],
      selection: { kind: 'node', projectRelativePath: 'flow/selected.png' },
      camera: { x: -100, y: -50, z: 0.5 },
      surfaceSize: { width: 1000, height: 500 },
      minimapSize: { width: 220, height: 150 },
      padding: 10
    });

    expect(staticModel?.nodeRects.map((node) => node.projectRelativePath)).toEqual([
      'flow/a.png',
      'flow/selected.png'
    ]);
    expect(staticModel?.nodeRects.find((node) => node.projectRelativePath === 'flow/selected.png')?.selected).toBe(true);

    const viewport = buildCanvasMinimapViewportModel({
      transform: staticModel!.transform,
      camera: { x: -200, y: -100, z: 0.5 },
      surfaceSize: { width: 1000, height: 500 }
    });

    expect(viewport?.visibleRect).toEqual({ x: 400, y: 200, width: 2000, height: 1000 });
    expect(viewport?.viewportRect.x).toBeCloseTo(46.3636, 4);
    expect(viewport?.viewportRect.y).toBeCloseTo(43.1818, 4);
  });

  it('round trips Canvas and minimap points through the model transform', () => {
    const model = buildCanvasMinimapModel({
      nodes: [nodeFixture('flow/a.png', 0, 0, 100, 100)],
      selection: undefined,
      camera: { x: -100, y: -50, z: 0.5 },
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

  it('creates a camera centered on a minimap Canvas point without changing z', () => {
    expect(canvasCameraForMinimapCenter({
      center: { x: 1000, y: 500 },
      camera: { x: -40, y: -20, z: 0.5 },
      surfaceSize: { width: 1000, height: 500 }
    })).toEqual({ x: 0, y: 0, z: 0.5 });
  });

  it('preserves pointer offset when dragging from inside the current visible rectangle', () => {
    const model = buildCanvasMinimapModel({
      nodes: [nodeFixture('flow/a.png', 0, 0, 100, 100)],
      selection: undefined,
      camera: { x: -100, y: -50, z: 0.5 },
      surfaceSize: { width: 1000, height: 500 },
      minimapSize: { width: 220, height: 150 },
      padding: 10
    })!;
    const startPoint = canvasPointToMinimapPoint({ x: 1200, y: 600 }, model.transform);
    const drag = beginCanvasMinimapDrag({
      pointerId: 7,
      minimapPoint: startPoint,
      model,
      camera: { x: -100, y: -50, z: 0.5 },
      surfaceSize: { width: 1000, height: 500 }
    });
    const nextPoint = canvasPointToMinimapPoint({ x: 1300, y: 700 }, model.transform);

    expect(drag.camera).toEqual({ x: -100, y: -50, z: 0.5 });
    expect(updateCanvasMinimapDrag({
      dragState: drag.dragState,
      minimapPoint: nextPoint,
      camera: { x: -100, y: -50, z: 0.5 },
      surfaceSize: { width: 1000, height: 500 }
    })).toEqual({ x: -150, y: -100, z: 0.5 });
  });

  it('keeps using the drag-start transform when camera updates change minimap bounds', () => {
    const surfaceSize = { width: 1000, height: 500 };
    const camera = { x: 0, y: 0, z: 1 };
    const initialModel = buildCanvasMinimapModel({
      nodes: [nodeFixture('flow/a.png', 0, 0, 100, 100)],
      selection: undefined,
      camera,
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
      camera,
      surfaceSize
    });
    const firstCamera = updateCanvasMinimapDrag({
      dragState: drag.dragState,
      minimapPoint: { x: startPoint.x + 80, y: startPoint.y },
      camera,
      surfaceSize
    });
    const updatedModel = buildCanvasMinimapModel({
      nodes: [nodeFixture('flow/a.png', 0, 0, 100, 100)],
      selection: undefined,
      camera: firstCamera,
      surfaceSize,
      minimapSize: { width: 220, height: 150 },
      padding: 10
    })!;

    expect(updatedModel.transform.contentBounds.width).toBeGreaterThan(initialModel.transform.contentBounds.width);
    expect(updateCanvasMinimapDrag({
      dragState: drag.dragState,
      minimapPoint: { x: startPoint.x + 100, y: startPoint.y },
      camera: firstCamera,
      surfaceSize
    })).toEqual({ x: -500, y: 0, z: 1 });
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

  it('returns undefined when there are no valid visible nodes or camera z is invalid', () => {
    expect(buildCanvasMinimapModel({
      nodes: [{ ...nodeFixture('flow/hidden.png', 0, 0, 100, 100), visible: false }],
      selection: undefined,
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 1000, height: 500 },
      minimapSize: { width: 220, height: 150 }
    })).toBeUndefined();

    expect(buildCanvasMinimapModel({
      nodes: [nodeFixture('flow/a.png', 0, 0, 100, 100)],
      selection: undefined,
      camera: { x: 0, y: 0, z: 0 },
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
      fileUrl: `http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${path}?v=rev`,
      revision: 'rev'
    }
  };
}
