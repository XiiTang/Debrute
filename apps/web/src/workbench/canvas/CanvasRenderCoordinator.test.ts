import { describe, expect, it } from 'vitest';
import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import { createCanvasPerfMonitor, type CanvasPerfTraceEvent } from './CanvasPerfMonitor';
import { createCanvasRenderCoordinator } from './CanvasRenderCoordinator';

describe('CanvasRenderCoordinator', () => {
  it('reuses moving snapshots while the visible rect stays inside the render margin', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/a.png', 0, 0, 1),
      imageNode('flow/b.png', 400, 0, 2)
    ]) });

    const first = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 300, height: 200 },
      selection: undefined,
      activeNodePaths: []
    });
    const moving = coordinator.update({
      camera: { x: -40, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 300, height: 200 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(moving).toBe(first);
  });

  it('refreshes while moving when the live viewport exits the virtual refresh margin', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/a.png', 0, 0, 1),
      imageNode('flow/far.png', 2000, 0, 2)
    ]) });

    const first = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const moving = coordinator.update({
      camera: { x: -1800, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(moving).not.toBe(first);
    expect(moving.nodesByPath.has('flow/far.png')).toBe(true);
  });

  it('refreshes while moving when zoom-in makes the previous virtual rect too broad', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/a.png', 0, 0, 1),
      imageNode('flow/far.png', 5000, 0, 2)
    ]) });

    const first = coordinator.update({
      camera: { x: 0, y: 0, z: 0.1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const moving = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(moving).not.toBe(first);
    expect(moving.virtualRect.width).toBeLessThan(first.virtualRect.width);
  });


  it('reconciles from the final camera when movement becomes idle', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/a.png', 0, 0, 1),
      imageNode('flow/far.png', 1200, 0, 2)
    ]) });

    const first = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const idle = coordinator.update({
      camera: { x: -900, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(idle).not.toBe(first);
    expect(idle.nodesByPath.has('flow/far.png')).toBe(true);
  });

  it('pins selected and active nodes', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/visible.png', 0, 0, 1),
      imageNode('flow/selected.png', 5000, 0, 2),
      imageNode('flow/active.png', 6000, 0, 3)
    ]) });

    const snapshot = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 300, height: 200 },
      selection: { kind: 'node', projectRelativePath: 'flow/selected.png' },
      activeNodePaths: ['flow/active.png']
    });

    expect([...snapshot.nodesByPath.keys()]).toEqual([
      'flow/active.png',
      'flow/selected.png',
      'flow/visible.png'
    ]);
    expect(snapshot.nodeLayers.get('flow/visible.png')).toEqual({ domOrder: 'flow/visible.png', zIndex: 1 });
    expect(snapshot.nodeLayers.get('flow/selected.png')).toEqual({ domOrder: 'flow/selected.png', zIndex: 2 });
    expect(snapshot.nodeLayers.get('flow/active.png')).toEqual({ domOrder: 'flow/active.png', zIndex: 3 });
    expect(snapshot.culledNodePaths.has('flow/selected.png')).toBe(true);
    expect(snapshot.culledNodePaths.has('flow/active.png')).toBe(true);
  });

  it('keeps offscreen image nodes mounted and marks them culled', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/visible.png', 0, 0, 1),
      imageNode('flow/offscreen.png', 5000, 0, 2),
      textNode('flow/offscreen.txt', 6000, 0, 3)
    ]) });

    const snapshot = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 300, height: 200 },
      selection: undefined,
      activeNodePaths: []
    });

    expect([...snapshot.nodesByPath.keys()]).toEqual([
      'flow/offscreen.png',
      'flow/visible.png'
    ]);
    expect(snapshot.nodesByPath.has('flow/offscreen.txt')).toBe(false);
    expect(snapshot.culledNodePaths.has('flow/offscreen.png')).toBe(true);
  });

  it('keeps mounted nodes display-visible inside the virtual rect before they cross the viewport', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/visible.png', 0, 0, 1),
      imageNode('flow/near-image.png', 900, 0, 2),
      textNode('flow/near-notes.txt', 900, 0, 3)
    ]) });

    const snapshot = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 300, height: 200 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(snapshot.nodesByPath.has('flow/near-image.png')).toBe(true);
    expect(snapshot.nodesByPath.has('flow/near-notes.txt')).toBe(true);
    expect(snapshot.culledNodePaths.has('flow/near-image.png')).toBe(false);
    expect(snapshot.culledNodePaths.has('flow/near-notes.txt')).toBe(false);
  });

  it('keeps image nodes mounted while culling toggles during a pan out and back', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/a.png', 0, 0, 1),
      imageNode('flow/b.png', 0, 2000, 2),
      textNode('flow/b-notes.txt', 0, 2000, 3)
    ]) });

    const atA = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const atB = coordinator.update({
      camera: { x: 0, y: -2000, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const backAtA = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect([...atA.nodesByPath.keys()]).toEqual(['flow/a.png', 'flow/b.png']);
    expect([...atB.nodesByPath.keys()]).toEqual(['flow/a.png', 'flow/b-notes.txt', 'flow/b.png']);
    expect([...backAtA.nodesByPath.keys()]).toEqual(['flow/a.png', 'flow/b.png']);
    expect(atA.nodesByPath.has('flow/b-notes.txt')).toBe(false);
    expect(atB.nodesByPath.has('flow/b-notes.txt')).toBe(true);
    expect(backAtA.nodesByPath.has('flow/b-notes.txt')).toBe(false);
    expect(atA.culledNodePaths.has('flow/a.png')).toBe(false);
    expect(atA.culledNodePaths.has('flow/b.png')).toBe(true);
    expect(atB.culledNodePaths.has('flow/a.png')).toBe(true);
    expect(atB.culledNodePaths.has('flow/b.png')).toBe(false);
    expect(backAtA.culledNodePaths.has('flow/a.png')).toBe(false);
    expect(backAtA.culledNodePaths.has('flow/b.png')).toBe(true);
  });

  it('applies local layout overrides to rendered nodes and connected edges', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/source.png', 0, 0, 1),
      imageNode('flow/target.png', 300, 0, 2)
    ], [{
      id: 'source-to-target',
      sourceProjectRelativePath: 'flow/source.png',
      targetProjectRelativePath: 'flow/target.png'
    }]) });

    const snapshot = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: [],
      layoutOverrides: [
        { projectRelativePath: 'flow/source.png', x: 120, y: 50, width: 100, height: 100 }
      ]
    });

    expect(snapshot.nodesByPath.get('flow/source.png')).toMatchObject({ x: 120, y: 50 });
    expect(snapshot.edges[0]?.points).toEqual([
      { x: 220, y: 100 },
      { x: 260, y: 100 },
      { x: 260, y: 50 },
      { x: 300, y: 50 }
    ]);
  });

  it('routes edges from draft geometry when both endpoints are moved', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/source.png', 0, 0, 1),
      imageNode('flow/target.png', 300, 0, 2)
    ], [{
      id: 'source-to-target',
      sourceProjectRelativePath: 'flow/source.png',
      targetProjectRelativePath: 'flow/target.png'
    }]) });

    const snapshot = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: [],
      layoutOverrides: [
        { projectRelativePath: 'flow/source.png', x: 120, y: 50, width: 100, height: 100 },
        { projectRelativePath: 'flow/target.png', x: 500, y: 80, width: 100, height: 100 }
      ]
    });

    expect(snapshot.edges[0]?.points).toEqual([
      { x: 220, y: 100 },
      { x: 316, y: 100 },
      { x: 316, y: 130 },
      { x: 500, y: 130 }
    ]);
  });

  it('routes edges from resized draft geometry', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/source.png', 0, 0, 1),
      imageNode('flow/target.png', 400, 40, 2)
    ], [{
      id: 'source-to-target',
      sourceProjectRelativePath: 'flow/source.png',
      targetProjectRelativePath: 'flow/target.png'
    }]) });

    const snapshot = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: ['flow/source.png'],
      layoutOverrides: [
        { projectRelativePath: 'flow/source.png', x: 0, y: 0, width: 180, height: 140 }
      ]
    });

    expect(snapshot.nodesByPath.get('flow/source.png')).toMatchObject({
      x: 0,
      y: 0,
      width: 180,
      height: 140
    });
    expect(snapshot.edges[0]?.points).toEqual([
      { x: 180, y: 70 },
      { x: 276, y: 70 },
      { x: 276, y: 90 },
      { x: 400, y: 90 }
    ]);
  });

  it('keeps a resized draft node mounted when its durable rect is outside the virtual rect', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/a.png', 5000, 0, 1)
    ]) });

    const snapshot = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: ['flow/a.png'],
      layoutOverrides: [
        { projectRelativePath: 'flow/a.png', x: 40, y: 20, width: 180, height: 140 }
      ]
    });

    expect(snapshot.nodesByPath.get('flow/a.png')).toMatchObject({
      x: 40,
      y: 20,
      width: 180,
      height: 140
    });
    expect(snapshot.culledNodePaths.has('flow/a.png')).toBe(false);
  });

  it('does not reuse moving snapshots when layout overrides change', () => {
    const coordinator = createCanvasRenderCoordinator({ projection: projection([
      imageNode('flow/a.png', 0, 0, 1)
    ]) });

    const first = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const moved = coordinator.update({
      camera: { x: -40, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: [],
      layoutOverrides: [
        { projectRelativePath: 'flow/a.png', x: 40, y: 0, width: 100, height: 100 }
      ]
    });

    expect(moved).not.toBe(first);
    expect(moved.nodesByPath.get('flow/a.png')?.x).toBe(40);
  });

  it('records snapshot build, reuse, and virtual refresh counters', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const coordinator = createCanvasRenderCoordinator({
      projection: projection([
        imageNode('flow/a.png', 0, 0, 1),
        imageNode('flow/far.png', 2000, 0, 2)
      ]),
      perfMonitor: monitor
    });

    coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    coordinator.update({
      camera: { x: -40, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    coordinator.update({
      camera: { x: -1800, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(counterNames(monitor.getTrace().events)).toEqual([
      'render-snapshot-build',
      'render-snapshot-reuse',
      'render-virtual-refresh',
      'render-snapshot-build'
    ]);
  });

  it('updates snapshot node data for prop-only projection changes without virtual refresh', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const coordinator = createCanvasRenderCoordinator({
      projection: projection([imageNode('flow/a.png', 0, 0, 1)]),
      perfMonitor: monitor
    });
    const first = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const updated = imageNode('flow/a.png', 0, 0, 1);
    updated.availability = {
      state: 'available',
      revision: 'rev-b',
      fileUrl: '/api/projects/p/files/raw/flow/a.png?v=rev-b',
      size: 1000,
      mimeType: 'image/png',
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: 100
    };

    coordinator.setProjection(projection([updated]));

    const second = coordinator.update({
      camera: { x: -20, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(second).not.toBe(first);
    expect(second.nodesByPath.get('flow/a.png')?.availability).toMatchObject({ revision: 'rev-b' });
    expect(counterNames(monitor.getTrace().events)).not.toContain('render-virtual-refresh');
  });

  it('records one membership refresh for mixed geometry and prop-only projection changes', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const coordinator = createCanvasRenderCoordinator({
      projection: projection([
        imageNode('flow/a.png', 0, 0, 1),
        imageNode('flow/b.png', 300, 0, 2)
      ]),
      perfMonitor: monitor
    });
    coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const moved = imageNode('flow/a.png', 1200, 0, 1);
    const propOnly = imageNode('flow/b.png', 300, 0, 2);
    propOnly.availability = {
      state: 'available',
      revision: 'rev-b',
      fileUrl: '/api/projects/p/files/raw/flow/b.png?v=rev-b',
      size: 1000,
      mimeType: 'image/png',
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: 100
    };

    coordinator.setProjection(projection([moved, propOnly]));
    const next = coordinator.update({
      camera: { x: -1100, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(next.nodesByPath.get('flow/a.png')?.x).toBe(1200);
    expect(next.nodesByPath.get('flow/b.png')?.availability).toMatchObject({ revision: 'rev-b' });
    expect(counterNames(monitor.getTrace().events).filter((name) => name === 'render-virtual-refresh')).toHaveLength(1);
  });

  it('records one membership refresh when projection layout changes', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const coordinator = createCanvasRenderCoordinator({
      projection: projection([imageNode('flow/a.png', 0, 0, 1)]),
      perfMonitor: monitor
    });
    coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    coordinator.setProjection(projection([imageNode('flow/a.png', 1200, 0, 1)]));
    const next = coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(next.nodesByPath.has('flow/a.png')).toBe(true);
    expect(counterNames(monitor.getTrace().events).filter((name) => name === 'render-virtual-refresh')).toHaveLength(1);
  });

  it('updates z-only projection changes without rebuilding render membership', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const coordinator = createCanvasRenderCoordinator({
      projection: projection([imageNode('flow/a.png', 0, 0, 1)]),
      perfMonitor: monitor
    });
    coordinator.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    coordinator.setProjection(projection([imageNode('flow/a.png', 0, 0, 2)]));
    const next = coordinator.update({
      camera: { x: -20, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(next.nodeLayers.get('flow/a.png')).toEqual({ domOrder: 'flow/a.png', zIndex: 2 });
    expect(counterNames(monitor.getTrace().events)).not.toContain('render-virtual-refresh');
  });
});

function counterNames(events: readonly CanvasPerfTraceEvent[]): string[] {
  return events
    .filter((event) => event.kind === 'counter')
    .map((event) => event.name);
}

function projection(
  nodes: ProjectedCanvasNode[],
  edges: CanvasProjection['edges'] = []
): CanvasProjection {
  return {
    canvasId: 'canvas',
    nodes,
    edges,
    diagnostics: []
  };
}

function imageNode(path: string, x: number, y: number, z: number): ProjectedCanvasNode {
  return {
    nodeKind: 'file',
    mediaKind: 'image',
    projectRelativePath: path,
    x,
    y,
    width: 100,
    height: 100,
    z,
    availability: {
      state: 'available',
      fileUrl: `/api/projects/p/files/${path}`,
      revision: '1',
      size: 1000,
      mimeType: 'image/png',
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: 100
    }
  };
}

function textNode(path: string, x: number, y: number, z: number): ProjectedCanvasNode {
  return {
    nodeKind: 'file',
    mediaKind: 'text',
    projectRelativePath: path,
    x,
    y,
    width: 100,
    height: 100,
    z,
    availability: {
      state: 'available',
      fileUrl: `/api/projects/p/files/${path}`,
      revision: '1',
      size: 1000,
      mimeType: 'text/plain'
    }
  };
}
