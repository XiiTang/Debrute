import { describe, expect, it, vi } from 'vitest';
import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import { createCanvasManualLayoutLifecycle } from './CanvasManualLayoutLifecycle';
import type { CanvasRuntimeDragState } from './CanvasEditorRuntime';

describe('Canvas Manual Layout lifecycle', () => {
  it('keeps a submitted draft visible until the Canvas Projection confirms it', async () => {
    const submitted: unknown[] = [];
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('flow/a.png', 0)),
      submitManualLayout: async (nodeLayouts) => {
        submitted.push(nodeLayouts);
      }
    });
    const finished = moveState('flow/a.png', 0, 20);

    lifecycle.setActiveDrag(finished);
    expect(lifecycle.getPresentation().layoutOverrides).toEqual([
      { projectRelativePath: 'flow/a.png', x: 20, y: 0, width: 200, height: 120 }
    ]);

    await lifecycle.submitFinishedDrag(finished);
    expect(submitted).toEqual([[
      { projectRelativePath: 'flow/a.png', x: 20, y: 0, width: 200, height: 120 }
    ]]);
    expect(lifecycle.getPresentation().layoutOverrides).toEqual([
      { projectRelativePath: 'flow/a.png', x: 20, y: 0, width: 200, height: 120 }
    ]);

    lifecycle.acceptProjection(projection(node('flow/a.png', 20)));
    expect(lifecycle.getPresentation().layoutOverrides).toEqual([]);
  });

  it('discards older drafts when a newer rectangle for the same node is confirmed', async () => {
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('flow/a.png', 0)),
      submitManualLayout: async () => undefined
    });

    await lifecycle.submitFinishedDrag(moveState('flow/a.png', 0, 20));
    await lifecycle.submitFinishedDrag(moveState('flow/a.png', 20, 50));
    lifecycle.acceptProjection(projection(node('flow/a.png', 50)));

    expect(lifecycle.getPresentation().layoutOverrides).toEqual([]);
  });

  it('keeps rapid submissions for different nodes visible while both requests are unresolved', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const submitManualLayout = submissionSequence(first.promise, second.promise);
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('flow/a.png', 0), node('flow/b.png', 0)),
      submitManualLayout
    });

    const firstSubmission = lifecycle.submitFinishedDrag(moveState('flow/a.png', 0, 20));
    const secondSubmission = lifecycle.submitFinishedDrag(moveState('flow/b.png', 0, 30));

    expect(submitManualLayout).toHaveBeenCalledTimes(2);
    expect(lifecycle.getPresentation().layoutOverrides).toEqual([
      { projectRelativePath: 'flow/a.png', x: 20, y: 0, width: 200, height: 120 },
      { projectRelativePath: 'flow/b.png', x: 30, y: 0, width: 200, height: 120 }
    ]);

    first.resolve(undefined);
    second.resolve(undefined);
    await Promise.all([firstSubmission, secondSubmission]);
    expect(lifecycle.getPresentation().layoutOverrides).toHaveLength(2);
  });

  it('removes only the failed submission and preserves a later absolute rectangle', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('flow/a.png', 0), node('flow/b.png', 0)),
      submitManualLayout: submissionSequence(first.promise, second.promise)
    });

    const firstSubmission = lifecycle.submitFinishedDrag(moveState('flow/a.png', 0, 20));
    const secondSubmission = lifecycle.submitFinishedDrag(moveState('flow/b.png', 0, 30));
    first.reject(new Error('first write failed'));

    await expect(firstSubmission).rejects.toThrow('first write failed');
    expect(lifecycle.getPresentation().layoutOverrides).toEqual([
      { projectRelativePath: 'flow/b.png', x: 30, y: 0, width: 200, height: 120 }
    ]);

    second.resolve(undefined);
    await secondSubmission;
  });

  it('removes a failed submission after an intervening unconfirmed Projection', async () => {
    const request = deferred<void>();
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('flow/a.png', 0)),
      submitManualLayout: () => request.promise
    });

    const submission = lifecycle.submitFinishedDrag(moveState('flow/a.png', 0, 20));
    lifecycle.acceptProjection(projection(node('flow/a.png', 5)));
    request.reject(new Error('layout write failed'));

    await expect(submission).rejects.toThrow('layout write failed');
    expect(lifecycle.getPresentation().layoutOverrides).toEqual([]);
  });

  it('keeps the newer same-node draft when an older Projection arrives first', async () => {
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('flow/a.png', 0)),
      submitManualLayout: async () => undefined
    });

    await lifecycle.submitFinishedDrag(moveState('flow/a.png', 0, 20));
    await lifecycle.submitFinishedDrag(moveState('flow/a.png', 20, 50));
    lifecycle.acceptProjection(projection(node('flow/a.png', 20)));

    expect(lifecycle.getPresentation().layoutOverrides).toEqual([
      { projectRelativePath: 'flow/a.png', x: 50, y: 0, width: 200, height: 120 }
    ]);
  });

  it('drops drafts for nodes removed from the Projection', async () => {
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('flow/a.png', 0)),
      submitManualLayout: async () => undefined
    });

    await lifecycle.submitFinishedDrag(moveState('flow/a.png', 0, 20));
    lifecycle.acceptProjection(projection());

    expect(lifecycle.getPresentation().layoutOverrides).toEqual([]);
  });

  it('does not republish a late request after disposal', async () => {
    const request = deferred<void>();
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('flow/a.png', 0)),
      submitManualLayout: () => request.promise
    });

    const submission = lifecycle.submitFinishedDrag(moveState('flow/a.png', 0, 20));
    lifecycle.dispose();
    request.reject(new Error('late failure'));

    await expect(submission).rejects.toThrow('late failure');
    expect(lifecycle.getPresentation().layoutOverrides).toEqual([]);
  });
});

function submissionSequence(...requests: Promise<void>[]) {
  let index = 0;
  return vi.fn(() => requests[index++]!);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function moveState(path: string, originX: number, currentX: number): Extract<CanvasRuntimeDragState, { kind: 'move-node' }> {
  return {
    kind: 'move-node',
    pointerId: 1,
    start: { x: 0, y: 0 },
    current: { x: currentX - originX, y: 0 },
    origins: [{ projectRelativePath: path, x: originX, y: 0, width: 200, height: 120 }]
  };
}

function projection(...nodes: ProjectedCanvasNode[]): CanvasProjection {
  return { canvasId: 'canvas-1', nodes, edges: [], diagnostics: [] };
}

function node(projectRelativePath: string, x: number): ProjectedCanvasNode {
  return {
    projectRelativePath,
    nodeKind: 'file',
    mediaKind: 'image',
    x,
    y: 0,
    width: 200,
    height: 120,
    z: 1,
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'image/png',
      fileUrl: `/files/${projectRelativePath}`,
      revision: 'rev'
    }
  };
}
