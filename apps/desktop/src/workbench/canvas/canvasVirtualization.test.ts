import { describe, expect, it } from 'vitest';
import type { CanvasProjection } from '@axis/canvas-core';
import {
  CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX,
  buildVirtualizedCanvasRenderState,
  canvasVirtualRenderRect,
  canvasVisibleRect,
  createCanvasVirtualizationIndex,
  segmentIntersectsRect,
  type CanvasVirtualizationQueryInput
} from './canvasVirtualization';

describe('canvas virtualization geometry', () => {
  it('derives visible and overscan rectangles from viewport and surface size', () => {
    const viewport = { x: -200, y: -100, zoom: 2 };
    const visible = canvasVisibleRect({ viewport, surfaceSize: { width: 1000, height: 600 } });
    const virtual = canvasVirtualRenderRect({ viewport, surfaceSize: { width: 1000, height: 600 } });

    expect(visible).toEqual({ x: 100, y: 50, width: 500, height: 300 });
    expect(virtual).toEqual({
      x: 100 - CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX / 2,
      y: 50 - CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX / 2,
      width: 500 + CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX,
      height: 300 + CANVAS_VIRTUAL_OVERSCAN_SCREEN_PX
    });
  });

  it('uses a bounded initial surface size before measurement', () => {
    const rect = canvasVirtualRenderRect({ viewport: { x: 0, y: 0, zoom: 1 }, surfaceSize: undefined });

    expect(rect).toEqual({ x: -768, y: -768, width: 2816, height: 2256 });
  });

  it('rejects invalid viewport zoom values instead of silently changing geometry', () => {
    expect(() => canvasVisibleRect({
      viewport: { x: 0, y: 0, zoom: 0 },
      surfaceSize: { width: 100, height: 100 }
    })).toThrow('Canvas viewport zoom must be a positive finite number.');
  });

  it('renders visible, selected, and active nodes without rendering unrelated offscreen nodes', () => {
    const projection = projectionFixture([
      nodeFixture('flow/visible.png', 0, 0),
      nodeFixture('flow/selected-offscreen.png', 6000, 0),
      nodeFixture('flow/active-offscreen.png', 0, 6000),
      nodeFixture('flow/far.png', 6000, 6000)
    ]);

    const state = buildVirtualizedCanvasRenderState({
      nodes: projection.nodes,
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      surfaceSize: undefined,
      selection: { kind: 'node', projectRelativePath: 'flow/selected-offscreen.png' },
      activeNodeProjectRelativePaths: ['flow/active-offscreen.png'],
      ...imagePreviewContext(1)
    });

    expect(state.nodes.map((node) => node.projectRelativePath)).toEqual([
      'flow/visible.png',
      'flow/selected-offscreen.png',
      'flow/active-offscreen.png'
    ]);
  });

  it('does not render hidden nodes even when they intersect the virtual window', () => {
    const projection = projectionFixture([
      { ...nodeFixture('flow/hidden.png', 0, 0), visible: false },
      nodeFixture('flow/visible.png', 300, 0)
    ]);

    const state = buildVirtualizedCanvasRenderState({
      nodes: projection.nodes,
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      surfaceSize: undefined,
      selection: { kind: 'node', projectRelativePath: 'flow/hidden.png' },
      activeNodeProjectRelativePaths: ['flow/hidden.png'],
      ...imagePreviewContext(1)
    });

    expect(state.nodes.map((node) => node.projectRelativePath)).toEqual(['flow/visible.png']);
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
      nodeFixture('flow/target.png', 5000, 0),
      nodeFixture('flow/outside-a.png', 0, -5000),
      nodeFixture('flow/outside-b.png', 5000, -5000)
    ], [{
      id: 'source-to-target',
      sourceProjectRelativePath: 'flow/source.png',
      targetProjectRelativePath: 'flow/target.png'
    }, {
      id: 'outside',
      sourceProjectRelativePath: 'flow/outside-a.png',
      targetProjectRelativePath: 'flow/outside-b.png'
    }]);

    const state = buildVirtualizedCanvasRenderState({
      nodes: projection.nodes,
      edges: projection.edges,
      viewport: { x: 0, y: 0, zoom: 1 },
      surfaceSize: undefined,
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(1)
    });

    expect(state.nodes.map((node) => node.projectRelativePath)).toEqual(['flow/source.png']);
    expect(state.edges.map((edge) => edge.id)).toEqual(['source-to-target']);
    expect(state.svgViewBox).not.toBe('-100000 -100000 200000 200000');
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
      viewport: { x: 0, y: 0, zoom: 1 },
      surfaceSize: { width: 900, height: 500 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(1)
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

  it('keeps routed edges visible when only an orthogonal trunk segment intersects the viewport', () => {
    const projection = projectionFixture([
      nodeFixture('flow/source.png', 0, -5000),
      nodeFixture('flow/target.png', 5000, 5000)
    ], [{
      id: 'vertical-trunk',
      sourceProjectRelativePath: 'flow/source.png',
      targetProjectRelativePath: 'flow/target.png'
    }]);

    const state = buildVirtualizedCanvasRenderState({
      nodes: projection.nodes,
      edges: projection.edges,
      viewport: { x: -29600, y: 0, zoom: 100 },
      surfaceSize: { width: 100, height: 100 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(100)
    });

    expect(state.nodes).toEqual([]);
    expect(state.edges.map((edge) => edge.id)).toEqual(['vertical-trunk']);
    expect(state.edges[0]?.points).toEqual([
      { x: 200, y: -4940 },
      { x: 296, y: -4940 },
      { x: 296, y: 5060 },
      { x: 5000, y: 5060 }
    ]);
  });

  it('supports reusing one node and edge index across viewport queries', () => {
    const projection = projectionFixture([
      nodeFixture('flow/visible-a.png', 0, 0),
      nodeFixture('flow/visible-b.png', 300, 0),
      nodeFixture('flow/far.png', 8000, 0)
    ], [{
      id: 'visible-edge',
      sourceProjectRelativePath: 'flow/visible-a.png',
      targetProjectRelativePath: 'flow/visible-b.png'
    }, {
      id: 'far-edge',
      sourceProjectRelativePath: 'flow/visible-a.png',
      targetProjectRelativePath: 'flow/far.png'
    }]);
    const index = createCanvasVirtualizationIndex({
      nodes: projection.nodes,
      edges: projection.edges
    });

    const first = index.render({
      viewport: { x: 0, y: 0, zoom: 1 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(1)
    });
    const second = index.render({
      viewport: { x: -200, y: 0, zoom: 1 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(1)
    });

    expect(first.nodes.map((node) => node.projectRelativePath)).toEqual(['flow/visible-a.png', 'flow/visible-b.png']);
    expect(second.nodes.map((node) => node.projectRelativePath)).toEqual(['flow/visible-a.png', 'flow/visible-b.png']);
    expect(first.signature).toBe(second.signature);
  });

  it('keeps the render signature stable while zoom stays in the same image preview bucket', () => {
    const projection = projectionFixture([
      previewNodeFixture('flow/cover.png', 0, 0, 1000)
    ]);
    const index = createCanvasVirtualizationIndex({
      nodes: projection.nodes,
      edges: projection.edges
    });

    const first = index.render({
      viewport: { x: 0, y: 0, zoom: 0.1 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(0.1)
    });
    const second = index.render({
      viewport: { x: 0, y: 0, zoom: 0.2 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(0.2)
    });

    expect(first.nodes.map((node) => node.projectRelativePath)).toEqual(['flow/cover.png']);
    expect(second.nodes.map((node) => node.projectRelativePath)).toEqual(['flow/cover.png']);
    expect(first.signature).toBe(second.signature);
  });

  it('changes the render signature when zoom crosses an image preview bucket', () => {
    const projection = projectionFixture([
      previewNodeFixture('flow/cover.png', 0, 0, 1000)
    ]);
    const index = createCanvasVirtualizationIndex({
      nodes: projection.nodes,
      edges: projection.edges
    });

    const smallerBucket = index.render({
      viewport: { x: 0, y: 0, zoom: 0.2 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(0.2)
    });
    const largerBucket = index.render({
      viewport: { x: 0, y: 0, zoom: 0.3 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(0.3)
    });

    expect(smallerBucket.signature).not.toBe(largerBucket.signature);
  });

  it('keeps the render signature stable while viewport zoom crosses buckets until image resource zoom settles', () => {
    const projection = projectionFixture([
      previewNodeFixture('flow/cover.png', 0, 0, 1000)
    ]);
    const index = createCanvasVirtualizationIndex({
      nodes: projection.nodes,
      edges: projection.edges
    });

    const beforeSettle = index.render({
      viewport: { x: 0, y: 0, zoom: 0.2 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(0.2)
    });
    const stillSettling = index.render({
      viewport: { x: 0, y: 0, zoom: 0.3 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(0.2)
    });
    const settled = index.render({
      viewport: { x: 0, y: 0, zoom: 0.3 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(0.3)
    });

    expect(beforeSettle.signature).toBe(stillSettling.signature);
    expect(settled.signature).not.toBe(stillSettling.signature);
  });

  it('keeps the render signature stable above the source image width', () => {
    const node = nodeFixture('flow/small.png', 0, 0);
    const projection = projectionFixture([
      {
        ...node,
        width: 1200,
        availability: node.availability.state === 'available'
          ? { ...node.availability, canvasImagePreviewSourceWidth: 300 }
          : node.availability
      }
    ]);
    const index = createCanvasVirtualizationIndex({
      nodes: projection.nodes,
      edges: projection.edges
    });

    const cappedAtSourceWidth = index.render({
      viewport: { x: 0, y: 0, zoom: 0.5 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(0.5)
    });
    const stillCappedAtSourceWidth = index.render({
      viewport: { x: 0, y: 0, zoom: 2 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      ...imagePreviewContext(2)
    });

    expect(cappedAtSourceWidth.signature).toBe(stillCappedAtSourceWidth.signature);
  });

  it('requires explicit image preview render context instead of filling defaults', () => {
    const projection = projectionFixture([previewNodeFixture('flow/cover.png', 0, 0, 1000)]);
    const index = createCanvasVirtualizationIndex({
      nodes: projection.nodes,
      edges: projection.edges
    });

    expect(() => index.render({
      viewport: { x: 0, y: 0, zoom: 1 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: []
    } as never)).toThrow('Canvas virtualization image preview context is required.');

    expect(() => index.render({
      viewport: { x: 0, y: 0, zoom: 1 },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodeProjectRelativePaths: [],
      imagePreviewsEnabled: true,
      devicePixelRatio: 0,
      imageResourceZoom: 1
    })).toThrow('Canvas devicePixelRatio must be a positive finite number.');
  });
});

function imagePreviewContext(imageResourceZoom: number): Pick<CanvasVirtualizationQueryInput, 'imagePreviewsEnabled' | 'devicePixelRatio' | 'imageResourceZoom'> {
  return {
    imagePreviewsEnabled: true,
    devicePixelRatio: 1,
    imageResourceZoom
  };
}

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

function previewNodeFixture(projectRelativePath: string, x: number, y: number, width: number): CanvasProjection['nodes'][number] {
  const node = nodeFixture(projectRelativePath, x, y);
  return {
    ...node,
    width,
    availability: node.availability.state === 'available'
      ? { ...node.availability, canvasImagePreviewSourceWidth: width }
      : node.availability
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
    visible: true,
    locked: false,
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'image/png',
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: 200,
      fileUrl: `axis-project-file://project/${projectRelativePath}`,
      revision: 'rev'
    }
  };
}
