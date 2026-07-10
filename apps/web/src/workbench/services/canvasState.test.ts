import { describe, expect, it } from 'vitest';
import type { CanvasDocument, CanvasNodeElement } from '@debrute/canvas-core';
import { selectedCanvasNodeNeedsStackOrderUpdate } from './canvasState';

describe('canvas state stack-order helpers', () => {
  it('requests a stack-order update only for a selected node that is not already top', () => {
    const canvas = canvasFixture([
      node('flow/a.png', 0),
      node('flow/b.png', 1)
    ]);

    expect(selectedCanvasNodeNeedsStackOrderUpdate(canvas, {
      kind: 'node',
      projectRelativePath: 'flow/a.png'
    })).toBe(true);
    expect(selectedCanvasNodeNeedsStackOrderUpdate(canvas, {
      kind: 'node',
      projectRelativePath: 'flow/b.png'
    })).toBe(false);
  });

  it('does not request stack-order updates for missing Canvas state or non-single-node selections', () => {
    const canvas = canvasFixture([
      node('flow/a.png', 0),
      node('flow/b.png', 1)
    ]);

    expect(selectedCanvasNodeNeedsStackOrderUpdate(undefined, {
      kind: 'node',
      projectRelativePath: 'flow/a.png'
    })).toBe(false);
    expect(selectedCanvasNodeNeedsStackOrderUpdate(canvas, undefined)).toBe(false);
    expect(selectedCanvasNodeNeedsStackOrderUpdate(canvas, {
      kind: 'multi',
      items: [
        { kind: 'node', projectRelativePath: 'flow/a.png' },
        { kind: 'node', projectRelativePath: 'flow/b.png' }
      ]
    })).toBe(false);
    expect(selectedCanvasNodeNeedsStackOrderUpdate(canvas, {
      kind: 'diagnostic',
      id: 'diagnostic-1'
    })).toBe(false);
    expect(selectedCanvasNodeNeedsStackOrderUpdate(canvas, {
      kind: 'node',
      projectRelativePath: 'flow/missing.png'
    })).toBe(false);
  });
});

function canvasFixture(nodeElements: CanvasNodeElement[]): CanvasDocument {
  return {
    id: 'canvas-1',
    name: 'Canvas 1',
    nodeElements,
    annotations: [],
    preferences: {
      showDiagnostics: true
    }
  };
}

function node(projectRelativePath: string, z: number): CanvasNodeElement {
  return {
    projectRelativePath,
    nodeKind: 'file',
    mediaKind: 'image',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    z
  };
}
