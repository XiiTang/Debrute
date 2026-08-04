import { describe, expect, it, vi } from 'vitest';
import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import { createCanvasManualLayoutLifecycle } from './CanvasManualLayoutLifecycle.js';
import type { CanvasRuntimeLayoutInteraction } from './CanvasEditorRuntime.js';

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

    lifecycle.setActiveInteraction(finished);
    expect(lifecycle.getPresentation().layoutOverrides).toEqual([
      { projectRelativePath: 'flow/a.png', x: 20, y: 0, width: 200, height: 120 }
    ]);

    await lifecycle.submitFinishedInteraction(finished);
    expect(submitted).toEqual([{
      interaction: 'move',
      nodeLayouts: [
        { projectRelativePath: 'flow/a.png', x: 20, y: 0, width: 200, height: 120 }
      ]
    }]);
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

    await lifecycle.submitFinishedInteraction(moveState('flow/a.png', 0, 20));
    await lifecycle.submitFinishedInteraction(moveState('flow/a.png', 20, 50));
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

    const firstSubmission = lifecycle.submitFinishedInteraction(moveState('flow/a.png', 0, 20));
    const secondSubmission = lifecycle.submitFinishedInteraction(moveState('flow/b.png', 0, 30));

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

    const firstSubmission = lifecycle.submitFinishedInteraction(moveState('flow/a.png', 0, 20));
    const secondSubmission = lifecycle.submitFinishedInteraction(moveState('flow/b.png', 0, 30));
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

    const submission = lifecycle.submitFinishedInteraction(moveState('flow/a.png', 0, 20));
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

    await lifecycle.submitFinishedInteraction(moveState('flow/a.png', 0, 20));
    await lifecycle.submitFinishedInteraction(moveState('flow/a.png', 20, 50));
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

    await lifecycle.submitFinishedInteraction(moveState('flow/a.png', 0, 20));
    lifecycle.acceptProjection(projection());

    expect(lifecycle.getPresentation().layoutOverrides).toEqual([]);
  });

  it('submits a zero-geometry move when it changes stack order and rejects a disappeared batch', async () => {
    const submitManualLayout = vi.fn(async () => undefined);
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('flow/a.png', 0), node('flow/b.png', 20)),
      submitManualLayout
    });

    await lifecycle.submitFinishedInteraction(moveState('flow/a.png', 0, 0));
    expect(submitManualLayout).toHaveBeenCalledOnce();
    expect(lifecycle.getPresentation().stackOrder).toEqual(['flow/b.png', 'flow/a.png']);
    submitManualLayout.mockClear();

    const batch = moveState('flow/a.png', 0, 10);
    batch.origins.push({ projectRelativePath: 'flow/b.png', x: 20, y: 0, width: 200, height: 120 });
    lifecycle.acceptProjection(projection(node('flow/a.png', 0)));
    await lifecycle.submitFinishedInteraction(batch);
    expect(submitManualLayout).not.toHaveBeenCalled();
    expect(lifecycle.getPresentation().layoutOverrides).toEqual([]);
  });

  it('skips a complete no-op when geometry and stack order already match', async () => {
    const submitManualLayout = vi.fn(async () => undefined);
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('flow/a.png', 0, 2), node('flow/b.png', 20, 1)),
      submitManualLayout
    });

    await lifecycle.submitFinishedInteraction(moveState('flow/a.png', 0, 0));

    expect(submitManualLayout).not.toHaveBeenCalled();
    expect(lifecycle.getPresentation()).toEqual({
      layoutOverrides: [],
      stackOrder: undefined,
      raisedNodeProjectRelativePaths: []
    });
  });

  it('keeps a raised multi-selection in its effective stack order', () => {
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(
        node('b.png', 0, 0),
        node('a.png', 20, 1)
      ),
      submitManualLayout: async () => undefined
    });
    const interaction = moveState('a.png', 20, 40);
    interaction.origins.push({
      projectRelativePath: 'b.png',
      x: 0,
      y: 0,
      width: 200,
      height: 120
    });

    lifecycle.setActiveInteraction(interaction);

    expect(lifecycle.getPresentation().raisedNodeProjectRelativePaths).toEqual(['b.png', 'a.png']);
  });

  it('raises an active move group together while preserving its internal order', () => {
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(
        node('a.png', 0, 0),
        node('b.png', 20, 1),
        node('c.png', 40, 2),
        node('d.png', 60, 3)
      ),
      submitManualLayout: async () => undefined
    });
    const move = moveState('b.png', 20, 30);
    move.origins.push({ projectRelativePath: 'd.png', x: 60, y: 0, width: 200, height: 120 });

    lifecycle.setActiveInteraction(move);

    expect(lifecycle.getPresentation().stackOrder).toEqual(['a.png', 'c.png', 'b.png', 'd.png']);
  });

  it('keeps a stack-only resize optimistic until the Projection confirms its order', async () => {
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('a.png', 0, 0), node('b.png', 20, 1)),
      submitManualLayout: async () => undefined
    });
    const resize = resizeState('a.png', 0, 200, 120);

    lifecycle.setActiveInteraction(resize);
    expect(lifecycle.getPresentation().stackOrder).toEqual(['b.png', 'a.png']);
    await lifecycle.submitFinishedInteraction(resize);
    lifecycle.acceptProjection(projection(node('a.png', 0, 0), node('b.png', 20, 1)));
    expect(lifecycle.getPresentation().stackOrder).toEqual(['b.png', 'a.png']);

    lifecycle.acceptProjection(projection(node('a.png', 0, 1), node('b.png', 20, 0)));
    expect(lifecycle.getPresentation().stackOrder).toBeUndefined();
  });

  it('keeps a later stack submission optimistic when only the earlier order is confirmed', async () => {
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('a.png', 0, 0), node('b.png', 20, 1), node('c.png', 40, 2)),
      submitManualLayout: async () => undefined
    });

    await lifecycle.submitFinishedInteraction(moveState('a.png', 0, 0));
    await lifecycle.submitFinishedInteraction(moveState('b.png', 20, 20));
    expect(lifecycle.getPresentation().stackOrder).toEqual(['c.png', 'a.png', 'b.png']);

    lifecycle.acceptProjection(projection(node('a.png', 0, 2), node('b.png', 20, 0), node('c.png', 40, 1)));
    expect(lifecycle.getPresentation().stackOrder).toEqual(['c.png', 'a.png', 'b.png']);

    lifecycle.acceptProjection(projection(node('a.png', 0, 1), node('b.png', 20, 2), node('c.png', 40, 0)));
    expect(lifecycle.getPresentation().stackOrder).toBeUndefined();
  });

  it('rebases a later stack submission when an earlier concurrent submission fails', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('a.png', 0, 0), node('b.png', 20, 1), node('c.png', 40, 2)),
      submitManualLayout: submissionSequence(first.promise, second.promise)
    });

    const firstSubmission = lifecycle.submitFinishedInteraction(moveState('a.png', 0, 0));
    const secondSubmission = lifecycle.submitFinishedInteraction(moveState('b.png', 20, 20));
    expect(lifecycle.getPresentation().stackOrder).toEqual(['c.png', 'a.png', 'b.png']);

    first.reject(new Error('first stack write failed'));
    await expect(firstSubmission).rejects.toThrow('first stack write failed');
    expect(lifecycle.getPresentation().stackOrder).toEqual(['a.png', 'c.png', 'b.png']);

    second.resolve(undefined);
    await secondSubmission;
    lifecycle.acceptProjection(projection(node('a.png', 0, 0), node('b.png', 20, 2), node('c.png', 40, 1)));
    expect(lifecycle.getPresentation().stackOrder).toBeUndefined();
  });

  it('recognizes a later stack submission confirmed before an earlier submission fails', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('a.png', 0, 0), node('b.png', 20, 1), node('c.png', 40, 2)),
      submitManualLayout: submissionSequence(first.promise, second.promise)
    });

    const firstSubmission = lifecycle.submitFinishedInteraction(moveState('a.png', 0, 0));
    const secondSubmission = lifecycle.submitFinishedInteraction(moveState('b.png', 20, 20));

    lifecycle.acceptProjection(projection(node('a.png', 0, 0), node('b.png', 20, 2), node('c.png', 40, 1)));
    first.reject(new Error('first stack write failed'));
    await expect(firstSubmission).rejects.toThrow('first stack write failed');

    lifecycle.acceptProjection(projection(node('a.png', 0, 1), node('b.png', 20, 0), node('c.png', 40, 2)));
    expect(lifecycle.getPresentation().stackOrder).toBeUndefined();

    second.resolve(undefined);
    await secondSubmission;
  });

  it('restores stack presentation when a stack-changing submission fails', async () => {
    const request = deferred<void>();
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('a.png', 0, 0), node('b.png', 20, 1)),
      submitManualLayout: () => request.promise
    });
    const move = moveState('a.png', 0, 10);

    const submission = lifecycle.submitFinishedInteraction(move);
    expect(lifecycle.getPresentation().stackOrder).toEqual(['b.png', 'a.png']);
    request.reject(new Error('stack write failed'));

    await expect(submission).rejects.toThrow('stack write failed');
    expect(lifecycle.getPresentation().stackOrder).toBeUndefined();
  });

  it('does not republish a late request after disposal', async () => {
    const request = deferred<void>();
    const lifecycle = createCanvasManualLayoutLifecycle({
      canvasId: 'canvas-1',
      initialProjection: projection(node('flow/a.png', 0)),
      submitManualLayout: () => request.promise
    });

    const submission = lifecycle.submitFinishedInteraction(moveState('flow/a.png', 0, 20));
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

function moveState(path: string, originX: number, currentX: number): Extract<CanvasRuntimeLayoutInteraction, { kind: 'move-node' }> {
  return {
    kind: 'move-node',
    pointerId: 1,
    phase: 'active',
    startScreen: { x: 0, y: 0 },
    currentScreen: { x: currentX - originX, y: 0 },
    start: { x: 0, y: 0 },
    current: { x: currentX - originX, y: 0 },
    initialSelection: undefined,
    pressedProjectRelativePath: path,
    additive: false,
    origins: [{ projectRelativePath: path, x: originX, y: 0, width: 200, height: 120 }]
  };
}

function resizeState(
  path: string,
  x: number,
  width: number,
  height: number
): Extract<CanvasRuntimeLayoutInteraction, { kind: 'resize-node' }> {
  return {
    kind: 'resize-node',
    pointerId: 1,
    phase: 'active',
    startScreen: { x: 0, y: 0 },
    currentScreen: { x: 0, y: 0 },
    handle: 'se',
    start: { x: 0, y: 0 },
    current: { x: 0, y: 0 },
    initialSelection: undefined,
    node: { projectRelativePath: path, nodeKind: 'file', mediaKind: 'image' },
    origin: { x, y: 0, width, height },
    preserveAspect: false
  };
}

function projection(...nodes: ProjectedCanvasNode[]): CanvasProjection {
  return { canvasId: 'canvas-1', nodes, edges: [], diagnostics: [] };
}

function node(projectRelativePath: string, x: number, z = 1): ProjectedCanvasNode {
  return {
    projectRelativePath,
    nodeKind: 'file',
    mediaKind: 'image',
    x,
    y: 0,
    width: 200,
    height: 120,
    z,
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'image/png',
      fileUrl: `/files/${projectRelativePath}`,
      revision: 'rev'
    }
  };
}
