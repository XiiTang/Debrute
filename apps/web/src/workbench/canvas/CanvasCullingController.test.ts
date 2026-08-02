import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { describe, expect, it, vi } from 'vitest';
import { createCanvasCullingController } from './CanvasCullingController.js';
import { createCanvasRenderCoordinator } from './CanvasRenderCoordinator.js';

describe('CanvasCullingController', () => {
  it('keeps scene membership stable and writes only display deltas while panning', () => {
    const setNodeVisible = vi.fn();
    const scene = canvasScene([
      directoryNode('a', 0, 0),
      directoryNode('b', 1000, 0),
      directoryNode('c', 5000, 0)
    ]);
    const controller = createCanvasCullingController({
      stageRuntime: { setNodeVisible, setEdgeVisible: vi.fn() }
    });
    controller.acceptScene(scene);
    controller.sync({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 },
      displayRetainedNodePaths: new Set()
    });

    setNodeVisible.mockClear();
    controller.sync({
      camera: { x: -900, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 },
      displayRetainedNodePaths: new Set()
    });

    expect(scene.nodesByPath.size).toBe(3);
    expect(setNodeVisible.mock.calls).toEqual([
      ['a', false],
      ['b', true]
    ]);
    expect(controller.isNodeInViewport('b')).toBe(true);
    expect(controller.isNodeInViewport('c')).toBe(false);
  });

  it('retains an offscreen interaction node for display without promoting its preview tier', () => {
    const setNodeVisible = vi.fn();
    const controller = createCanvasCullingController({
      stageRuntime: { setNodeVisible, setEdgeVisible: vi.fn() }
    });
    controller.acceptScene(canvasScene([
      directoryNode('selected', 5000, 0),
      directoryNode('ordinary', 7000, 0)
    ]));

    controller.sync({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 },
      displayRetainedNodePaths: new Set(['selected'])
    });

    expect(setNodeVisible.mock.calls).toEqual([
      ['ordinary', false],
      ['selected', true]
    ]);
    expect(controller.isNodeInViewport('selected')).toBe(false);
    expect(controller.getCounts()).toEqual({
      displayVisibleNodeCount: 1,
      culledNodeCount: 1,
      visibleEdgeCount: 0
    });
  });

  it('ignores retained paths that are not members of the current scene', () => {
    const setNodeVisible = vi.fn();
    const controller = createCanvasCullingController({
      stageRuntime: { setNodeVisible, setEdgeVisible: vi.fn() }
    });
    controller.acceptScene(canvasScene([directoryNode('node', 5000, 0)]));

    controller.sync({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 },
      displayRetainedNodePaths: new Set(['missing'])
    });

    expect(setNodeVisible).toHaveBeenCalledWith('node', false);
    expect(controller.getCounts().displayVisibleNodeCount).toBe(0);
  });

  it('reuses the geometric viewport result for an identical scene and camera', () => {
    const setNodeVisible = vi.fn();
    const controller = createCanvasCullingController({
      stageRuntime: { setNodeVisible, setEdgeVisible: vi.fn() }
    });
    controller.acceptScene(canvasScene([
      directoryNode('near', 0, 0),
      directoryNode('far', 5000, 0)
    ]));
    const input = {
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 },
      displayRetainedNodePaths: new Set<string>()
    };
    const first = controller.sync(input);

    setNodeVisible.mockClear();
    const second = controller.sync({
      ...input,
      displayRetainedNodePaths: new Set()
    });

    expect(second).toBe(first);
    expect(setNodeVisible).not.toHaveBeenCalled();
  });

  it('reuses viewport geometry when only display retention changes', () => {
    const setNodeVisible = vi.fn();
    const controller = createCanvasCullingController({
      stageRuntime: { setNodeVisible, setEdgeVisible: vi.fn() }
    });
    controller.acceptScene(canvasScene([directoryNode('selected', 5000, 0)]));
    const first = controller.sync({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 },
      displayRetainedNodePaths: new Set()
    });

    setNodeVisible.mockClear();
    const retained = controller.sync({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 },
      displayRetainedNodePaths: new Set(['selected'])
    });

    expect(retained).toBe(first);
    expect(setNodeVisible).toHaveBeenCalledOnce();
    expect(setNodeVisible).toHaveBeenCalledWith('selected', true);
    expect(controller.isNodeInViewport('selected')).toBe(false);
  });

  it('invalidates viewport geometry when the surface size changes', () => {
    const setNodeVisible = vi.fn();
    const controller = createCanvasCullingController({
      stageRuntime: { setNodeVisible, setEdgeVisible: vi.fn() }
    });
    controller.acceptScene(canvasScene([directoryNode('edge', 900, 0)]));
    const narrow = controller.sync({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 },
      displayRetainedNodePaths: new Set()
    });

    setNodeVisible.mockClear();
    const wide = controller.sync({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 1000, height: 600 },
      displayRetainedNodePaths: new Set()
    });

    expect(wide).not.toBe(narrow);
    expect(setNodeVisible).toHaveBeenCalledWith('edge', true);
  });

  it('invalidates viewport geometry when the accepted scene changes', () => {
    const setNodeVisible = vi.fn();
    const controller = createCanvasCullingController({
      stageRuntime: { setNodeVisible, setEdgeVisible: vi.fn() }
    });
    controller.acceptScene(canvasScene([directoryNode('old', 0, 0)]));
    const oldScene = controller.sync({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 },
      displayRetainedNodePaths: new Set()
    });

    setNodeVisible.mockClear();
    controller.acceptScene(canvasScene([directoryNode('new', 5000, 0)]));
    const newScene = controller.sync({
      camera: { x: 0, y: 0, z: 1 },
      surfaceSize: { width: 800, height: 600 },
      displayRetainedNodePaths: new Set()
    });

    expect(newScene).not.toBe(oldScene);
    expect(setNodeVisible).toHaveBeenCalledWith('new', false);
    expect(controller.isNodeInViewport('old')).toBe(false);
  });
});

function canvasScene(nodes: ProjectedCanvasNode[]) {
  return createCanvasRenderCoordinator({
    projection: { canvasId: 'canvas', nodes, edges: [], diagnostics: [] }
  }).update({ layoutOverrides: [] });
}

function directoryNode(path: string, x: number, y: number): ProjectedCanvasNode {
  return {
    nodeKind: 'directory',
    projectRelativePath: path,
    x,
    y,
    width: 100,
    height: 100,
    z: 0,
    availability: {
      state: 'available',
      fileUrl: '',
      revision: '1',
      size: 0,
      mimeType: 'inode/directory'
    }
  };
}
