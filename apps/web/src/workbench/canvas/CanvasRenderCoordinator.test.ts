import { describe, expect, it } from 'vitest';
import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import { createCanvasPerfMonitor, type CanvasPerfTraceEvent } from './CanvasPerfMonitor.js';
import { createCanvasRenderCoordinator } from './CanvasRenderCoordinator.js';

describe('CanvasRenderCoordinator', () => {
  it('keeps every current Canvas node and edge in the stable render scene', () => {
    const coordinator = createCanvasRenderCoordinator({
      projection: projection([
        directoryNode('near', 0, 0, 1),
        directoryNode('far', 50_000, 0, 2)
      ], [{
        id: 'near-to-far',
        sourceProjectRelativePath: 'near',
        targetProjectRelativePath: 'far'
      }])
    });

    const snapshot = coordinator.update({ layoutOverrides: [] });

    expect([...snapshot.nodesByPath.keys()]).toEqual(['far', 'near']);
    expect(snapshot.edges.map((edge) => edge.id)).toEqual(['near-to-far']);
  });

  it('reuses the scene for identical Manual Layout presentation', () => {
    const monitor = createCanvasPerfMonitor();
    const coordinator = createCanvasRenderCoordinator({
      projection: projection([directoryNode('node', 0, 0, 1)]),
      perfMonitor: monitor
    });

    const first = coordinator.update({ layoutOverrides: [] });
    const second = coordinator.update({ layoutOverrides: [] });

    expect(second).toBe(first);
    expect(counterNames(monitor.getTrace().events)).toEqual([
      'render-snapshot-build',
      'render-snapshot-reuse'
    ]);
  });

  it('applies Manual Layout overrides to nodes and connected edges', () => {
    const coordinator = createCanvasRenderCoordinator({
      projection: projection([
        directoryNode('source', 0, 0, 1),
        directoryNode('target', 300, 0, 2)
      ], [{
        id: 'source-to-target',
        sourceProjectRelativePath: 'source',
        targetProjectRelativePath: 'target'
      }])
    });

    const snapshot = coordinator.update({
      layoutOverrides: [{
        projectRelativePath: 'source',
        x: 120,
        y: 50,
        width: 100,
        height: 100
      }]
    });

    expect(snapshot.nodesByPath.get('source')).toMatchObject({ x: 120, y: 50 });
    expect(snapshot.edges[0]?.points).toEqual([
      { x: 220, y: 100 },
      { x: 260, y: 100 },
      { x: 260, y: 50 },
      { x: 300, y: 50 }
    ]);
  });

  it('uses the Manual Layout stack presentation', () => {
    const coordinator = createCanvasRenderCoordinator({
      projection: projection([
        directoryNode('a', 0, 0, 0),
        directoryNode('b', 20, 0, 1),
        directoryNode('c', 40, 0, 2)
      ])
    });

    const snapshot = coordinator.update({
      layoutOverrides: [],
      stackOrder: ['b', 'c', 'a']
    });

    expect(snapshot.nodeZIndexByPath.get('a')).toBe(2);
    expect(snapshot.nodeZIndexByPath.get('b')).toBe(0);
    expect(snapshot.nodeZIndexByPath.get('c')).toBe(1);
  });

  it('rebuilds stable membership and edge ordering after a Projection change', () => {
    const nodes = [
      directoryNode('a', 0, 0, 1),
      directoryNode('b', 300, 0, 2),
      directoryNode('c', 0, 200, 3)
    ];
    const firstEdge = {
      id: 'first',
      sourceProjectRelativePath: 'a',
      targetProjectRelativePath: 'b'
    };
    const secondEdge = {
      id: 'second',
      sourceProjectRelativePath: 'a',
      targetProjectRelativePath: 'c'
    };
    const coordinator = createCanvasRenderCoordinator({
      projection: projection(nodes.slice(0, 2), [firstEdge])
    });

    coordinator.update({ layoutOverrides: [] });
    coordinator.setProjection(projection(nodes, [secondEdge, firstEdge]));
    const next = coordinator.update({ layoutOverrides: [] });

    expect([...next.nodesByPath.keys()]).toEqual(['a', 'b', 'c']);
    expect(next.edges.map((edge) => edge.id)).toEqual(['second', 'first']);
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
  return { canvasId: 'canvas', nodes, edges, diagnostics: [] };
}

function directoryNode(path: string, x: number, y: number, z: number): ProjectedCanvasNode {
  return {
    nodeKind: 'directory',
    projectRelativePath: path,
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
