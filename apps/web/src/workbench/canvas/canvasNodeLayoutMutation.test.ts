import { describe, expect, it } from 'vitest';
import { canvasNodeLayoutMutationPatch } from './canvasNodeLayoutMutation.js';

describe('Canvas node layout mutation', () => {
  it('keeps the selection raise when a drag ends at its current geometry', () => {
    const nodes = [rect('a.png', 0), rect('b.png', 50)];

    expect(canvasNodeLayoutMutationPatch({
      currentNodes: nodes,
      nextNodes: nodes,
      currentOcclusionOrder: ['a.png', 'b.png'],
      nextOcclusionOrder: ['a.png', 'b.png'],
      selectedProjectRelativePaths: ['a.png'],
      nodeLayouts: [rect('a.png', 0)]
    })).toEqual({
      occlusionOrder: ['b.png', 'a.png']
    });
  });

  it('returns no patch when neither final geometry nor final occlusion changes', () => {
    const nodes = [rect('a.png', 0), rect('b.png', 50)];

    expect(canvasNodeLayoutMutationPatch({
      currentNodes: nodes,
      nextNodes: nodes,
      currentOcclusionOrder: ['b.png', 'a.png'],
      nextOcclusionOrder: ['b.png', 'a.png'],
      selectedProjectRelativePaths: ['a.png'],
      nodeLayouts: [rect('a.png', 0)]
    })).toBeUndefined();
  });

  it('omits an unchanged occlusion order while preserving changed geometry', () => {
    const currentNodes = [rect('a.png', 0), rect('b.png', 50)];
    const nextNodes = [rect('a.png', 10), rect('b.png', 50)];

    expect(canvasNodeLayoutMutationPatch({
      currentNodes,
      nextNodes,
      currentOcclusionOrder: ['b.png', 'a.png'],
      nextOcclusionOrder: ['b.png', 'a.png'],
      selectedProjectRelativePaths: ['a.png'],
      nodeLayouts: [rect('a.png', 10)]
    })).toEqual({
      nodeStateUpdates: [{
        projectRelativePath: 'a.png',
        manualLayout: { x: 10, y: 0, width: 100, height: 80 }
      }]
    });
  });

  it('drops layout writes for nodes absent from the latest accepted scene', () => {
    const nodes = [rect('b.png', 50)];

    expect(canvasNodeLayoutMutationPatch({
      currentNodes: nodes,
      nextNodes: nodes,
      currentOcclusionOrder: [],
      nextOcclusionOrder: [],
      selectedProjectRelativePaths: ['a.png'],
      nodeLayouts: [rect('a.png', 10)]
    })).toBeUndefined();
  });
});

function rect(projectRelativePath: string, x: number) {
  return { projectRelativePath, x, y: 0, width: 100, height: 80 };
}
