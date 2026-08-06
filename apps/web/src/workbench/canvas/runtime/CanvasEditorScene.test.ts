import type { CanvasProjection, ProjectedCanvasNode } from '../CanvasScene.js';
import { describe, expect, it } from 'vitest';
import type { CanvasScenePresentationUpdate } from '../CanvasScenePresentation.js';
import { createCanvasEditorRuntime } from './CanvasEditorRuntime.js';

describe('CanvasEditorRuntime scene', () => {
  it('exposes stable node membership and exact source routing-group queries', () => {
    const runtime = createRuntime(projection([
      directoryNode('source', 0, 0, 1),
      directoryNode('target', 300, 200, 2)
    ], [edge('source-target', 'source', 'target')]));

    expect([...runtime.scene.getRenderSnapshot().nodesByPath.keys()]).toEqual(['source', 'target']);
    expect(runtime.scene.getRenderSnapshot().edgeGroups.map((group) => group.edgeIds))
      .toEqual([['source-target']]);
    expect(runtime.scene.queryEdgeGroupIds({ x: 150, y: 100, width: 100, height: 100 }))
      .toEqual(['source']);
    expect(runtime.scene.queryEdgeGroupIds({ x: 210, y: 60, width: 30, height: 30 }))
      .toEqual([]);
  });

  it('publishes immediate Selection Raise before one-node geometry and routing deltas', () => {
    const runtime = createRuntime(projection([
      directoryNode('source', 0, 0, 1),
      directoryNode('target', 300, 0, 2),
      directoryNode('unrelated', 0, 300, 3),
      directoryNode('unrelated-target', 300, 300, 4)
    ], [
      edge('source-target', 'source', 'target'),
      edge('unrelated-edge', 'unrelated', 'unrelated-target')
    ]));
    const renderSnapshot = runtime.scene.getRenderSnapshot();
    const updates: CanvasScenePresentationUpdate[] = [];
    const pointerStatesAtPresentation: unknown[] = [];
    runtime.scene.subscribePresentation((update) => updates.push(update));
    runtime.scene.subscribePresentation(() => {
      pointerStatesAtPresentation.push(runtime.getSnapshot().pointerInteraction);
    });

    runtime.input.beginNodeMove({
      pointerId: 1,
      projectRelativePath: 'source',
      screenPoint: { x: 0, y: 0 }
    });
    runtime.getSnapshot();
    runtime.input.updatePointerInteraction({ pointerId: 1, screenPoint: { x: 120, y: 50 } });

    expect(runtime.scene.getRenderSnapshot()).toBe(renderSnapshot);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      nodeLayouts: [{
        projectRelativePath: 'source',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        z: 5
      }],
      edgeGroups: [],
      geometryChanged: false
    });
    expect(updates[1]?.nodeLayouts).toEqual([{
      projectRelativePath: 'source',
      x: 120,
      y: 50,
      width: 100,
      height: 100,
      z: 5
    }]);
    expect(updates[1]?.edgeGroups.map((group) => group.id)).toEqual(['source']);
    expect(updates[1]?.edgeGroups[0]?.path)
      .toBe('M 220 100 L 260 100 M 260 50 L 260 100 M 260 50 L 300 50');
    expect(runtime.scene.queryNodePaths({ x: 100, y: 40, width: 140, height: 120 }))
      .toContain('source');
    expect(runtime.scene.queryEdgeGroupIds({ x: 250, y: 40, width: 20, height: 70 }))
      .toEqual(['source']);
    expect(pointerStatesAtPresentation).toEqual([
      expect.objectContaining({ kind: 'move-node', phase: 'pending' }),
      expect.objectContaining({ kind: 'move-node', phase: 'active' })
    ]);
  });
});

function createRuntime(initialProjection: CanvasProjection) {
  return createCanvasEditorRuntime({
    initialProjection,
    submitManualLayout: async () => undefined
  });
}

function projection(
  nodes: ProjectedCanvasNode[],
  edges: CanvasProjection['edges'] = []
): CanvasProjection {
  return { nodes, edges, diagnostics: [] };
}

function edge(id: string, sourceProjectRelativePath: string, targetProjectRelativePath: string) {
  return { id, sourceProjectRelativePath, targetProjectRelativePath };
}

function directoryNode(path: string, x: number, y: number, z: number): ProjectedCanvasNode {
  return {
    nodeKind: 'directory',
    projectRelativePath: path,
    displayName: path,
    x,
    y,
    width: 100,
    height: 100,
    z,
    availability: {
      state: 'available',
      fileUrl: '',
      revision: '1',
      size: 0,
      mimeType: 'inode/directory'
    }
  };
}
