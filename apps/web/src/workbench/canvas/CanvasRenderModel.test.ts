import { describe, expect, it } from 'vitest';
import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import { createCanvasRenderModel } from './CanvasRenderModel';

describe('CanvasRenderModel', () => {
  it('keeps the current snapshot while moving inside the virtual refresh margin', () => {
    const model = createCanvasRenderModel(projection([
      imageNode('flow/a.png', 0, 0),
      imageNode('flow/b.png', 300, 0)
    ]));

    const initial = model.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const moving = model.update({
      camera: { x: -20, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(moving).toBe(initial);
  });

  it('refreshes while moving when the live viewport exits the virtual refresh margin', () => {
    const model = createCanvasRenderModel(projection([
      imageNode('flow/a.png', 0, 0),
      imageNode('flow/far.png', 2000, 0)
    ]));

    const initial = model.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const moving = model.update({
      camera: { x: -1800, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(moving).not.toBe(initial);
    expect(moving.nodesByPath.has('flow/far.png')).toBe(true);
  });

  it('refreshes from the final camera when movement becomes idle', () => {
    const model = createCanvasRenderModel(projection([
      imageNode('flow/a.png', 0, 0),
      imageNode('flow/far.png', 1200, 0)
    ]));

    const initial = model.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const idle = model.update({
      camera: { x: -900, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(idle).not.toBe(initial);
    expect(idle.nodesByPath.has('flow/far.png')).toBe(true);
  });

  it('keeps selected and active offscreen nodes mounted but never hidden nodes', () => {
    const model = createCanvasRenderModel(projection([
      imageNode('flow/visible.png', 0, 0),
      imageNode('flow/selected.png', 6000, 0),
      imageNode('flow/active.png', 0, 6000),
      { ...imageNode('flow/hidden.png', 0, 0), visible: false }
    ]));

    const snapshot = model.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: {
        kind: 'multi',
        items: [
          { kind: 'node', projectRelativePath: 'flow/selected.png' },
          { kind: 'node', projectRelativePath: 'flow/hidden.png' }
        ]
      },
      activeNodePaths: ['flow/active.png', 'flow/hidden.png']
    });

    expect([...snapshot.nodesByPath.keys()]).toEqual([
      'flow/visible.png',
      'flow/selected.png',
      'flow/active.png'
    ]);
    expect(snapshot.culledNodePaths.has('flow/selected.png')).toBe(true);
    expect(snapshot.culledNodePaths.has('flow/active.png')).toBe(true);
    expect(snapshot.nodesByPath.has('flow/hidden.png')).toBe(false);
  });

  it('refreshes a reused moving snapshot when selection mounts an offscreen node', () => {
    const model = createCanvasRenderModel(projection([
      imageNode('flow/visible.png', 0, 0),
      imageNode('flow/selected.png', 6000, 0)
    ]));

    model.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const moving = model.update({
      camera: { x: -20, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 800, height: 600 },
      selection: { kind: 'node', projectRelativePath: 'flow/selected.png' },
      activeNodePaths: []
    });

    expect(moving.nodesByPath.has('flow/selected.png')).toBe(true);
    expect(moving.culledNodePaths.has('flow/selected.png')).toBe(true);
  });

  it('refreshes a reused moving snapshot when drag activity mounts an offscreen node', () => {
    const model = createCanvasRenderModel(projection([
      imageNode('flow/visible.png', 0, 0),
      imageNode('flow/active.png', 0, 6000)
    ]));

    model.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });
    const moving = model.update({
      camera: { x: -20, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: ['flow/active.png']
    });

    expect(moving.nodesByPath.has('flow/active.png')).toBe(true);
    expect(moving.culledNodePaths.has('flow/active.png')).toBe(true);
  });

  it('keeps edge virtualization independent from mounted endpoint nodes', () => {
    const model = createCanvasRenderModel({
      ...projection([
        imageNode('flow/source.png', -2000, 0),
        imageNode('flow/target.png', 2000, 0)
      ]),
      edges: [{
        id: 'edge:crossing',
        sourceProjectRelativePath: 'flow/source.png',
        targetProjectRelativePath: 'flow/target.png'
      }]
    });

    const snapshot = model.update({
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle',
      surfaceSize: { width: 800, height: 600 },
      selection: undefined,
      activeNodePaths: []
    });

    expect(snapshot.nodesByPath.size).toBe(0);
    expect(snapshot.edges.map((edge) => edge.id)).toEqual(['edge:crossing']);
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

function imageNode(path: string, x: number, y: number): ProjectedCanvasNode {
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
      fileUrl: `http://127.0.0.1:17321/api/projects/p/files/raw/${path}?v=rev`,
      revision: 'rev'
    }
  };
}
