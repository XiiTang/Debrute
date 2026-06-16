import { describe, expect, it } from 'vitest';
import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import {
  canvasLayoutOverridesForCanvas,
  canvasLocalLayoutDraftFromMoveState,
  canvasLocalLayoutDraftMatchesProjection
} from './canvasLocalLayoutDraft';
import type { CanvasRuntimeDragState } from './runtime/CanvasEditorRuntime';

describe('canvas local layout drafts', () => {
  it('creates move-node layout overrides from drag delta', () => {
    const draft = canvasLocalLayoutDraftFromMoveState({
      canvasId: 'canvas-1',
      dragState: moveState([
        origin('flow/a.png', 10, 20, 200, 120),
        origin('flow/b.png', 30, 40, 100, 80)
      ], { x: 5, y: 6 }),
      point: { x: 25, y: 36 }
    });

    expect(draft).toEqual({
      canvasId: 'canvas-1',
      nodeLayouts: [
        { projectRelativePath: 'flow/a.png', x: 30, y: 50, width: 200, height: 120 },
        { projectRelativePath: 'flow/b.png', x: 50, y: 70, width: 100, height: 80 }
      ]
    });
  });

  it('merges pending and active drafts with active layout taking priority', () => {
    const overrides = canvasLayoutOverridesForCanvas({
      canvasId: 'canvas-1',
      pending: {
        canvasId: 'canvas-1',
        nodeLayouts: [
          { projectRelativePath: 'flow/a.png', x: 100, y: 100, width: 200, height: 120 },
          { projectRelativePath: 'flow/b.png', x: 200, y: 100, width: 200, height: 120 }
        ]
      },
      active: {
        canvasId: 'canvas-1',
        nodeLayouts: [
          { projectRelativePath: 'flow/a.png', x: 140, y: 150, width: 200, height: 120 }
        ]
      }
    });

    expect(overrides).toEqual([
      { projectRelativePath: 'flow/a.png', x: 140, y: 150, width: 200, height: 120 },
      { projectRelativePath: 'flow/b.png', x: 200, y: 100, width: 200, height: 120 }
    ]);
  });

  it('ignores drafts for other canvases', () => {
    expect(canvasLayoutOverridesForCanvas({
      canvasId: 'canvas-1',
      active: {
        canvasId: 'canvas-2',
        nodeLayouts: [
          { projectRelativePath: 'flow/a.png', x: 140, y: 150, width: 200, height: 120 }
        ]
      }
    })).toEqual([]);
  });

  it('matches durable projection only when every pending layout is current', () => {
    const draft = {
      canvasId: 'canvas-1',
      nodeLayouts: [
        { projectRelativePath: 'flow/a.png', x: 30, y: 50, width: 200, height: 120 }
      ]
    };

    expect(canvasLocalLayoutDraftMatchesProjection(draft, projection([
      node('flow/a.png', 30, 50, 200, 120)
    ]))).toBe(true);
    expect(canvasLocalLayoutDraftMatchesProjection(draft, projection([
      node('flow/a.png', 29, 50, 200, 120)
    ]))).toBe(false);
    expect(canvasLocalLayoutDraftMatchesProjection(draft, projection([
      node('flow/other.png', 30, 50, 200, 120)
    ]))).toBe(false);
  });
});

function moveState(
  origins: Extract<CanvasRuntimeDragState, { kind: 'move-node' }>['origins'],
  start: { x: number; y: number }
): Extract<CanvasRuntimeDragState, { kind: 'move-node' }> {
  return {
    kind: 'move-node',
    pointerId: 1,
    start,
    origins
  };
}

function origin(
  projectRelativePath: string,
  x: number,
  y: number,
  width: number,
  height: number
): Extract<CanvasRuntimeDragState, { kind: 'move-node' }>['origins'][number] {
  return {
    projectRelativePath,
    x,
    y,
    width,
    height
  };
}

function projection(nodes: ProjectedCanvasNode[]): CanvasProjection {
  return {
    canvasId: 'canvas-1',
    nodes,
    edges: [],
    diagnostics: []
  };
}

function node(
  projectRelativePath: string,
  x: number,
  y: number,
  width: number,
  height: number
): ProjectedCanvasNode {
  return {
    projectRelativePath,
    nodeKind: 'file',
    mediaKind: 'image',
    x,
    y,
    width,
    height,
    z: 1,
    availability: {
      state: 'available',
      fileUrl: `/api/projects/p/files/raw/${projectRelativePath}?v=rev`,
      revision: 'rev',
      size: 1000,
      mimeType: 'image/png',
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: width
    }
  };
}
