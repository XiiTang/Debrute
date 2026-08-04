import { describe, expect, it } from 'vitest';
import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import {
  canvasEdgeRoutingGroupsForProjection,
  canvasEdgeRoutingGroupIntersectsRect
} from './CanvasEdgeRoutingGroup.js';

describe('CanvasEdgeRoutingGroup', () => {
  it('keeps individual edge identity in one source-owned routed path', () => {
    const groups = canvasEdgeRoutingGroupsForProjection(projection([
      node('source', 0, 0),
      node('top', 300, 0),
      node('bottom', 300, 200)
    ], [
      edge('source-top', 'source', 'top'),
      edge('source-bottom', 'source', 'bottom')
    ]));

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: 'source',
      sourceProjectRelativePath: 'source',
      edgeIds: ['source-top', 'source-bottom'],
      targetProjectRelativePaths: ['top', 'bottom'],
      path: 'M 100 50 L 196 50 M 196 50 L 196 250 M 196 50 L 300 50 M 196 250 L 300 250'
    });
  });

  it('creates stable groups in first-edge order', () => {
    const groups = canvasEdgeRoutingGroupsForProjection(projection([
      node('a', 0, 0),
      node('b', 300, 0),
      node('c', 0, 200),
      node('d', 300, 200)
    ], [
      edge('c-d', 'c', 'd'),
      edge('a-b', 'a', 'b')
    ]));

    expect(groups.map((group) => group.id)).toEqual(['c', 'a']);
  });

  it('uses exact routed segments after the bounds query admits a group', () => {
    const [group] = canvasEdgeRoutingGroupsForProjection(projection([
      node('source', 0, 0),
      node('target', 300, 200)
    ], [edge('source-target', 'source', 'target')]));

    expect(group).toBeDefined();
    expect(canvasEdgeRoutingGroupIntersectsRect(group!, { x: 150, y: 100, width: 100, height: 100 })).toBe(true);
    expect(canvasEdgeRoutingGroupIntersectsRect(group!, { x: 210, y: 60, width: 50, height: 50 })).toBe(false);
  });
});

function projection(nodes: ProjectedCanvasNode[], edges: CanvasProjection['edges']): CanvasProjection {
  return { canvasId: 'canvas', nodes, edges, diagnostics: [] };
}

function edge(id: string, sourceProjectRelativePath: string, targetProjectRelativePath: string) {
  return { id, sourceProjectRelativePath, targetProjectRelativePath };
}

function node(projectRelativePath: string, x: number, y: number): ProjectedCanvasNode {
  return {
    nodeKind: 'directory',
    projectRelativePath,
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
