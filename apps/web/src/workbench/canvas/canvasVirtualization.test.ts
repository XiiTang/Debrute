import { describe, expect, it } from 'vitest';
import type { CanvasProjection } from '@debrute/canvas-core';
import {
  CANVAS_VIRTUAL_REFRESH_MARGIN_SCREEN_PX,
  CANVAS_VIRTUAL_MAX_STALE_AREA_RATIO,
  CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX,
  buildVirtualizedCanvasRenderState,
  canvasEdgeSegmentsForProjectionEdges,
  canvasRectContainsRect,
  canvasVirtualRenderRect,
  canvasVisibleRect,
  createCanvasVirtualizationIndex,
  segmentIntersectsRect,
  shouldRefreshVirtualizedRenderState
} from './canvasVirtualization';

describe('canvas virtualization geometry', () => {
  it('derives visible and overscan rectangles from camera and surface size', () => {
    const camera = { x: -200, y: -100, z: 2 };
    const visible = canvasVisibleRect({ camera, surfaceSize: { width: 1000, height: 600 } });
    const virtual = canvasVirtualRenderRect({ camera, surfaceSize: { width: 1000, height: 600 } });

    expect(visible).toEqual({ x: 100, y: 50, width: 500, height: 300 });
    expect(virtual).toEqual({
      x: 100 - CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX / 2,
      y: 50 - CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX / 2,
      width: 500 + CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX,
      height: 300 + CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX
    });
  });

  it('detects whether one Canvas rect fully contains another', () => {
    expect(canvasRectContainsRect(
      { x: -10, y: -10, width: 120, height: 120 },
      { x: 0, y: 0, width: 100, height: 100 }
    )).toBe(true);
    expect(canvasRectContainsRect(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: -1, y: 0, width: 100, height: 100 }
    )).toBe(false);
  });

  it('refreshes virtualized rendering before live camera movement leaves the overscan rect', () => {
    const currentVirtualRect = canvasVirtualRenderRect({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 1000, height: 600 }
    });

    expect(shouldRefreshVirtualizedRenderState({
      currentVirtualRect,
      camera: { x: -CANVAS_VIRTUAL_REFRESH_MARGIN_SCREEN_PX + 1, y: 0, z: 1 },
      surfaceSize: { width: 1000, height: 600 }
    })).toBe(false);
    expect(shouldRefreshVirtualizedRenderState({
      currentVirtualRect,
      camera: { x: -CANVAS_VIRTUAL_REFRESH_MARGIN_SCREEN_PX - 1, y: 0, z: 1 },
      surfaceSize: { width: 1000, height: 600 }
    })).toBe(true);
  });

  it('refreshes moving render state when zoom-in leaves the previous virtual rect too broad', () => {
    const currentVirtualRect = canvasVirtualRenderRect({
      camera: { x: 0, y: 0, z: 0.1 },
      surfaceSize: { width: 1000, height: 600 }
    });
    const nextVirtualRect = canvasVirtualRenderRect({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 1000, height: 600 }
    });

    expect(currentVirtualRect.width * currentVirtualRect.height).toBeGreaterThan(
      nextVirtualRect.width * nextVirtualRect.height * CANVAS_VIRTUAL_MAX_STALE_AREA_RATIO
    );
    expect(shouldRefreshVirtualizedRenderState({
      currentVirtualRect,
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 1000, height: 600 }
    })).toBe(true);
  });

  it('uses a bounded initial surface size before measurement', () => {
    const rect = canvasVirtualRenderRect({ camera: { x: 0, y: 0, z: 1 }, surfaceSize: undefined });

    expect(rect).toEqual({ x: -768, y: -768, width: 2816, height: 2256 });
  });

  it('rejects invalid camera z values instead of silently changing geometry', () => {
    expect(() => canvasVisibleRect({
      camera: { x: 0, y: 0, z: 0 },
      surfaceSize: { width: 100, height: 100 }
    })).toThrow('Canvas camera z must be a positive finite number.');
  });

  it('renders visible retained nodes, selected nodes, and active nodes without rendering unrelated offscreen nodes', () => {
    const projection = projectionFixture([
      nodeFixture('flow/visible.png', 0, 0),
      nodeFixture('flow/offscreen-image.png', 6000, 0),
      textNodeFixture('flow/offscreen-text.md', 7000, 0),
      directoryFixture('flow/offscreen-directory', 8000, 0),
      nodeFixture('flow/selected-offscreen.png', 6000, 0),
      nodeFixture('flow/active-offscreen.png', 0, 6000),
      nodeFixture('flow/far.png', 6000, 6000),
      textNodeFixture('flow/far.txt', 7000, 7000)
    ]);

    const state = buildVirtualizedCanvasRenderState({
      nodes: projection.nodes,
      edges: [],
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: undefined,
      selection: { kind: 'node', projectRelativePath: 'flow/selected-offscreen.png' },
      activeNodeProjectRelativePaths: ['flow/active-offscreen.png']
    });

    const paths = state.nodes.map((node) => node.projectRelativePath);
    expect(paths).toContain('flow/visible.png');
    expect(paths).toContain('flow/offscreen-image.png');
    expect(paths).toContain('flow/offscreen-text.md');
    expect(paths).toContain('flow/selected-offscreen.png');
    expect(paths).toContain('flow/active-offscreen.png');
    expect(paths).toContain('flow/far.png');
    expect(paths).not.toContain('flow/offscreen-directory');
  });

  it('appends selected and active nodes from the indexed node map', () => {
    const projection = projectionFixture([
      nodeFixture('flow/visible.png', 0, 0),
      nodeFixture('flow/selected-offscreen.png', 9000, 0),
      nodeFixture('flow/active-offscreen.png', 0, 9000),
      nodeFixture('flow/selected-and-active.png', 9000, 9000)
    ]);
    const index = createCanvasVirtualizationIndex({
      nodes: projection.nodes,
      edges: []
    });

    const state = index.render({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 400, height: 300 },
      selection: {
        kind: 'multi',
        items: [
          { kind: 'node', projectRelativePath: 'flow/selected-offscreen.png' },
          { kind: 'node', projectRelativePath: 'flow/selected-and-active.png' }
        ]
      },
      activeNodeProjectRelativePaths: ['flow/active-offscreen.png', 'flow/selected-and-active.png']
    });

    expect(state.nodes.map((node) => node.projectRelativePath)).toEqual([
      'flow/visible.png',
      'flow/selected-offscreen.png',
      'flow/active-offscreen.png',
      'flow/selected-and-active.png'
    ]);
  });

  it('renders all nodes that intersect the virtual window', () => {
    const projection = projectionFixture([
      nodeFixture('flow/intersecting.png', 0, 0),
      nodeFixture('flow/visible.png', 300, 0)
    ]);

    const state = buildVirtualizedCanvasRenderState({
      nodes: projection.nodes,
      edges: [],
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: undefined,
      selection: undefined,
      activeNodeProjectRelativePaths: []
    });

    expect(state.nodes.map((node) => node.projectRelativePath)).toEqual(['flow/intersecting.png', 'flow/visible.png']);
  });

  it('detects endpoint and crossing edge segment intersections', () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 };

    expect(segmentIntersectsRect({ x1: 10, y1: 10, x2: 200, y2: 10 }, rect)).toBe(true);
    expect(segmentIntersectsRect({ x1: 10, y1: 10, x2: 90, y2: 90 }, rect)).toBe(true);
    expect(segmentIntersectsRect({ x1: -50, y1: 50, x2: 150, y2: 50 }, rect)).toBe(true);
    expect(segmentIntersectsRect({ x1: -50, y1: -50, x2: -10, y2: -10 }, rect)).toBe(false);
  });

  it('virtualizes edges independently of mounted endpoint nodes', () => {
    const projection = projectionFixture([
      nodeFixture('flow/source.png', 0, 0),
      textNodeFixture('flow/target.txt', 5000, 0),
      textNodeFixture('flow/outside-a.txt', 0, -5000),
      textNodeFixture('flow/outside-b.txt', 5000, -5000)
    ], [{
      id: 'source-to-target',
      sourceProjectRelativePath: 'flow/source.png',
      targetProjectRelativePath: 'flow/target.txt'
    }, {
      id: 'outside',
      sourceProjectRelativePath: 'flow/outside-a.txt',
      targetProjectRelativePath: 'flow/outside-b.txt'
    }]);

    const state = buildVirtualizedCanvasRenderState({
      nodes: projection.nodes,
      edges: projection.edges,
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: undefined,
      selection: undefined,
      activeNodeProjectRelativePaths: []
    });

    expect(state.nodes.map((node) => node.projectRelativePath)).toEqual([
      'flow/source.png',
      'flow/target.txt',
      'flow/outside-a.txt',
      'flow/outside-b.txt'
    ]);
    expect(state.edges.map((edge) => edge.id)).toEqual(['source-to-target']);
    expect(state.edges[0]?.svgViewBox).not.toBe('-100000 -100000 200000 200000');
  });

  it('keeps edge svg bounds tight at low zoom', () => {
    const projection = projectionFixture([
      nodeFixture('flow/source.png', 0, 0),
      nodeFixture('flow/target.png', 300, 0)
    ], [{
      id: 'source-to-target',
      sourceProjectRelativePath: 'flow/source.png',
      targetProjectRelativePath: 'flow/target.png'
    }]);

    const state = buildVirtualizedCanvasRenderState({
      nodes: projection.nodes,
      edges: projection.edges,
      camera: { x: 0, y: 0, z: 0.03 },
      surfaceSize: { width: 1440, height: 1000 },
      selection: undefined,
      activeNodeProjectRelativePaths: []
    });

    expect(state.virtualRect.width).toBeGreaterThan(49000);
    expect(state.edges[0]?.svgBounds.width).toBeLessThan(400);
    expect(state.edges[0]?.svgBounds.height).toBeLessThan(130);
  });

  it('routes structure edges from parent right edge to child left edge through a shared trunk', () => {
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

    const state = buildVirtualizedCanvasRenderState({
      nodes: projection.nodes,
      edges: projection.edges,
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 900, height: 500 },
      selection: undefined,
      activeNodeProjectRelativePaths: []
    });

    expect(state.edges.map((edge) => edge.id)).toEqual(['parent-to-a', 'parent-to-b']);
    expect(state.edges[0]?.points).toEqual([
      { x: 200, y: 100 },
      { x: 296, y: 100 },
      { x: 296, y: 60 },
      { x: 500, y: 60 }
    ]);
    expect(state.edges[1]?.points).toEqual([
      { x: 200, y: 100 },
      { x: 296, y: 100 },
      { x: 296, y: 260 },
      { x: 500, y: 260 }
    ]);
    expect(state.edges[0]?.path).toBe('M 200 100 L 296 100 L 296 60 L 500 60');
    expect(state.edges[0]?.points[1]?.x).toBe(state.edges[1]?.points[1]?.x);
  });

  it('routes projection edges from the supplied node geometry', () => {
    const projection = projectionFixture([
      nodeFixture('flow/source.png', 120, 50),
      nodeFixture('flow/target.png', 300, 0)
    ], [{
      id: 'source-to-target',
      sourceProjectRelativePath: 'flow/source.png',
      targetProjectRelativePath: 'flow/target.png'
    }]);

    const edges = canvasEdgeSegmentsForProjectionEdges({
      nodes: projection.nodes,
      edges: projection.edges
    });

    expect(edges[0]?.points).toEqual([
      { x: 320, y: 110 },
      { x: 368, y: 110 },
      { x: 368, y: 60 },
      { x: 300, y: 60 }
    ]);
  });

  it('keeps routed edges visible when only an orthogonal trunk segment intersects the camera', () => {
    const projection = projectionFixture([
      textNodeFixture('flow/source.txt', 0, -5000),
      textNodeFixture('flow/target.txt', 5000, 5000)
    ], [{
      id: 'vertical-trunk',
      sourceProjectRelativePath: 'flow/source.txt',
      targetProjectRelativePath: 'flow/target.txt'
    }]);

    const state = buildVirtualizedCanvasRenderState({
      nodes: projection.nodes,
      edges: projection.edges,
      camera: { x: -29600, y: 0, z: 100 },
      surfaceSize: { width: 100, height: 100 },
      selection: undefined,
      activeNodeProjectRelativePaths: []
    });

    expect(state.nodes.map((node) => node.projectRelativePath)).toEqual([
      'flow/source.txt',
      'flow/target.txt'
    ]);
    expect(state.edges.map((edge) => edge.id)).toEqual(['vertical-trunk']);
    expect(state.edges[0]?.points).toEqual([
      { x: 200, y: -4940 },
      { x: 296, y: -4940 },
      { x: 296, y: 5060 },
      { x: 5000, y: 5060 }
    ]);
  });

  it('supports reusing one node and edge index across camera queries', () => {
    const projection = projectionFixture([
      nodeFixture('flow/visible-a.png', 0, 0),
      nodeFixture('flow/visible-b.png', 300, 0),
      textNodeFixture('flow/far.txt', 8000, 0)
    ], [{
      id: 'visible-edge',
      sourceProjectRelativePath: 'flow/visible-a.png',
      targetProjectRelativePath: 'flow/visible-b.png'
    }, {
      id: 'far-edge',
      sourceProjectRelativePath: 'flow/visible-a.png',
      targetProjectRelativePath: 'flow/far.txt'
    }]);
    const index = createCanvasVirtualizationIndex({
      nodes: projection.nodes,
      edges: projection.edges
    });

    const first = index.render({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: []
    });
    const second = index.render({
      camera: { x: -200, y: 0, z: 1 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: []
    });

    expect(first.nodes.map((node) => node.projectRelativePath)).toEqual(['flow/visible-a.png', 'flow/visible-b.png', 'flow/far.txt']);
    expect(second.nodes.map((node) => node.projectRelativePath)).toEqual(['flow/visible-a.png', 'flow/visible-b.png', 'flow/far.txt']);
  });

  it('matches fresh culling after incremental camera movement', () => {
    const projection = projectionFixture([
      nodeFixture('flow/a.png', 0, 0),
      nodeFixture('flow/b.png', 600, 0),
      nodeFixture('flow/c.png', 1400, 0),
      nodeFixture('flow/d.png', 2400, 0)
    ]);
    const index = createCanvasVirtualizationIndex({ nodes: projection.nodes, edges: [] });

    const incremental = index.render({
      camera: { x: -900, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodeProjectRelativePaths: []
    });
    const fresh = buildVirtualizedCanvasRenderState({
      nodes: projection.nodes,
      edges: [],
      camera: { x: -900, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodeProjectRelativePaths: []
    });

    expect(incremental.nodes.map((node) => node.projectRelativePath)).toEqual(
      fresh.nodes.map((node) => node.projectRelativePath)
    );
    expect(incremental.edges).toEqual(fresh.edges);
  });

});

function projectionFixture(
  nodes: CanvasProjection['nodes'],
  edges: CanvasProjection['edges'] = []
): CanvasProjection {
  return {
    canvasId: 'canvas',
    nodes,
    edges,
    diagnostics: []
  };
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
      fileUrl: `http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${projectRelativePath}?v=rev`,
      revision: 'rev'
    }
  };
}

function textNodeFixture(projectRelativePath: string, x: number, y: number): CanvasProjection['nodes'][number] {
  return {
    projectRelativePath,
    nodeKind: 'file',
    mediaKind: 'text',
    x,
    y,
    width: 200,
    height: 120,
    z: 0,
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'text/plain',
      fileUrl: `http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${projectRelativePath}?v=rev`,
      revision: 'rev'
    }
  };
}

function directoryFixture(projectRelativePath: string, x: number, y: number): CanvasProjection['nodes'][number] {
  return {
    projectRelativePath,
    nodeKind: 'directory',
    x,
    y,
    width: 200,
    height: 120,
    z: 0,
    availability: {
      state: 'available',
      size: 0,
      mimeType: 'inode/directory',
      fileUrl: '',
      revision: 'rev'
    }
  };
}
