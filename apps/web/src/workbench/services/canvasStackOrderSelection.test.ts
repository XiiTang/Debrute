import { describe, expect, it } from 'vitest';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import {
  bringCanvasNodeToFront as bringCanvasNodeToFrontDocument,
  canvasNodeStackOrderTopFirst,
  type CanvasDocument,
  type CanvasNodeElement
} from '@debrute/canvas-core';
import type { CanvasSelection } from '../canvas/runtime/canvasSelection';
import { createCanvasSelectionStackOrderSync } from './canvasStackOrderSelection';

describe('canvas selection stack-order sync', () => {
  it('brings the selected node to the front when it is not already top', async () => {
    let snapshot = snapshotFixture([
      node('flow/a.png', 0),
      node('flow/b.png', 1)
    ]);
    let selection: CanvasSelection | undefined = { kind: 'node', projectRelativePath: 'flow/a.png' };
    const calls: string[] = [];
    const sync = createCanvasSelectionStackOrderSync({
      getSnapshot: () => snapshot,
      getActiveCanvasId: () => 'canvas-1',
      getSelection: () => selection,
      bringCanvasNodeToFront: async (canvasId, input) => {
        calls.push(`${canvasId}:${input.projectRelativePath}`);
        snapshot = applyBringToFront(snapshot, canvasId, input.projectRelativePath);
      }
    });

    await sync.syncSelectedNode();

    expect(calls).toEqual(['canvas-1:flow/a.png']);
    expect(canvasNodeStackOrderTopFirst(snapshot.canvases[0]!)[0]).toBe('flow/a.png');
    selection = { kind: 'node', projectRelativePath: 'flow/a.png' };
    await sync.syncSelectedNode();
    expect(calls).toEqual(['canvas-1:flow/a.png']);
  });

  it('does not call the API for non-node selections or missing nodes', async () => {
    const snapshot = snapshotFixture([
      node('flow/a.png', 0),
      node('flow/b.png', 1)
    ]);
    let selection: CanvasSelection | undefined = { kind: 'diagnostic', id: 'diagnostic-1' };
    const calls: string[] = [];
    const sync = createCanvasSelectionStackOrderSync({
      getSnapshot: () => snapshot,
      getActiveCanvasId: () => 'canvas-1',
      getSelection: () => selection,
      bringCanvasNodeToFront: async (_canvasId, input) => {
        calls.push(input.projectRelativePath);
      }
    });

    await sync.syncSelectedNode();
    selection = { kind: 'node', projectRelativePath: 'flow/missing.png' };
    await sync.syncSelectedNode();

    expect(calls).toEqual([]);
  });

  it('rejects when bringing the selected node to the front fails', async () => {
    const failure = new Error('stack-order write failed');
    const sync = createCanvasSelectionStackOrderSync({
      getSnapshot: () => snapshotFixture([
        node('flow/a.png', 0),
        node('flow/b.png', 1)
      ]),
      getActiveCanvasId: () => 'canvas-1',
      getSelection: () => ({ kind: 'node', projectRelativePath: 'flow/a.png' }),
      bringCanvasNodeToFront: async () => {
        throw failure;
      }
    });

    await expect(sync.syncSelectedNode()).rejects.toBe(failure);
  });

  it('rechecks the current selection after an in-flight stack-order mutation settles', async () => {
    let snapshot = snapshotFixture([
      node('flow/a.png', 0),
      node('flow/b.png', 1)
    ]);
    let selection: CanvasSelection | undefined = { kind: 'node', projectRelativePath: 'flow/a.png' };
    let resolveFirstMutation: (() => void) | undefined;
    const firstMutation = new Promise<void>((resolve) => {
      resolveFirstMutation = resolve;
    });
    const calls: string[] = [];
    const sync = createCanvasSelectionStackOrderSync({
      getSnapshot: () => snapshot,
      getActiveCanvasId: () => 'canvas-1',
      getSelection: () => selection,
      bringCanvasNodeToFront: async (canvasId, input) => {
        calls.push(input.projectRelativePath);
        if (input.projectRelativePath === 'flow/a.png') {
          await firstMutation;
        }
        snapshot = applyBringToFront(snapshot, canvasId, input.projectRelativePath);
      }
    });

    const firstSync = sync.syncSelectedNode();
    await Promise.resolve();
    expect(calls).toEqual(['flow/a.png']);

    selection = { kind: 'node', projectRelativePath: 'flow/b.png' };
    const secondSync = sync.syncSelectedNode();
    await Promise.resolve();
    expect(calls).toEqual(['flow/a.png']);

    resolveFirstMutation!();
    await Promise.all([firstSync, secondSync]);

    expect(calls).toEqual(['flow/a.png', 'flow/b.png']);
    expect(canvasNodeStackOrderTopFirst(snapshot.canvases[0]!)[0]).toBe('flow/b.png');
  });
});

function snapshotFixture(nodeElements: CanvasNodeElement[]): WorkbenchProjectSessionSnapshot {
  const canvas: CanvasDocument = {
    id: 'canvas-1',
    name: 'Canvas 1',
    nodeElements,
    annotations: [],
    preferences: {
      showDiagnostics: true
    }
  };
  return {
    metadata: {
      project: {
        id: 'project-1',
        name: 'Project',
        createdAt: '2026-07-09T00:00:00.000Z',
        updatedAt: '2026-07-09T00:00:00.000Z'
      }
    },
    files: [],
    canvases: [canvas],
    canvasRegistry: {
      status: 'ready',
      canvasOrder: ['canvas-1']
    },
    projections: [{
      canvasId: 'canvas-1',
      nodes: [],
      edges: [],
      diagnostics: []
    }],
    health: {
      projectName: 'Project',
      checkedAt: '2026-07-09T00:00:00.000Z',
      canvasCount: 1,
      diagnosticCounts: {
        errors: 0,
        warnings: 0,
        infos: 0
      },
      runtimeDataLocation: '/tmp/runtime'
    },
    diagnostics: []
  };
}

function applyBringToFront(
  snapshot: WorkbenchProjectSessionSnapshot,
  canvasId: string,
  projectRelativePath: string
): WorkbenchProjectSessionSnapshot {
  return {
    ...snapshot,
    canvases: snapshot.canvases.map((canvas) => (
      canvas.id === canvasId
        ? bringCanvasNodeToFrontDocument(canvas, { projectRelativePath })
        : canvas
    ))
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
