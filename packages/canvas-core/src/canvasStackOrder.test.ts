import { describe, expect, it } from 'vitest';

import {
  bringCanvasNodeToFront,
  canvasNodeStackOrderTopFirst,
  createCanvasDocument,
  projectCanvas,
  type CanvasDocument,
  type CanvasNodeAvailability,
  type CanvasNodeElement
} from './index.js';

describe('Canvas stack order', () => {
  it('assigns deterministic node stack order and projects all nodes by render order', () => {
    const canvas = createCanvasWithNodes([
      { projectRelativePath: 'flow/bottom.png', nodeKind: 'file', mediaKind: 'image', x: 0, y: 0, width: 100, height: 100 },
      { projectRelativePath: 'flow/top.png', nodeKind: 'file', mediaKind: 'image', x: 20, y: 20, width: 100, height: 100 }
    ]);
    const projection = projectCanvas({ canvas, nodeAvailability: availableNode });

    expect(canvas.nodeElements).toMatchObject([
      { projectRelativePath: 'flow/bottom.png', z: 0 },
      { projectRelativePath: 'flow/top.png', z: 1 }
    ]);
    expect(projection.nodes.map((node) => node.projectRelativePath)).toEqual(['flow/bottom.png', 'flow/top.png']);
    expect(canvasNodeStackOrderTopFirst(canvas)).toEqual(['flow/top.png', 'flow/bottom.png']);
  });

  it('brings one node to the top of stack order and preserves the other relative order', () => {
    const canvas = createCanvasWithNodes([
      { projectRelativePath: 'flow/a.png', nodeKind: 'file', mediaKind: 'image', x: 0, y: 0, width: 100, height: 100 },
      { projectRelativePath: 'flow/b.png', nodeKind: 'file', mediaKind: 'image', x: 0, y: 0, width: 100, height: 100 },
      { projectRelativePath: 'flow/c.png', nodeKind: 'file', mediaKind: 'image', x: 0, y: 0, width: 100, height: 100 }
    ]);

    const reordered = bringCanvasNodeToFront(canvas, { projectRelativePath: 'flow/b.png' });

    expect(canvasNodeStackOrderTopFirst(reordered)).toEqual(['flow/b.png', 'flow/c.png', 'flow/a.png']);
    expect(nodeByPath(reordered.nodeElements, 'flow/a.png')).toMatchObject({ z: 0 });
    expect(nodeByPath(reordered.nodeElements, 'flow/c.png')).toMatchObject({ z: 1 });
    expect(nodeByPath(reordered.nodeElements, 'flow/b.png')).toMatchObject({ z: 2 });
  });

  it('does not rewrite a canvas when the selected node is already top of stack order', () => {
    const canvas = createCanvasWithNodes([
      { projectRelativePath: 'flow/a.png', nodeKind: 'file', mediaKind: 'image', x: 0, y: 0, width: 100, height: 100 },
      { projectRelativePath: 'flow/b.png', nodeKind: 'file', mediaKind: 'image', x: 0, y: 0, width: 100, height: 100 }
    ]);

    expect(bringCanvasNodeToFront(canvas, { projectRelativePath: 'flow/b.png' })).toBe(canvas);
  });

  it('rejects bring-to-front for a path that is not a canvas node', () => {
    const canvas = createCanvasWithNodes([
      { projectRelativePath: 'flow/a.png', nodeKind: 'file', mediaKind: 'image', x: 0, y: 0, width: 100, height: 100 }
    ]);

    expect(() => bringCanvasNodeToFront(canvas, { projectRelativePath: 'flow/missing.png' }))
      .toThrow('Canvas node not found: flow/missing.png');
  });
});

function createCanvasWithNodes(nodes: Array<Partial<CanvasNodeElement> & Pick<CanvasNodeElement, 'projectRelativePath' | 'nodeKind' | 'x' | 'y' | 'width' | 'height'>>): CanvasDocument {
  return {
    ...createCanvasDocument({ id: 'main' }),
    nodeElements: nodes.map((item, index) => ({ z: index, ...item }))
  };
}

function nodeByPath(nodes: CanvasNodeElement[], projectRelativePath: string): CanvasNodeElement {
  const found = nodes.find((item) => item.projectRelativePath === projectRelativePath);
  if (!found) {
    throw new Error(`Missing Canvas node fixture: ${projectRelativePath}`);
  }
  return found;
}

function availableNode(): CanvasNodeAvailability {
  return {
    state: 'available',
    size: 0,
    mimeType: 'text/plain',
    fileUrl: '/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/flow?v=rev',
    revision: '1'
  };
}
