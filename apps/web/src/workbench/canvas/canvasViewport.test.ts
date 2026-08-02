import { describe, expect, it } from 'vitest';
import type { CanvasProjection } from '@debrute/canvas-core';
import {
  canvasEdgeSegmentsForProjectionEdges,
  canvasVisibleRect,
  queryCanvasViewport,
  segmentIntersectsRect
} from './canvasViewport.js';

describe('canvas viewport geometry', () => {
  it('derives the exact visible rect from the camera', () => {
    const camera = { x: -200, y: -100, z: 2 };
    const visible = canvasVisibleRect({ camera, surfaceSize: { width: 1000, height: 600 } });

    expect(visible).toEqual({ x: 100, y: 50, width: 500, height: 300 });
  });

  it('rejects invalid camera zoom values', () => {
    expect(() => canvasVisibleRect({
      camera: { x: 0, y: 0, z: 0 },
      surfaceSize: { width: 100, height: 100 }
    })).toThrow('Canvas camera z must be a positive finite number.');
  });

  it('queries visible node and edge identities without changing scene membership', () => {
    const projection = projectionFixture([
      nodeFixture('flow/a.png', 0, 0),
      nodeFixture('flow/b.png', 300, 0),
      nodeFixture('flow/far.png', 5000, 0)
    ], [{
      id: 'visible-edge',
      sourceProjectRelativePath: 'flow/a.png',
      targetProjectRelativePath: 'flow/b.png'
    }, {
      id: 'far-edge',
      sourceProjectRelativePath: 'flow/b.png',
      targetProjectRelativePath: 'flow/far.png'
    }]);
    const edges = canvasEdgeSegmentsForProjectionEdges(projection);
    const atOrigin = queryCanvasViewport({
      nodes: projection.nodes,
      edges,
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 }
    });
    const atFar = queryCanvasViewport({
      nodes: projection.nodes,
      edges,
      camera: { x: -5000, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 }
    });

    expect([...atOrigin.visibleNodePaths]).toEqual(['flow/a.png', 'flow/b.png']);
    expect([...atOrigin.visibleEdgeIds]).toEqual(['visible-edge', 'far-edge']);
    expect([...atFar.visibleNodePaths]).toEqual(['flow/far.png']);
    expect([...atFar.visibleEdgeIds]).toEqual(['far-edge']);
    expect(projection.nodes).toHaveLength(3);
    expect(edges).toHaveLength(2);
  });

  it('detects endpoint and crossing edge segment intersections', () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 };

    expect(segmentIntersectsRect({ x1: 10, y1: 10, x2: 200, y2: 10 }, rect)).toBe(true);
    expect(segmentIntersectsRect({ x1: -50, y1: 50, x2: 150, y2: 50 }, rect)).toBe(true);
    expect(segmentIntersectsRect({ x1: -50, y1: -50, x2: -10, y2: -10 }, rect)).toBe(false);
  });

  it('routes structure edges through a shared trunk', () => {
    const projection = projectionFixture([
      nodeFixture('flow/parent', 0, 40),
      nodeFixture('flow/child-a.png', 500, 0),
      nodeFixture('flow/child-b.png', 500, 200)
    ], [{
      id: 'parent-to-a',
      sourceProjectRelativePath: 'flow/parent',
      targetProjectRelativePath: 'flow/child-a.png'
    }, {
      id: 'parent-to-b',
      sourceProjectRelativePath: 'flow/parent',
      targetProjectRelativePath: 'flow/child-b.png'
    }]);

    const edges = canvasEdgeSegmentsForProjectionEdges(projection);

    expect(edges[0]?.points).toEqual([
      { x: 200, y: 100 },
      { x: 296, y: 100 },
      { x: 296, y: 60 },
      { x: 500, y: 60 }
    ]);
    expect(edges[1]?.points[1]?.x).toBe(edges[0]?.points[1]?.x);
  });

  it('keeps routed edges visible when an orthogonal trunk crosses the viewport', () => {
    const projection = projectionFixture([
      textNodeFixture('flow/source.txt', 0, -5000),
      textNodeFixture('flow/target.txt', 5000, 5000)
    ], [{
      id: 'vertical-trunk',
      sourceProjectRelativePath: 'flow/source.txt',
      targetProjectRelativePath: 'flow/target.txt'
    }]);
    const edges = canvasEdgeSegmentsForProjectionEdges(projection);
    const result = queryCanvasViewport({
      nodes: projection.nodes,
      edges,
      camera: { x: -29600, y: 0, z: 100 },
      surfaceSize: { width: 100, height: 100 }
    });

    expect([...result.visibleNodePaths]).toEqual([]);
    expect([...result.visibleEdgeIds]).toEqual(['vertical-trunk']);
  });

  it('queries a low-zoom viewport from actual scene entities without changing membership', () => {
    const projection = projectionFixture([
      nodeFixture('flow/a.png', -50000, -30000),
      nodeFixture('flow/b.png', 50000, 30000),
      nodeFixture('flow/far.png', 200000, 200000)
    ]);
    const before = [...projection.nodes];

    const result = queryCanvasViewport({
      nodes: projection.nodes,
      edges: [],
      camera: { x: 640, y: 360, z: 0.01 },
      surfaceSize: { width: 1280, height: 720 }
    });

    expect([...result.visibleNodePaths]).toEqual(['flow/a.png', 'flow/b.png']);
    expect(projection.nodes).toEqual(before);
  });
});

function projectionFixture(
  nodes: CanvasProjection['nodes'],
  edges: CanvasProjection['edges'] = []
): CanvasProjection {
  return { canvasId: 'canvas', nodes, edges, diagnostics: [] };
}

function nodeFixture(projectRelativePath: string, x: number, y: number): CanvasProjection['nodes'][number] {
  return {
    projectRelativePath,
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
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: 200,
      fileUrl: `/api/projects/p/files/raw/${projectRelativePath}?v=rev`,
      revision: 'rev'
    }
  };
}

function textNodeFixture(projectRelativePath: string, x: number, y: number): CanvasProjection['nodes'][number] {
  return {
    ...nodeFixture(projectRelativePath, x, y),
    mediaKind: 'text',
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'text/plain',
      fileUrl: `/api/projects/p/files/raw/${projectRelativePath}?v=rev`,
      revision: 'rev'
    }
  };
}
