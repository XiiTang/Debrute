import { describe, expect, it } from 'vitest';
import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import {
  canvasLayoutOverridesForCanvas,
  canvasLocalLayoutDraftFromDragState,
  canvasLocalLayoutDraftFromMoveState,
  canvasLocalLayoutDraftFromResizeState,
  canvasLocalLayoutDraftMatchesProjection,
  canvasNodesWithLayoutOverrides
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

  it('creates resize-node layout overrides from resize geometry', () => {
    const draft = canvasLocalLayoutDraftFromResizeState({
      canvasId: 'canvas-1',
      dragState: resizeState({
        handle: 'se',
        start: { x: 0, y: 0 },
        current: { x: 20, y: 10 },
        origin: { x: 10, y: 20, width: 200, height: 120 },
        preserveAspect: false
      }),
      point: { x: 20, y: 10 }
    });

    expect(draft).toEqual({
      canvasId: 'canvas-1',
      nodeLayouts: [
        { projectRelativePath: 'flow/a.png', x: 10, y: 20, width: 220, height: 130 }
      ]
    });
  });

  it('creates resize-node layout overrides with aspect ratio preserved', () => {
    const draft = canvasLocalLayoutDraftFromResizeState({
      canvasId: 'canvas-1',
      dragState: resizeState({
        handle: 'se',
        start: { x: 0, y: 0 },
        current: { x: 100, y: 0 },
        origin: { x: 10, y: 20, width: 200, height: 100 },
        preserveAspect: true
      }),
      point: { x: 100, y: 0 }
    });

    expect(draft.nodeLayouts[0]).toEqual({
      projectRelativePath: 'flow/a.png',
      x: 10,
      y: 20,
      width: 280,
      height: 140
    });
  });

  it('clamps resize-node layout overrides to the minimum size', () => {
    const draft = canvasLocalLayoutDraftFromResizeState({
      canvasId: 'canvas-1',
      dragState: resizeState({
        handle: 'nw',
        start: { x: 100, y: 100 },
        current: { x: 1000, y: 1000 },
        origin: { x: 10, y: 20, width: 200, height: 120 },
        preserveAspect: false
      }),
      point: { x: 1000, y: 1000 }
    });

    expect(draft.nodeLayouts[0]).toEqual({
      projectRelativePath: 'flow/a.png',
      x: 162,
      y: 92,
      width: 48,
      height: 48
    });
  });

  it('creates local layout drafts for move and resize drag states', () => {
    expect(canvasLocalLayoutDraftFromDragState({
      canvasId: 'canvas-1',
      dragState: moveState([origin('flow/a.png', 10, 20, 200, 120)], { x: 5, y: 6 }),
      point: { x: 25, y: 36 }
    })).toEqual({
      canvasId: 'canvas-1',
      nodeLayouts: [
        { projectRelativePath: 'flow/a.png', x: 30, y: 50, width: 200, height: 120 }
      ]
    });

    expect(canvasLocalLayoutDraftFromDragState({
      canvasId: 'canvas-1',
      dragState: resizeState({
        handle: 'e',
        start: { x: 0, y: 0 },
        current: { x: 30, y: 40 },
        origin: { x: 10, y: 20, width: 200, height: 120 },
        preserveAspect: false
      }),
      point: { x: 30, y: 40 }
    })).toEqual({
      canvasId: 'canvas-1',
      nodeLayouts: [
        { projectRelativePath: 'flow/a.png', x: 10, y: 20, width: 230, height: 120 }
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

  it('applies local layout overrides to all canvas nodes', () => {
    const nodes = [
      node('flow/a.png', 10, 20, 200, 120),
      node('flow/b.png', 400, 20, 100, 80)
    ];

    expect(canvasNodesWithLayoutOverrides({
      nodes,
      layoutOverrides: [
        { projectRelativePath: 'flow/a.png', x: 30, y: 40, width: 240, height: 160 }
      ]
    })).toEqual([
      expect.objectContaining({
        projectRelativePath: 'flow/a.png',
        x: 30,
        y: 40,
        width: 240,
        height: 160
      }),
      nodes[1]
    ]);
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

function resizeState(input: {
  handle: Extract<CanvasRuntimeDragState, { kind: 'resize-node' }>['handle'];
  start: { x: number; y: number };
  current?: { x: number; y: number } | undefined;
  origin: Extract<CanvasRuntimeDragState, { kind: 'resize-node' }>['origin'];
  preserveAspect: boolean;
}): Extract<CanvasRuntimeDragState, { kind: 'resize-node' }> {
  return {
    kind: 'resize-node',
    pointerId: 1,
    handle: input.handle,
    start: input.start,
    node: { projectRelativePath: 'flow/a.png', nodeKind: 'file', mediaKind: 'image' },
    origin: input.origin,
    preserveAspect: input.preserveAspect,
    ...(input.current ? { current: input.current } : {})
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
