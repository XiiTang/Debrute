import { describe, expect, it } from 'vitest';
import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import { createCanvasRenderCoordinator } from './CanvasRenderCoordinator';

describe('CanvasRenderCoordinator', () => {
  it('reuses moving snapshots while the visible rect stays inside the render margin', () => {
    const coordinator = createCanvasRenderCoordinator(projection([
      imageNode('flow/a.png', 0, 0, 1),
      imageNode('flow/b.png', 400, 0, 2)
    ]));

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
    const coordinator = createCanvasRenderCoordinator(projection([
      imageNode('flow/a.png', 0, 0, 1),
      imageNode('flow/far.png', 2000, 0, 2)
    ]));

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

  it('reconciles from the final camera when movement becomes idle', () => {
    const coordinator = createCanvasRenderCoordinator(projection([
      imageNode('flow/a.png', 0, 0, 1),
      imageNode('flow/far.png', 1200, 0, 2)
    ]));

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

  it('pins selected and active nodes while excluding hidden nodes', () => {
    const coordinator = createCanvasRenderCoordinator(projection([
      imageNode('flow/visible.png', 0, 0, 1),
      imageNode('flow/selected.png', 5000, 0, 2),
      imageNode('flow/active.png', 6000, 0, 3),
      imageNode('flow/hidden.png', 0, 0, 4, false)
    ]));

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
    expect(snapshot.nodesByPath.has('flow/hidden.png')).toBe(false);
    expect(snapshot.nodeLayers.get('flow/visible.png')).toEqual({ domOrder: 'flow/visible.png', zIndex: 1 });
    expect(snapshot.nodeLayers.get('flow/selected.png')).toEqual({ domOrder: 'flow/selected.png', zIndex: 2 });
    expect(snapshot.nodeLayers.get('flow/active.png')).toEqual({ domOrder: 'flow/active.png', zIndex: 3 });
    expect(snapshot.culledNodePaths.has('flow/selected.png')).toBe(true);
    expect(snapshot.culledNodePaths.has('flow/active.png')).toBe(true);
  });
});

function projection(nodes: ProjectedCanvasNode[]): CanvasProjection {
  return {
    canvasId: 'canvas',
    nodes,
    edges: [],
    diagnostics: []
  };
}

function imageNode(path: string, x: number, y: number, z: number, visible = true): ProjectedCanvasNode {
  return {
    nodeKind: 'file',
    mediaKind: 'image',
    projectRelativePath: path,
    x,
    y,
    width: 100,
    height: 100,
    z,
    locked: false,
    visible,
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
