import { describe, expect, it } from 'vitest';
import type {
  WorkbenchCanvasDocumentMutationResult,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import type { CanvasDocument, CanvasProjection } from '@debrute/canvas-core';
import {
  createCanvasTextViewportStateController,
  type CanvasTextViewportStateController
} from './canvasSnapshotUpdates';
import { createWorkbenchProjectProjection } from './WorkbenchProjectProjection.js';

type SimulatedCanvasMutationResult = WorkbenchCanvasDocumentMutationResult & {
  canvas: CanvasDocument;
  projection: CanvasProjection;
};

describe('canvas snapshot updates', () => {
  it('serializes text viewport persistence while preserving the latest local viewport', async () => {
    const snapshot = snapshotFixture({
      canvases: [textCanvasDocument('canvas-1')],
      projections: [projectionFixture(textCanvasDocument('canvas-1'), 'rev-a')]
    });
    const requests: Array<{
      canvasId: string;
      updates: Array<{ projectRelativePath: string; scrollTop: number; scrollLeft: number }>;
      resolve: (result: SimulatedCanvasMutationResult) => void;
    }> = [];
    const harness = createViewportHarness(snapshot, async (canvasId, input) => new Promise((resolve) => {
        requests.push({
          canvasId,
          updates: input.updates,
          resolve
        });
      }));
    const updateTextViewport = harness.controller.update;

    const first = updateTextViewport('canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });

    expect(requests).toHaveLength(1);
    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 72, scrollLeft: 9 });

    const second = updateTextViewport('canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 84, scrollLeft: 11 }]
    });

    expect(requests).toHaveLength(1);
    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 84, scrollLeft: 11 });

    requests[0]?.resolve(canvasTextViewportMutationResult('canvas-1', 72, 9, 2));
    await waitForRequestCount(requests, 2);

    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 84, scrollLeft: 11 });
    expect(requests[1]).toMatchObject({
      canvasId: 'canvas-1',
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 84, scrollLeft: 11 }]
    });

    requests[1]?.resolve(canvasTextViewportMutationResult('canvas-1', 84, 11, 3));
    await Promise.all([first, second]);

    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 84, scrollLeft: 11 });
  });

  it('propagates text viewport persistence errors without replaying updates', async () => {
    const confirmedCanvas = textCanvasDocument('canvas-1', { scrollTop: 15, scrollLeft: 2 });
    const snapshot = snapshotFixture({
      canvases: [confirmedCanvas],
      projections: [projectionFixture(confirmedCanvas, 'rev-a')]
    });
    const requests: Array<{
      canvasId: string;
      updates: Array<{ projectRelativePath: string; scrollTop: number; scrollLeft: number }>;
      resolve: (result: SimulatedCanvasMutationResult) => void;
      reject: (error: unknown) => void;
    }> = [];
    const harness = createViewportHarness(snapshot, async (canvasId, input) => new Promise((resolve, reject) => {
        requests.push({
          canvasId,
          updates: input.updates,
          resolve,
          reject
        });
      }));
    const updateTextViewport = harness.controller.update;

    const updateError = new Error('Text viewport persistence failed.');
    const updateResult = updateTextViewport('canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });

    expect(requests).toHaveLength(1);
    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 72, scrollLeft: 9 });

    const rejection = expect(updateResult).rejects.toBe(updateError);
    requests[0]?.reject(updateError);
    await rejection;

    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 15, scrollLeft: 2 });
    expect(requests).toHaveLength(1);
  });

  it('does not attach an older persistence failure to a newer queued viewport update', async () => {
    const confirmedCanvas = textCanvasDocument('canvas-1', { scrollTop: 15, scrollLeft: 2 });
    const snapshot = snapshotFixture({
      canvases: [confirmedCanvas],
      projections: [projectionFixture(confirmedCanvas, 'rev-a')]
    });
    const requests: Array<{
      canvasId: string;
      updates: Array<{ projectRelativePath: string; scrollTop: number; scrollLeft: number }>;
      resolve: (result: SimulatedCanvasMutationResult) => void;
      reject: (error: unknown) => void;
    }> = [];
    const harness = createViewportHarness(snapshot, async (canvasId, input) => new Promise((resolve, reject) => {
        requests.push({ canvasId, updates: input.updates, resolve, reject });
      }));
    const updateTextViewport = harness.controller.update;

    const first = updateTextViewport('canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });
    const second = updateTextViewport('canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 84, scrollLeft: 11 }]
    });
    const updateError = new Error('First viewport persistence failed.');
    const firstResult = expect(first).rejects.toBe(updateError);
    const secondResult = expect(second).resolves.toBeUndefined();

    requests[0]?.reject(updateError);
    await waitForRequestCount(requests, 2);
    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 84, scrollLeft: 11 });

    requests[1]?.resolve(canvasTextViewportMutationResult('canvas-1', 84, 11, 2));
    await Promise.all([firstResult, secondResult]);

    expect(requests).toHaveLength(2);
    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 84, scrollLeft: 11 });
  });

  it('restores the latest Runtime-confirmed viewport when a newer queued update fails', async () => {
    const confirmedCanvas = textCanvasDocument('canvas-1', { scrollTop: 15, scrollLeft: 2 });
    const snapshot = snapshotFixture({
      canvases: [confirmedCanvas],
      projections: [projectionFixture(confirmedCanvas, 'rev-a')]
    });
    const requests: Array<{
      resolve: (result: SimulatedCanvasMutationResult) => void;
      reject: (error: unknown) => void;
    }> = [];
    const harness = createViewportHarness(snapshot, async () => new Promise((resolve, reject) => {
        requests.push({ resolve, reject });
      }));
    const updateTextViewport = harness.controller.update;

    const first = updateTextViewport('canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });
    const second = updateTextViewport('canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 84, scrollLeft: 11 }]
    });
    const updateError = new Error('New viewport persistence failed.');
    const firstResult = expect(first).resolves.toBeUndefined();
    const secondResult = expect(second).rejects.toBe(updateError);

    requests[0]?.resolve(canvasTextViewportMutationResult('canvas-1', 72, 9, 2));
    await waitForRequestCount(requests, 2);
    requests[1]?.reject(updateError);
    await Promise.all([firstResult, secondResult]);

    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 72, scrollLeft: 9 });
  });

  it('keeps a pending local viewport over newer authoritative snapshots and reveals the latest authority on failure', async () => {
    const initialCanvas = textCanvasDocument('canvas-1', { scrollTop: 15, scrollLeft: 2 });
    const requests: Array<{ reject: (error: unknown) => void }> = [];
    const harness = createViewportHarness(snapshotFixture({
      canvases: [initialCanvas],
      projections: [projectionFixture(initialCanvas, 'rev-1')]
    }), async () => new Promise((_resolve, reject) => {
      requests.push({ reject });
    }));

    const update = harness.controller.update('canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });
    const newerCanvas = textCanvasDocument('canvas-1', { scrollTop: 33, scrollLeft: 4 });
    harness.commitAuthoritativeSnapshot(snapshotFixture({
      canvases: [newerCanvas],
      projections: [projectionFixture(newerCanvas, 'rev-2')]
    }));

    expect(textViewport(harness.authoritativeSnapshot())).toEqual({ scrollTop: 33, scrollLeft: 4 });
    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 72, scrollLeft: 9 });

    const updateError = new Error('Viewport persistence failed.');
    const rejection = expect(update).rejects.toBe(updateError);
    requests[0]?.reject(updateError);
    await rejection;

    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 33, scrollLeft: 4 });
  });

  it('does not let the HTTP result replace newer accepted Canvas fields', async () => {
    const initialCanvas = textCanvasDocument('canvas-1', { scrollTop: 15, scrollLeft: 2 });
    const requests: Array<{ resolve: (result: SimulatedCanvasMutationResult) => void }> = [];
    const harness = createViewportHarness(snapshotFixture({
      canvases: [initialCanvas],
      projections: [projectionFixture(initialCanvas, 'rev-1')]
    }), async () => new Promise((resolve) => {
      requests.push({ resolve });
    }));

    const update = harness.controller.update('canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });
    const confirmedCanvas = textCanvasDocument('canvas-1', { scrollTop: 72, scrollLeft: 9 });
    harness.commitAuthoritativeSnapshot(snapshotFixture({
      canvases: [confirmedCanvas],
      projections: [projectionFixture(confirmedCanvas, 'rev-2')]
    }));
    const newerCanvas = {
      ...textCanvasDocument('canvas-1', { scrollTop: 72, scrollLeft: 9 }),
      name: 'renamed-by-newer-revision'
    };
    harness.commitAuthoritativeSnapshot(snapshotFixture({
      canvases: [newerCanvas],
      projections: [projectionFixture(newerCanvas, 'rev-3')]
    }), 3);

    requests[0]?.resolve(canvasTextViewportMutationResult('canvas-1', 72, 9, 2));
    await update;

    expect(harness.authoritativeSnapshot().canvases[0]?.name).toBe('renamed-by-newer-revision');
    expect(textViewport(harness.authoritativeSnapshot())).toEqual({ scrollTop: 72, scrollLeft: 9 });
  });

  it('discards an older viewport response after a newer authoritative revision', async () => {
    const initialCanvas = textCanvasDocument('canvas-1', { scrollTop: 15, scrollLeft: 2 });
    const requests: Array<{ resolve: (result: SimulatedCanvasMutationResult) => void }> = [];
    const harness = createViewportHarness(snapshotFixture({
      canvases: [initialCanvas],
      projections: [projectionFixture(initialCanvas, 'rev-1')]
    }), async () => new Promise((resolve) => {
      requests.push({ resolve });
    }));

    const update = harness.controller.update('canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });
    const confirmedCanvas = textCanvasDocument('canvas-1', { scrollTop: 72, scrollLeft: 9 });
    harness.commitAuthoritativeSnapshot(snapshotFixture({
      canvases: [confirmedCanvas],
      projections: [projectionFixture(confirmedCanvas, 'rev-2')]
    }));
    const newerCanvas = {
      ...textCanvasDocument('canvas-1', { scrollTop: 33, scrollLeft: 4 }),
      name: 'authoritative-rev-3'
    };
    harness.commitAuthoritativeSnapshot(snapshotFixture({
      canvases: [newerCanvas],
      projections: [projectionFixture(newerCanvas, 'rev-3')]
    }), 3);

    requests[0]?.resolve(canvasTextViewportMutationResult('canvas-1', 72, 9, 2));
    await update;

    expect(harness.authoritativeSnapshot().canvases[0]?.name).toBe('authoritative-rev-3');
    expect(textViewport(harness.authoritativeSnapshot())).toEqual({ scrollTop: 33, scrollLeft: 4 });
    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 33, scrollLeft: 4 });
  });

  it('does not publish a disposed generation failure into the new Project binding', async () => {
    const initialCanvas = textCanvasDocument('canvas-1', { scrollTop: 15, scrollLeft: 2 });
    const requests: Array<{ reject: (error: unknown) => void }> = [];
    const harness = createViewportHarness(snapshotFixture({
      canvases: [initialCanvas],
      projections: [projectionFixture(initialCanvas, 'rev-1')]
    }), async () => new Promise((_resolve, reject) => {
      requests.push({ reject });
    }));
    const update = harness.controller.update('canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });
    const replacementCanvas = textCanvasDocument('canvas-1', { scrollTop: 5, scrollLeft: 1 });

    harness.rebind(snapshotFixture({
      canvases: [replacementCanvas],
      projections: [projectionFixture(replacementCanvas, 'replacement')]
    }));
    requests[0]?.reject(new Error('old binding ended'));

    await expect(update).resolves.toBeUndefined();
    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 5, scrollLeft: 1 });
  });

  it('does not send an older generation queued viewport update through the new Project binding', async () => {
    const firstCanvas = textCanvasDocument('canvas-1', { scrollTop: 15, scrollLeft: 2 });
    const secondCanvas = textCanvasDocument('canvas-2', { scrollTop: 25, scrollLeft: 3 });
    let requestCount = 0;
    let rejectFirstRequest: ((error: unknown) => void) | undefined;
    const harness = createViewportHarness(snapshotFixture({
      canvases: [firstCanvas, secondCanvas],
      projections: [
        projectionFixture(firstCanvas, 'rev-1'),
        projectionFixture(secondCanvas, 'rev-1')
      ]
    }), async (canvasId) => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirstRequest = reject;
        });
      }
      return canvasTextViewportMutationResult(canvasId, 84, 11, 2);
    });

    const first = harness.controller.update('canvas-1', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });
    const queued = harness.controller.update('canvas-2', {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 84, scrollLeft: 11 }]
    });
    const replacementCanvas = textCanvasDocument('canvas-1', { scrollTop: 5, scrollLeft: 1 });

    harness.rebind(snapshotFixture({
      canvases: [replacementCanvas],
      projections: [projectionFixture(replacementCanvas, 'replacement')]
    }));
    rejectFirstRequest?.(new Error('old binding ended'));

    await expect(Promise.all([first, queued])).resolves.toEqual([undefined, undefined]);
    expect(requestCount).toBe(1);
    expect(textViewport(harness.snapshot())).toEqual({ scrollTop: 5, scrollLeft: 1 });
  });
});

function createViewportHarness(
  initialSnapshot: WorkbenchProjectSessionSnapshot,
  persist: (
    canvasId: string,
    input: Parameters<CanvasTextViewportStateController['update']>[1]
  ) => Promise<SimulatedCanvasMutationResult>
): {
  controller: CanvasTextViewportStateController;
  snapshot: () => WorkbenchProjectSessionSnapshot;
  authoritativeSnapshot: () => WorkbenchProjectSessionSnapshot;
  commitAuthoritativeSnapshot: (
    snapshot: WorkbenchProjectSessionSnapshot,
    projectRevision?: number
  ) => void;
  rebind(snapshot: WorkbenchProjectSessionSnapshot): void;
} {
  const projectProjection = createWorkbenchProjectProjection();
  projectProjection.acceptBoundProject({
    projectId: 'project-1',
    projectRevision: 1,
    snapshot: initialSnapshot,
    workingCopies: { text: {}, feedback: {} }
  });
  const controller = createCanvasTextViewportStateController({
    projectProjection,
    updateCanvasTextViewportState: async (canvasId, input) => {
      const result = await persist(canvasId, input);
      const state = projectProjection.getState();
      if (state.status === 'bound' && result.projectRevision === state.projectRevision + 1) {
        projectProjection.acceptProjectEvent({
          type: 'canvas.changed',
          projectId: result.projectId,
          projectRevision: result.projectRevision,
          canvas: result.canvas,
          projection: result.projection
        });
      }
      return result;
    }
  });
  const acceptedState = () => {
    const state = projectProjection.getState();
    if (state.status === 'unbound') {
      throw new Error('Expected a bound Project fixture.');
    }
    return state;
  };
  return {
    controller,
    snapshot: () => acceptedState().presentedSnapshot,
    authoritativeSnapshot: () => acceptedState().authoritativeSnapshot,
    commitAuthoritativeSnapshot: (next, projectRevision = acceptedState().projectRevision + 1) => {
      projectProjection.acceptProjectEvent({
        type: 'project.changed',
        projectId: 'project-1',
        projectRevision,
        snapshot: next
      });
    },
    rebind: (next) => {
      projectProjection.acceptBoundProject({
        projectId: 'project-2',
        projectRevision: 1,
        snapshot: next,
        workingCopies: { text: {}, feedback: {} }
      });
    }
  };
}

function snapshotFixture(input: {
  canvases: CanvasDocument[];
  projections: CanvasProjection[];
}): WorkbenchProjectSessionSnapshot {
  return {
    metadata: {
      project: {
        id: 'project-1',
        name: 'Project',
        createdAt: '2026-06-11T00:00:00.000Z',
        updatedAt: '2026-06-11T00:00:00.000Z'
      }
    },
    files: [],
    canvases: input.canvases,
    projections: input.projections,
    diagnostics: [],
    canvasRegistry: {
      status: 'ready',
      canvasOrder: input.canvases.map((canvas) => canvas.id)
    },
    health: {
      projectName: 'Project',
      canvasCount: input.canvases.length,
      diagnosticCounts: {
        errors: 0,
        warnings: 0,
      },
      checkedAt: '2026-06-11T00:00:00.000Z'
    }
  };
}

function textCanvasDocument(
  canvasId: string,
  textViewport?: { scrollTop: number; scrollLeft: number }
): CanvasDocument {
  return {
    id: canvasId,
    name: canvasId,
    nodeElements: [{
      projectRelativePath: 'notes/readme.md',
      nodeKind: 'file',
      mediaKind: 'text',
      x: 10,
      y: 20,
      width: 420,
      height: 260,
      z: 0,
      ...(textViewport ? { textViewport } : {})
    }],
    annotations: [],
    preferences: {
      showDiagnostics: true
    }
  };
}

function canvasTextViewportMutationResult(
  canvasId: string,
  scrollTop: number,
  scrollLeft: number,
  projectRevision: number
): SimulatedCanvasMutationResult {
  const canvas = {
    ...textCanvasDocument(canvasId),
    nodeElements: textCanvasDocument(canvasId).nodeElements.map((node) => ({
      ...node,
      textViewport: { scrollTop, scrollLeft }
    }))
  };
  return {
    projectId: 'project-1',
    projectRevision,
    canvas,
    projection: projectionFixture(canvas, `rev-${projectRevision}`)
  };
}

function textViewport(snapshot: WorkbenchProjectSessionSnapshot): { scrollTop: number; scrollLeft: number } | undefined {
  return snapshot.canvases[0]?.nodeElements[0]?.textViewport;
}

async function waitForRequestCount(
  requests: unknown[],
  count: number
): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (requests.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected ${count} text viewport persistence requests, got ${requests.length}.`);
}

function projectionFixture(canvas: CanvasDocument, revision: string): CanvasProjection {
  return {
    canvasId: canvas.id,
    nodes: canvas.nodeElements.map((node) => ({
      ...node,
      availability: {
        state: 'available',
        size: 100,
        mimeType: 'image/png',
        fileUrl: `/api/projects/p/files/raw/${node.projectRelativePath}?v=${revision}`,
        revision
      }
    })),
    edges: [],
    diagnostics: []
  };
}
