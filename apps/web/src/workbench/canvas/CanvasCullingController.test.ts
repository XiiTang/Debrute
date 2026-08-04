import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { describe, expect, it, vi } from 'vitest';
import { createCanvasCullingController } from './CanvasCullingController.js';
import type { CanvasSceneSnapshot } from './CanvasScenePresentation.js';

describe('CanvasCullingController', () => {
  it('writes only visibility deltas while camera queries change', () => {
    const setNodeVisible = vi.fn();
    let visible = ['a'];
    const controller = createCanvasCullingController({
      stageRuntime: { setNodeVisible, setEdgeGroupVisible: vi.fn() },
      queryNodePaths: () => visible,
      queryEdgeGroupIds: () => []
    });
    controller.acceptScene(scene([node('a'), node('b')]));
    controller.sync(syncInput());
    setNodeVisible.mockClear();

    visible = ['b'];
    controller.sync(syncInput({ camera: { x: -100, y: 0, z: 1 } }));

    expect(setNodeVisible.mock.calls).toEqual([['a', false], ['b', true]]);
  });

  it('invalidates changed geometry without treating it as new React scene membership', () => {
    const setNodeVisible = vi.fn();
    let visible = ['a'];
    const controller = createCanvasCullingController({
      stageRuntime: { setNodeVisible, setEdgeGroupVisible: vi.fn() },
      queryNodePaths: () => visible,
      queryEdgeGroupIds: () => []
    });
    controller.acceptScene(scene([node('a'), node('b'), node('c')]));
    controller.sync(syncInput());
    setNodeVisible.mockClear();

    visible = ['a', 'b'];
    controller.invalidateGeometry();
    controller.sync(syncInput());

    expect(setNodeVisible.mock.calls).toEqual([['b', true]]);
  });

  it('retains selected and active offscreen nodes without promoting viewport membership', () => {
    const setNodeVisible = vi.fn();
    const controller = createCanvasCullingController({
      stageRuntime: { setNodeVisible, setEdgeGroupVisible: vi.fn() },
      queryNodePaths: () => [],
      queryEdgeGroupIds: () => []
    });
    controller.acceptScene(scene([node('selected'), node('ordinary')]));

    controller.sync(syncInput({ displayRetainedNodePaths: new Set(['selected']) }));

    expect(setNodeVisible.mock.calls).toEqual([['selected', true], ['ordinary', false]]);
  });

  it('caches identical geometry queries and reapplies only retention deltas', () => {
    const queryNodePaths = vi.fn(() => ['visible']);
    const setNodeVisible = vi.fn();
    const controller = createCanvasCullingController({
      stageRuntime: { setNodeVisible, setEdgeGroupVisible: vi.fn() },
      queryNodePaths,
      queryEdgeGroupIds: () => []
    });
    controller.acceptScene(scene([node('visible'), node('retained')]));
    controller.sync(syncInput());
    setNodeVisible.mockClear();

    controller.sync(syncInput({ displayRetainedNodePaths: new Set(['retained']) }));

    expect(queryNodePaths).toHaveBeenCalledOnce();
    expect(setNodeVisible.mock.calls).toEqual([['retained', true]]);
  });
});

function syncInput(overrides: Partial<Parameters<ReturnType<typeof createCanvasCullingController>['sync']>[0]> = {}) {
  return {
    camera: { x: 0, y: 0, z: 1 },
    surfaceSize: { width: 800, height: 600 },
    displayRetainedNodePaths: new Set<string>(),
    ...overrides
  };
}

function scene(nodes: ProjectedCanvasNode[]): CanvasSceneSnapshot {
  return {
    nodesByPath: new Map(nodes.map((value) => [value.projectRelativePath, value])),
    edgeGroups: []
  };
}

function node(projectRelativePath: string): ProjectedCanvasNode {
  return {
    nodeKind: 'directory',
    projectRelativePath,
    x: 0,
    y: 0,
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
