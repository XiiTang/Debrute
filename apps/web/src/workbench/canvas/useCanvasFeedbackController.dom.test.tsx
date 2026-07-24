import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type {
  WorkbenchApiClient,
  WorkbenchCanvasFeedbackMutationResult,
  WorkbenchEvent
} from '@debrute/app-protocol';
import type { CanvasFeedbackDocument } from '@debrute/canvas-core';
import { createCanvasOverlayRuntime } from './CanvasOverlayRuntime';
import {
  useCanvasFeedbackController,
  type CanvasFeedbackController
} from './useCanvasFeedbackController';

describe('useCanvasFeedbackController', () => {
  it('saves a pending comment through the feedback API and clears the draft', async () => {
    const api = apiFixture();
    const probe = await renderController(api);

    await act(async () => {
      probe.current.handleDraft({
        projectRelativePath: 'image.png',
        kind: 'comment',
        scope: 'file',
        feedbackBarTarget: feedbackTarget()
      });
      probe.current.setPendingComment('Review this');
    });
    await act(async () => {
      expect(await probe.current.savePending()).toBe(true);
    });

    expect(api.updateCanvasFeedbackEntry).toHaveBeenCalledWith({
      operation: 'add-item',
      projectRelativePath: 'image.png',
      item: { kind: 'comment', scope: 'file', comment: 'Review this' }
    });
    expect(probe.current.pendingItem).toBeUndefined();
    expect(probe.current.pendingComment).toBe('');
    await probe.unmount();
  });

  it('does not apply an older load after reset invalidates it', async () => {
    const load = deferred<CanvasFeedbackDocument>();
    const api = apiFixture({ readCanvasFeedback: vi.fn(() => load.promise) });
    const probe = await renderController(api);

    let pending!: Promise<void>;
    await act(async () => {
      pending = probe.current.load();
      probe.current.reset();
      load.resolve(feedbackDocumentFixture('stale-load.png'));
      await pending;
    });

    expect(probe.current.feedback).toBeUndefined();
    await probe.unmount();
  });

  it('keeps a newer feedback event when an older load resolves', async () => {
    const load = deferred<CanvasFeedbackDocument>();
    const api = apiFixture({ readCanvasFeedback: vi.fn(() => load.promise) });
    const probe = await renderController(api);
    const eventFeedback = feedbackDocumentFixture('event.png');

    let pending!: Promise<void>;
    await act(async () => {
      pending = probe.current.load();
      probe.current.applyEvent(feedbackEvent(eventFeedback));
      load.resolve(feedbackDocumentFixture('stale-load.png'));
      await pending;
    });

    expect(probe.current.feedback).toEqual(eventFeedback);
    await probe.unmount();
  });

  it('reports a successful update after its feedback event invalidates response state application', async () => {
    const update = deferred<WorkbenchCanvasFeedbackMutationResult>();
    const api = apiFixture({ updateCanvasFeedbackEntry: vi.fn(() => update.promise) });
    const probe = await renderController(api);
    const eventFeedback = feedbackDocumentFixture('event.png');

    let pending!: Promise<boolean>;
    await act(async () => {
      pending = probe.current.updateEntry({
        operation: 'set-marks',
        projectRelativePath: 'stale-update.png',
        marks: ['like']
      });
      probe.current.applyEvent(feedbackEvent(eventFeedback));
      update.resolve(feedbackMutationResult(feedbackDocumentFixture('stale-update.png')));
      expect(await pending).toBe(true);
    });

    expect(probe.current.feedback).toEqual(eventFeedback);
    await probe.unmount();
  });

  it('uses one epoch so a newer update invalidates an older load', async () => {
    const load = deferred<CanvasFeedbackDocument>();
    const update = deferred<WorkbenchCanvasFeedbackMutationResult>();
    const api = apiFixture({
      readCanvasFeedback: vi.fn(() => load.promise),
      updateCanvasFeedbackEntry: vi.fn(() => update.promise)
    });
    const probe = await renderController(api);

    let pendingLoad!: Promise<void>;
    let pendingUpdate!: Promise<boolean>;
    await act(async () => {
      pendingLoad = probe.current.load();
      pendingUpdate = probe.current.updateEntry({
        operation: 'set-marks',
        projectRelativePath: 'new-update.png',
        marks: ['check']
      });
      update.resolve(feedbackMutationResult(feedbackDocumentFixture('new-update.png')));
      expect(await pendingUpdate).toBe(true);
      load.resolve(feedbackDocumentFixture('stale-load.png'));
      await pendingLoad;
    });

    expect(probe.current.feedback).toEqual(feedbackDocumentFixture('new-update.png'));
    await probe.unmount();
  });

  it('preserves a newer draft and comment while an older pending draft saves', async () => {
    const update = deferred<WorkbenchCanvasFeedbackMutationResult>();
    const api = apiFixture({ updateCanvasFeedbackEntry: vi.fn(() => update.promise) });
    const probe = await renderController(api);

    await act(async () => {
      probe.current.handleDraft({
        projectRelativePath: 'first.png',
        kind: 'comment',
        scope: 'file',
        feedbackBarTarget: feedbackTarget('first.png')
      });
      probe.current.setPendingComment('First comment');
    });

    let pending!: Promise<boolean>;
    await act(async () => {
      pending = probe.current.savePending();
      probe.current.applyEvent(feedbackEvent(feedbackDocumentFixture('first.png')));
      probe.current.handleDraft({
        projectRelativePath: 'second.png',
        kind: 'comment',
        scope: 'file',
        feedbackBarTarget: feedbackTarget('second.png')
      });
      probe.current.setPendingComment('Second comment');
      update.resolve(feedbackMutationResult(feedbackDocumentFixture('first.png')));
      expect(await pending).toBe(true);
    });

    expect(probe.current.pendingItem?.projectRelativePath).toBe('second.png');
    expect(probe.current.pendingComment).toBe('Second comment');
    await probe.unmount();
  });

  it('clears the saved draft when repeated draft input is semantically unchanged', async () => {
    const update = deferred<WorkbenchCanvasFeedbackMutationResult>();
    const api = apiFixture({ updateCanvasFeedbackEntry: vi.fn(() => update.promise) });
    const probe = await renderController(api);
    const draft = {
      projectRelativePath: 'image.png',
      kind: 'comment' as const,
      scope: 'file' as const,
      feedbackBarTarget: feedbackTarget()
    };

    await act(async () => {
      probe.current.handleDraft(draft);
      probe.current.setPendingComment('Review this');
    });

    let pending!: Promise<boolean>;
    await act(async () => {
      pending = probe.current.savePending();
      probe.current.applyEvent(feedbackEvent(feedbackDocumentFixture('image.png')));
      probe.current.handleDraft({ ...draft, feedbackBarTarget: feedbackTarget() });
      probe.current.setPendingComment('Review this');
      update.resolve(feedbackMutationResult(feedbackDocumentFixture('image.png')));
      expect(await pending).toBe(true);
    });

    expect(probe.current.pendingItem).toBeUndefined();
    expect(probe.current.pendingComment).toBe('');
    await probe.unmount();
  });

  it('does not notify from a load invalidated by controller cleanup', async () => {
    const load = deferred<CanvasFeedbackDocument>();
    const notifyUnavailable = vi.fn();
    const api = apiFixture({ readCanvasFeedback: vi.fn(() => load.promise) });
    const probe = await renderController(api, notifyUnavailable);

    const pending = probe.current.load();
    await probe.unmount();
    load.reject(new Error('stale load failed'));
    await pending;

    expect(notifyUnavailable).not.toHaveBeenCalled();
  });

  it('persists the feedback draft, restores it without rewriting, and clears it on cancel', async () => {
    const putFeedbackWorkingCopy = vi.fn<WorkbenchApiClient['putFeedbackWorkingCopy']>(async (_projectId, value) => value);
    const clearFeedbackWorkingCopy = vi.fn<WorkbenchApiClient['clearFeedbackWorkingCopy']>(async () => undefined);
    const api = apiFixture({ putFeedbackWorkingCopy, clearFeedbackWorkingCopy });
    const probe = await renderController(api);

    await act(async () => {
      probe.current.restoreWorkingCopy({
        pendingItem: {
          projectRelativePath: 'restored.png',
          kind: 'comment',
          scope: 'file'
        },
        pendingComment: 'Restored comment',
        localMode: null
      });
    });
    expect(probe.current.pendingItem?.projectRelativePath).toBe('restored.png');
    expect(probe.current.pendingComment).toBe('Restored comment');
    expect(putFeedbackWorkingCopy).not.toHaveBeenCalled();

    await act(async () => {
      probe.current.setPendingComment('Updated comment');
      await vi.waitFor(() => expect(putFeedbackWorkingCopy).toHaveBeenLastCalledWith('project-1', {
        pendingItem: {
          projectRelativePath: 'restored.png',
          kind: 'comment',
          scope: 'file'
        },
        pendingComment: 'Updated comment',
        localMode: null
      }));
      probe.current.cancelPending();
      await vi.waitFor(() => expect(clearFeedbackWorkingCopy).toHaveBeenCalledOnce());
    });

    expect(probe.current.pendingItem).toBeUndefined();
    expect(probe.current.pendingComment).toBe('');
    await probe.unmount();
  });

  it('keeps a saved draft visible when its Working Copy cannot be cleared', async () => {
    const notifyUnavailable = vi.fn();
    const clearFeedbackWorkingCopy = vi.fn<WorkbenchApiClient['clearFeedbackWorkingCopy']>(async () => {
      throw new Error('Working Copy storage is unavailable');
    });
    const api = apiFixture({ clearFeedbackWorkingCopy });
    const probe = await renderController(api, notifyUnavailable);

    await act(async () => {
      probe.current.handleDraft({
        projectRelativePath: 'image.png',
        kind: 'comment',
        scope: 'file',
        feedbackBarTarget: feedbackTarget()
      });
      probe.current.setPendingComment('Review this');
    });
    await act(async () => {
      expect(await probe.current.savePending()).toBe(false);
    });

    expect(probe.current.pendingItem?.projectRelativePath).toBe('image.png');
    expect(probe.current.pendingComment).toBe('Review this');
    expect(notifyUnavailable).toHaveBeenCalledWith('Working Copy storage is unavailable');
    await probe.unmount();
  });
});

function ControllerProbe({
  api,
  overlayRuntime,
  notifyUnavailable,
  onValue
}: {
  api: WorkbenchApiClient;
  overlayRuntime: ReturnType<typeof createCanvasOverlayRuntime>;
  notifyUnavailable(message: string): void;
  onValue(value: CanvasFeedbackController): void;
}): null {
  const controller = useCanvasFeedbackController({
    api,
    projectId: 'project-1',
    overlayRuntime,
    notifyUnavailable
  });
  useEffect(() => onValue(controller), [controller, onValue]);
  return null;
}

async function renderController(
  api: WorkbenchApiClient,
  notifyUnavailable: (message: string) => void = vi.fn()
): Promise<{
  readonly current: CanvasFeedbackController;
  unmount(): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const overlayRuntime = createCanvasOverlayRuntime();
  let current!: CanvasFeedbackController;
  const onValue = (value: CanvasFeedbackController) => { current = value; };
  await act(async () => {
    root.render(
      <ControllerProbe
        api={api}
        overlayRuntime={overlayRuntime}
        notifyUnavailable={notifyUnavailable}
        onValue={onValue}
      />
    );
  });
  return {
    get current() { return current; },
    async unmount() {
      await act(async () => root.unmount());
      overlayRuntime.dispose();
      container.remove();
    }
  };
}

function apiFixture(overrides: Partial<WorkbenchApiClient> = {}): WorkbenchApiClient {
  return {
    readCanvasFeedback: vi.fn(async () => feedbackDocumentFixture()),
    updateCanvasFeedbackEntry: vi.fn(async () => feedbackMutationResult(feedbackDocumentFixture())),
    putFeedbackWorkingCopy: vi.fn(async (_projectId, value) => value),
    clearFeedbackWorkingCopy: vi.fn(async () => undefined),
    ...overrides
  } as unknown as WorkbenchApiClient;
}

function feedbackDocumentFixture(projectRelativePath?: string): CanvasFeedbackDocument {
  return {
    updatedAt: '2026-07-10T00:00:00.000Z',
    entries: projectRelativePath ? {
      [projectRelativePath]: {
        projectRelativePath,
        marks: ['like'],
        nextMomentLabel: 1,
        nextSpatialLabel: 1,
        items: [],
        updatedAt: '2026-07-10T00:00:00.000Z'
      }
    } : {}
  };
}

function feedbackTarget(projectRelativePath = 'image.png') {
  return {
    projectRelativePath,
    nodeRect: { x: 10, y: 20, width: 300, height: 180 },
    surfaceRect: { x: 0, y: 0, width: 1280, height: 720 },
    camera: { x: 12, y: 24, z: 1 },
    localToolset: 'image' as const,
    canStartVideoMomentFeedback: false,
    entry: undefined
  };
}

function feedbackEvent(feedback: CanvasFeedbackDocument): WorkbenchEvent {
  return {
    type: 'canvas.feedback.changed',
    projectId: 'project-1',
    projectRevision: 2,
    feedback
  };
}

function feedbackMutationResult(feedback: CanvasFeedbackDocument): WorkbenchCanvasFeedbackMutationResult {
  return {
    projectId: 'project-1',
    projectRevision: 2,
    feedback
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
