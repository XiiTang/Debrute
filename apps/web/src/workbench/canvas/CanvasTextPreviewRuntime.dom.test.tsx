import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import type {
  CanvasTextPreviewRasterResult,
  CanvasTextPreviewTarget
} from './CanvasTextPreviewCapture';
import { CanvasTextPreviewFailure } from './CanvasTextPreviewFailure';
import type { CanvasTextPreviewPresentation } from './CanvasTextPreviewImageHandoff';
import {
  createCanvasPreviewResourceScheduler,
  type CanvasPreviewResourceRequest,
  type CanvasPreviewResourceScheduler
} from './CanvasPreviewResourceScheduler';
import {
  CanvasTextPreviewProvider,
  canvasTextPreviewNextCaptureTarget,
  canvasTextPreviewTargetsForNodes,
  useCanvasTextPreviewRuntime,
  type CanvasTextPreviewMeasuredBody,
  type CanvasTextPreviewRuntimeValue,
  type CanvasTextPreviewSource
} from './CanvasTextPreviewRuntime';

const laneMock = vi.hoisted(() => ({
  renderedTargets: [] as Array<string | undefined>,
  props: undefined as {
    target: CanvasTextPreviewTarget | undefined;
    interactionActive: boolean;
    onRasterized(target: CanvasTextPreviewTarget, result: CanvasTextPreviewRasterResult): void;
    onFailure(target: CanvasTextPreviewTarget, failure: Error): void;
  } | undefined
}));

vi.mock('./CanvasTextPreviewCaptureLane', async () => {
  const ReactModule = await import('react');
  return {
    CanvasTextPreviewCaptureLane: (props: NonNullable<typeof laneMock.props>) => {
      laneMock.props = props;
      laneMock.renderedTargets.push(props.target?.projectRelativePath);
      return ReactModule.createElement('div', { 'data-capture-target': props.target?.projectRelativePath });
    }
  };
});

vi.mock('./CanvasTextPreviewStyleKey', () => ({
  canvasTextPreviewStyleSnapshotForDocument: () => ({ color: '#fff' }),
  canvasTextPreviewStyleKey: async () => 'sha256:style'
}));

let previewResourceScheduler: CanvasPreviewResourceScheduler;

describe('CanvasTextPreviewRuntime', { tags: ['canvas-text'] }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: ReturnType<typeof installAnimationFrameQueue>;

  beforeEach(() => {
    vi.clearAllMocks();
    laneMock.props = undefined;
    laneMock.renderedTargets = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    frames = installAnimationFrameQueue();
    previewResourceScheduler = createCanvasPreviewResourceScheduler();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    previewResourceScheduler.dispose();
    container.remove();
    frames.restore();
    vi.unstubAllGlobals();
  });

  it('selects one missing source target and skips uploading or failed keys', () => {
    const targets = [targetFixture('a.md'), targetFixture('b.md'), targetFixture('c.md')];
    expect(canvasTextPreviewNextCaptureTarget({
      targets,
      sourceAvailability: {
        'a.md': { fingerprint: targets[0]!.fingerprint, available: false },
        'b.md': { fingerprint: targets[1]!.fingerprint, available: false },
        'c.md': { fingerprint: targets[2]!.fingerprint, available: false }
      },
      uploadingTargetKeys: new Set([targetKey(targets[0]!)]),
      failedTargetKeys: new Set([targetKey(targets[1]!)])
    })).toEqual(targets[2]);
  });

  it('starts a later capture only after the earlier raster completes while its upload remains unresolved', async () => {
    const firstUpload = deferred<Awaited<ReturnType<WorkbenchActions['saveCanvasTextPreviewSource']>>>();
    const secondUpload = deferred<Awaited<ReturnType<WorkbenchActions['saveCanvasTextPreviewSource']>>>();
    const save = vi.fn<WorkbenchActions['saveCanvasTextPreviewSource']>((input) => (
      input.projectRelativePath === 'a.md' ? firstUpload.promise : secondUpload.promise
    ));
    const actions = actionsFixture({ available: false, save });

    await renderProvider({
      root,
      nodes: [nodeFixture('a.md', 0), nodeFixture('b.md', 100)],
      actions,
      cameraState: 'idle'
    });
    await waitFor(() => laneMock.props?.target?.projectRelativePath === 'a.md');
    const first = laneMock.props!.target!;

    expect(laneMock.props?.target?.projectRelativePath).toBe('a.md');
    expect(save).not.toHaveBeenCalled();
    await act(async () => laneMock.props?.onRasterized(first, rasterResult()));

    await waitFor(() => laneMock.props?.target?.projectRelativePath === 'b.md');
    expect(save).toHaveBeenCalledTimes(1);
    laneMock.renderedTargets = [];
    expect(laneMock.renderedTargets).not.toContain(undefined);
    const second = laneMock.props!.target!;
    await act(async () => laneMock.props?.onRasterized(second, rasterResult()));
    expect(save).toHaveBeenCalledTimes(2);
    expect(firstUpload.settled()).toBe(false);
    expect(secondUpload.settled()).toBe(false);
  });

  it('keeps a culled text node in the current target identity set', async () => {
    const node = nodeFixture('a.md', 0);
    const targets = canvasTextPreviewTargetsForNodes({
      canvasId: 'canvas-1',
      nodes: [node],
      textFileBuffers: { 'a.md': bufferFixture('a.md', 'active') },
      measuredBodies: new Map([['a.md', { width: 320, height: 160 }]]),
      styleKey: 'sha256:style'
    });

    expect(targets.map((target) => target.projectRelativePath)).toEqual(['a.md']);
  });

  it('does not start preview work for a missing culled target until it becomes eligible', async () => {
    const read = vi.fn<WorkbenchActions['readCanvasTextPreviewSources']>(async (request) => ({
      sources: Object.fromEntries(request.sources.map((source) => [
        source.projectRelativePath,
        { ...source, status: 'missing' as const }
      ]))
    }));
    const actions = actionsFixture({ available: false, read });
    const node = nodeFixture('a.md', 0);

    await renderProvider({
      root,
      nodes: [node],
      actions,
      cameraState: 'idle',
      culledNodePaths: new Set(['a.md'])
    });
    await flushWork();

    expect(read).not.toHaveBeenCalled();
    expect(laneMock.props?.target).toBeUndefined();

    await renderProvider({
      root,
      nodes: [node],
      actions,
      cameraState: 'idle'
    });
    await runFramesUntil(frames, () => laneMock.props?.target !== undefined);

    expect(read).toHaveBeenCalledTimes(1);
    expect(laneMock.props?.target?.projectRelativePath).toBe('a.md');
  });

  it('keeps an item-local availability error from blocking another target in the batch', async () => {
    const recordCounter = vi.fn();
    const read = vi.fn<WorkbenchActions['readCanvasTextPreviewSources']>(async (request) => ({
      sources: Object.fromEntries(request.sources.map((source) => [
        source.projectRelativePath,
        source.projectRelativePath === 'broken.md'
          ? {
              ...source,
              status: 'error' as const,
              message: 'Canvas text preview source metadata read failed.'
            }
          : { ...source, status: 'missing' as const }
      ]))
    }));
    const brokenNode = nodeFixture('broken.md', 0);
    const normalNode = nodeFixture('notes/scene.md', 100);

    await renderProvider({
      root,
      nodes: [brokenNode, normalNode],
      actions: actionsFixture({ available: false, read }),
      cameraState: 'idle',
      perfMonitor: { recordCounter }
    });
    await waitFor(() => laneMock.props?.target?.projectRelativePath === 'notes/scene.md');

    expect(read).toHaveBeenCalledTimes(1);
    expect(recordCounter).toHaveBeenCalledWith(expect.objectContaining({
      name: 'text-preview-failed',
      detail: expect.objectContaining({
        projectRelativePath: 'broken.md',
        stage: 'source_availability_failed'
      })
    }));
  });

  it('retains the exact committed presentation while the active editor owns the node', async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(['png']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const observed: CanvasTextPreviewPresentation[] = [];
    let runtimeValue: CanvasTextPreviewRuntimeValue | undefined;
    const node = nodeFixture('a.md', 0);
    const probe = (runtime: CanvasTextPreviewRuntimeValue) => {
      runtimeValue = runtime;
      observed.push(runtime.presentationForNode({ node }));
    };

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      probe
    });
    await runFramesUntil(frames, () => latest(observed)?.pending !== undefined);
    const pending = latest(observed)?.pending;
    await act(async () => runtimeValue?.reportPendingReady(node, pending!));
    await runFramesUntil(frames, () => latest(observed)?.visible !== undefined);
    const visible = latest(observed)?.visible;
    await act(async () => runtimeValue?.reportVisibleCommitted(node, visible!));
    await runFramesUntil(frames, () => latest(observed)?.visibleCommittedSourceKey === visible?.sourceKey);

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      activeInlineTextPath: 'a.md',
      probe
    });
    await flushWork();

    expect(latest(observed)?.visible?.sourceKey).toBe(visible?.sourceKey);
    expect(latest(observed)?.visibleCommittedSourceKey).toBe(visible?.sourceKey);
    expect(laneMock.props?.target).toBeUndefined();

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      probe
    });
    await flushWork();

    expect(latest(observed)?.visible?.sourceKey).toBe(visible?.sourceKey);
    expect(latest(observed)?.pending).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      activeInlineTextPath: 'a.md',
      content: 'edited content',
      probe
    });
    await flushWork();

    expect(latest(observed)).toEqual({});
  });

  it('does not request preview availability for active intermediate content', async () => {
    const read = vi.fn<WorkbenchActions['readCanvasTextPreviewSources']>(async (request) => ({
      sources: Object.fromEntries(request.sources.map((source) => [
        source.projectRelativePath,
        { ...source, status: 'missing' as const }
      ]))
    }));
    const actions = actionsFixture({ available: false, read });
    const node = nodeFixture('a.md', 0);

    await renderProvider({
      root,
      nodes: [node],
      actions,
      cameraState: 'idle',
      activeInlineTextPath: 'a.md',
      content: 'first edit'
    });
    await flushWork();
    await renderProvider({
      root,
      nodes: [node],
      actions,
      cameraState: 'idle',
      activeInlineTextPath: 'a.md',
      content: 'second edit'
    });
    await flushWork();

    expect(read).not.toHaveBeenCalled();
    expect(laneMock.props?.target).toBeUndefined();
  });

  it('retains the exact committed presentation when the node becomes culled', async () => {
    const observed: CanvasTextPreviewPresentation[] = [];
    let runtimeValue: CanvasTextPreviewRuntimeValue | undefined;
    const node = nodeFixture('a.md', 0);
    const probe = (runtime: CanvasTextPreviewRuntimeValue) => {
      runtimeValue = runtime;
      observed.push(runtime.presentationForNode({ node }));
    };

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      probe
    });
    await runFramesUntil(frames, () => latest(observed)?.pending !== undefined);
    const pending = latest(observed)?.pending;
    await act(async () => runtimeValue?.reportPendingReady(node, pending!));
    await runFramesUntil(frames, () => latest(observed)?.visible !== undefined);
    const visible = latest(observed)?.visible;
    await act(async () => runtimeValue?.reportVisibleCommitted(node, visible!));
    await runFramesUntil(frames, () => latest(observed)?.visibleCommittedSourceKey === visible?.sourceKey);

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      culledNodePaths: new Set(['a.md']),
      probe
    });
    await flushWork();

    expect(latest(observed)?.visible?.sourceKey).toBe(visible?.sourceKey);
    expect(latest(observed)?.visibleCommittedSourceKey).toBe(visible?.sourceKey);
  });

  it('ignores a hidden body 0x0 measurement and reuses the committed preview after culling', async () => {
    const read = vi.fn<WorkbenchActions['readCanvasTextPreviewSources']>(async (request) => ({
      sources: Object.fromEntries(request.sources.map((source) => [
        source.projectRelativePath,
        { ...source, status: 'available' as const }
      ]))
    }));
    const actions = actionsFixture({ available: true, read });
    const observed: CanvasTextPreviewPresentation[] = [];
    let runtimeValue: CanvasTextPreviewRuntimeValue | undefined;
    const node = nodeFixture('a.md', 0);
    const probe = (runtime: CanvasTextPreviewRuntimeValue) => {
      runtimeValue = runtime;
      observed.push(runtime.presentationForNode({ node }));
    };

    await renderProvider({
      root,
      nodes: [node],
      actions,
      cameraState: 'idle',
      probe
    });
    await runFramesUntil(frames, () => latest(observed)?.pending !== undefined);
    const pending = latest(observed)?.pending;
    await act(async () => runtimeValue?.reportPendingReady(node, pending!));
    await runFramesUntil(frames, () => latest(observed)?.visible !== undefined);
    const visible = latest(observed)?.visible;
    await act(async () => runtimeValue?.reportVisibleCommitted(node, visible!));
    await runFramesUntil(frames, () => latest(observed)?.visibleCommittedSourceKey === visible?.sourceKey);
    const readCount = read.mock.calls.length;

    await renderProvider({
      root,
      nodes: [node],
      actions,
      cameraState: 'idle',
      culledNodePaths: new Set(['a.md']),
      bodyMeasurements: { 'a.md': { width: 0, height: 0 } },
      probe
    });
    await flushWork();

    expect(latest(observed)?.visible?.sourceKey).toBe(visible?.sourceKey);
    expect(latest(observed)?.visibleCommittedSourceKey).toBe(visible?.sourceKey);

    await renderProvider({
      root,
      nodes: [node],
      actions,
      cameraState: 'idle',
      bodyMeasurements: { 'a.md': { width: 320, height: 160 } },
      probe
    });
    await flushWork();

    expect(latest(observed)?.visible?.sourceKey).toBe(visible?.sourceKey);
    expect(latest(observed)?.visibleCommittedSourceKey).toBe(visible?.sourceKey);
    expect(read).toHaveBeenCalledTimes(readCount);
  });

  it('does not enter the capture lane while interaction is active', async () => {
    await renderProvider({
      root,
      nodes: [nodeFixture('a.md', 0)],
      actions: actionsFixture({ available: false }),
      cameraState: 'moving'
    });
    await flushWork();

    expect(laneMock.props?.interactionActive).toBe(true);
    expect(laneMock.props?.target).toBeUndefined();
  });

  it('continues to the next current target after one capture failure', async () => {
    await renderProvider({
      root,
      nodes: [nodeFixture('a.md', 0), nodeFixture('b.md', 100)],
      actions: actionsFixture({ available: false }),
      cameraState: 'idle'
    });
    await waitFor(() => laneMock.props?.target?.projectRelativePath === 'a.md');
    const first = laneMock.props!.target!;
    await act(async () => laneMock.props?.onFailure(first, new CanvasTextPreviewFailure(
      'snapshot_not_ready',
      {
        canvasId: first.canvasId,
        projectRelativePath: first.projectRelativePath,
        fingerprint: first.fingerprint
      },
      'Canvas text preview snapshot is not ready.'
    )));

    await waitFor(() => laneMock.props?.target?.projectRelativePath === 'b.md');
  });

  it('queues a text variant during interaction and mounts it on the next idle frame', async () => {
    const observed: CanvasTextPreviewPresentation[] = [];
    const node = nodeFixture('a.md', 0);

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: true }),
      cameraState: 'moving',
      probe: (runtime) => observed.push(runtime.presentationForNode({ node }))
    });
    await flushWork();
    expect(latest(observed)).toEqual({ visible: undefined, pending: undefined });

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      probe: (runtime) => observed.push(runtime.presentationForNode({ node }))
    });
    await waitFor(() => frames.pending() > 0);
    await runFramesUntil(frames, () => latest(observed)?.pending !== undefined);

    expect(latest(observed)?.pending).toMatchObject({
      projectRelativePath: 'a.md',
      fingerprint: expect.stringMatching(/^sha256:/)
    });
  });

  it('mounts one pending image without prefetching its resource URL', async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(['png']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const observed: CanvasTextPreviewPresentation[] = [];
    let runtimeValue: CanvasTextPreviewRuntimeValue | undefined;
    const node = nodeFixture('a.md', 0);

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      probe: (runtime) => {
        runtimeValue = runtime;
        observed.push(runtime.presentationForNode({ node }));
      }
    });
    await waitFor(() => frames.pending() > 0);
    await runFramesUntil(frames, () => latest(observed)?.pending !== undefined);

    const pending = latest(observed)?.pending;
    expect(pending).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(latest(observed)?.visible).toBeUndefined();
    await act(async () => runtimeValue?.reportPendingReady(node, pending!));
    expect(latest(observed)?.visible).toBeUndefined();
    await runFramesUntil(frames, () => latest(observed)?.visible?.sourceKey === pending?.sourceKey);

    expect(latest(observed)).toEqual({ visible: pending, pending: undefined });
    expect(latest(observed)?.visibleCommittedSourceKey).toBeUndefined();
  });

  it('mounts pending text previews through the shared resource start scheduler', async () => {
    const starts: CanvasPreviewResourceRequest[] = [];
    const controlledScheduler: CanvasPreviewResourceScheduler = {
      enqueue: (request) => starts.push(request),
      enqueuePublication: () => undefined,
      cancel: () => undefined,
      setInteractionState: () => undefined,
      notifyVisibilityChanged: () => undefined,
      dispose: () => undefined
    };
    const observed: CanvasTextPreviewPresentation[] = [];
    const node = nodeFixture('a.md', 0);

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      previewResourceScheduler: controlledScheduler,
      probe: (runtime) => observed.push(runtime.presentationForNode({ node }))
    });
    await waitFor(() => starts.length > 0);

    expect(latest(observed)?.pending).toBeUndefined();
    expect(starts[0]?.kind).toBe('text');
    expect(starts[0]?.isCurrent()).toBe(true);
    expect(starts[0]?.isCulled()).toBe(false);

    await act(async () => starts.shift()?.run());

    expect(latest(observed)?.pending).toBeDefined();
  });

  it('publishes at most three ready text previews in one shared scheduler frame', async () => {
    const nodes = [
      nodeFixture('a.md', 0),
      nodeFixture('b.md', 100),
      nodeFixture('c.md', 200),
      nodeFixture('d.md', 300)
    ];
    const observed: Array<Record<string, CanvasTextPreviewPresentation>> = [];
    let runtimeValue: CanvasTextPreviewRuntimeValue | undefined;

    await renderProvider({
      root,
      nodes,
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      probe: (runtime) => {
        runtimeValue = runtime;
        observed.push(Object.fromEntries(nodes.map((node) => [
          node.projectRelativePath,
          runtime.presentationForNode({ node })
        ])));
      }
    });
    await runFramesUntil(frames, () => presentationCount(latest(observed), 'pending') === nodes.length);

    const pending = latest(observed)!;
    await act(async () => {
      for (const node of nodes) {
        runtimeValue?.reportPendingReady(node, pending[node.projectRelativePath]!.pending!);
      }
    });
    await runFramesUntil(frames, () => presentationCount(latest(observed), 'visible') > 0);

    expect(presentationCount(latest(observed), 'visible')).toBe(3);
    expect(presentationCount(latest(observed), 'pending')).toBe(1);

    await runFramesUntil(frames, () => presentationCount(latest(observed), 'visible') === nodes.length);
    const visible = latest(observed)!;

    await act(async () => {
      for (const node of nodes) {
        runtimeValue?.reportVisibleCommitted(node, visible[node.projectRelativePath]!.visible!);
      }
    });
    await runFramesUntil(frames, () => committedPresentationCount(latest(observed)) > 0);

    expect(committedPresentationCount(latest(observed))).toBe(3);
    await runFramesUntil(frames, () => committedPresentationCount(latest(observed)) === nodes.length);
  });

  it('does not add a follow-up commit for every text preview publication batch', async () => {
    const nodes = Array.from({ length: 30 }, (_, index) => nodeFixture(`node-${index}.md`, index * 100));
    const starts: CanvasPreviewResourceRequest[] = [];
    const controlledScheduler: CanvasPreviewResourceScheduler = {
      enqueue: (request) => starts.push(request),
      enqueuePublication: () => undefined,
      cancel: () => undefined,
      setInteractionState: () => undefined,
      notifyVisibilityChanged: () => undefined,
      dispose: () => undefined
    };
    let commitCount = 0;
    let pendingCount = 0;

    await renderProvider({
      root,
      nodes,
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      previewResourceScheduler: controlledScheduler,
      onCommit: () => {
        commitCount += 1;
      },
      probe: (runtime) => {
        pendingCount = nodes.filter((node) => runtime.presentationForNode({ node }).pending !== undefined).length;
      }
    });
    await waitFor(() => starts.length === nodes.length);
    const commitCountBeforeStarts = commitCount;
    for (let batch = 0; batch < 20 && pendingCount !== nodes.length; batch += 1) {
      await act(async () => {
        for (const start of starts.splice(0, 3)) {
          start.run();
        }
      });
    }

    expect(pendingCount).toBe(nodes.length);
    expect(commitCount - commitCountBeforeStarts).toBeLessThanOrEqual(12);
  });

  it('records publication only after the visible DOM commit callback', async () => {
    const recordCounter = vi.fn();
    const observed: CanvasTextPreviewPresentation[] = [];
    let runtimeValue: CanvasTextPreviewRuntimeValue | undefined;
    const node = nodeFixture('a.md', 0);

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      perfMonitor: { recordCounter },
      probe: (runtime) => {
        runtimeValue = runtime;
        observed.push(runtime.presentationForNode({ node }));
      }
    });
    await runFramesUntil(frames, () => latest(observed)?.pending !== undefined);
    const pending = latest(observed)?.pending;
    await act(async () => runtimeValue?.reportPendingReady(node, pending!));
    expect(recordCounter.mock.calls.some(([event]) => event.name === 'text-preview-pending-ready')).toBe(true);
    await runFramesUntil(frames, () => latest(observed)?.visible !== undefined);

    expect(recordCounter.mock.calls.some(([event]) => event.name === 'text-preview-published')).toBe(false);
    expect(latest(observed)?.visibleCommittedSourceKey).toBeUndefined();
    await act(async () => runtimeValue?.reportVisibleCommitted(node, pending!));
    expect(recordCounter.mock.calls.some(([event]) => event.name === 'text-preview-published')).toBe(false);
    expect(latest(observed)?.visibleCommittedSourceKey).toBeUndefined();
    await runFramesUntil(frames, () => latest(observed)?.visibleCommittedSourceKey === pending?.sourceKey);
    expect(recordCounter.mock.calls.some(([event]) => event.name === 'text-preview-published')).toBe(true);
    expect(latest(observed)?.visibleCommittedSourceKey).toBe(pending?.sourceKey);
  });

  it('defers a ready visible commit that arrives after interaction starts', async () => {
    const recordCounter = vi.fn();
    const observed: CanvasTextPreviewPresentation[] = [];
    let runtimeValue: CanvasTextPreviewRuntimeValue | undefined;
    const node = nodeFixture('a.md', 0);
    const nodes = [node];
    const actions = actionsFixture({ available: true });
    const probe = (runtime: CanvasTextPreviewRuntimeValue) => {
      runtimeValue = runtime;
      observed.push(runtime.presentationForNode({ node }));
    };

    await renderProvider({
      root,
      nodes,
      actions,
      cameraState: 'idle',
      perfMonitor: { recordCounter },
      probe
    });
    await runFramesUntil(frames, () => latest(observed)?.pending !== undefined);
    const pending = latest(observed)?.pending;
    await act(async () => runtimeValue?.reportPendingReady(node, pending!));
    await runFramesUntil(frames, () => latest(observed)?.visible?.sourceKey === pending?.sourceKey);

    await renderProvider({
      root,
      nodes,
      actions,
      cameraState: 'moving',
      perfMonitor: { recordCounter },
      probe
    });
    await waitFor(() => laneMock.props?.interactionActive === true);
    await act(async () => runtimeValue?.reportVisibleCommitted(node, pending!));

    expect(latest(observed)?.visibleCommittedSourceKey).toBeUndefined();
    expect(recordCounter.mock.calls.some(([event]) => event.name === 'text-preview-published')).toBe(false);

    await renderProvider({
      root,
      nodes,
      actions,
      cameraState: 'idle',
      perfMonitor: { recordCounter },
      probe
    });
    await runFramesUntil(frames, () => latest(observed)?.visibleCommittedSourceKey === pending?.sourceKey);

    expect(recordCounter.mock.calls.filter(([event]) => event.name === 'text-preview-published')).toHaveLength(1);
  });

  it('invalidates an older fingerprint instead of keeping it visible', async () => {
    const observed: CanvasTextPreviewPresentation[] = [];
    let runtimeValue: CanvasTextPreviewRuntimeValue | undefined;
    const node = nodeFixture('a.md', 0);
    const probe = (runtime: CanvasTextPreviewRuntimeValue) => {
      runtimeValue = runtime;
      observed.push(runtime.presentationForNode({ node }));
    };

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: true }),
      cameraState: 'idle',
      probe,
      content: 'first'
    });
    await waitFor(() => frames.pending() > 0);
    await runFramesUntil(frames, () => latest(observed)?.pending !== undefined);
    const pending = latest(observed)?.pending;
    await act(async () => runtimeValue?.reportPendingReady(node, pending!));
    await runFramesUntil(frames, () => latest(observed)?.visible !== undefined);
    expect(latest(observed)?.visible).toBeDefined();

    await renderProvider({
      root,
      nodes: [node],
      actions: actionsFixture({ available: false }),
      cameraState: 'idle',
      probe,
      content: 'second'
    });
    await waitFor(() => latest(observed)?.visible === undefined && latest(observed)?.pending === undefined);
    expect(latest(observed)).toEqual({ visible: undefined, pending: undefined });
  });

});

async function renderProvider(input: {
  root: Root;
  nodes: ProjectedCanvasNode[];
  actions: WorkbenchActions;
  cameraState: 'idle' | 'moving';
  probe?: ((runtime: CanvasTextPreviewRuntimeValue) => void) | undefined;
  content?: string | undefined;
  activeInlineTextPath?: string | undefined;
  culledNodePaths?: ReadonlySet<string> | undefined;
  bodyMeasurements?: Record<string, CanvasTextPreviewMeasuredBody> | undefined;
  perfMonitor?: { recordCounter(event: Parameters<NonNullable<React.ComponentProps<typeof CanvasTextPreviewProvider>['perfMonitor']>['recordCounter']>[0]): void } | undefined;
  previewResourceScheduler?: CanvasPreviewResourceScheduler | undefined;
  onCommit?: (() => void) | undefined;
}): Promise<void> {
  const buffers = Object.fromEntries(input.nodes.map((node) => [
    node.projectRelativePath,
    bufferFixture(node.projectRelativePath, input.content ?? node.projectRelativePath)
  ]));
  await act(async () => {
    const scheduler = input.previewResourceScheduler ?? previewResourceScheduler;
    scheduler.setInteractionState({
      cameraState: input.cameraState,
      dragActive: false
    });
    const provider = (
      <CanvasTextPreviewProvider
        canvasId="canvas-1"
        nodes={input.nodes}
        activeInlineTextPath={input.activeInlineTextPath}
        textFileBuffers={buffers}
        actions={input.actions}
        cameraState={input.cameraState}
        dragState={undefined}
        resourceZoom={0.1}
        devicePixelRatio={2}
        culledNodePaths={input.culledNodePaths ?? new Set()}
        styleDependencyKey="dark"
        perfMonitor={input.perfMonitor}
        previewResourceScheduler={scheduler}
      >
        {input.nodes.map((node) => (
          <RegisteredBody
            key={node.projectRelativePath}
            path={node.projectRelativePath}
            measurement={input.bodyMeasurements?.[node.projectRelativePath]}
          />
        ))}
        {input.probe ? <RuntimeProbe onRuntime={input.probe} /> : null}
      </CanvasTextPreviewProvider>
    );
    input.root.render(input.onCommit
      ? <React.Profiler id="canvas-text-preview-runtime" onRender={input.onCommit}>{provider}</React.Profiler>
      : provider);
  });
}

function RegisteredBody({
  path,
  measurement = { width: 320, height: 160 }
}: {
  path: string;
  measurement?: CanvasTextPreviewMeasuredBody | undefined;
}): React.ReactElement {
  const { registerTextBody } = useCanvasTextPreviewRuntime();
  React.useEffect(() => {
    const body = document.createElement('div');
    Object.defineProperties(body, {
      clientWidth: { configurable: true, value: measurement.width },
      clientHeight: { configurable: true, value: measurement.height }
    });
    registerTextBody(path, body);
    return () => registerTextBody(path, null);
  }, [measurement.height, measurement.width, path, registerTextBody]);
  return <div />;
}

function RuntimeProbe({ onRuntime }: { onRuntime(runtime: CanvasTextPreviewRuntimeValue): void }): React.ReactElement {
  const runtime = useCanvasTextPreviewRuntime();
  React.useEffect(() => {
    onRuntime(runtime);
  });
  return <div />;
}

function nodeFixture(projectRelativePath: string, y: number): ProjectedCanvasNode {
  return {
    projectRelativePath,
    nodeKind: 'file',
    mediaKind: 'text',
    x: 0,
    y,
    width: 3200,
    height: 1600,
    z: 0,
    availability: {
      state: 'available',
      size: 32,
      mimeType: 'text/markdown',
      fileUrl: `http://127.0.0.1:17321/api/projects/p/files/raw/${projectRelativePath}`,
      revision: 'rev-a'
    }
  };
}

function bufferFixture(projectRelativePath: string, content: string): TextFileBuffer {
  return {
    projectRelativePath,
    content,
    language: 'markdown',
    wordWrap: true,
    dirty: false,
    saving: false,
    baseRevision: 'rev-a',
    externalChange: false
  };
}

function targetFixture(projectRelativePath: string): CanvasTextPreviewTarget {
  return {
    canvasId: 'canvas-1',
    projectRelativePath,
    content: projectRelativePath,
    language: 'markdown',
    wordWrap: true,
    contentCssWidth: 320,
    contentCssHeight: 160,
    scrollTop: 0,
    scrollLeft: 0,
    styleKey: 'sha256:style',
    fingerprint: `sha256:${projectRelativePath}`
  };
}

function targetKey(target: CanvasTextPreviewTarget): string {
  return `${target.canvasId}\u001f${target.projectRelativePath}\u001f${target.fingerprint}`;
}

function rasterResult(): CanvasTextPreviewRasterResult {
  return {
    sourcePng: new Blob(['png'], { type: 'image/png' }),
    snapshotWidth: 320,
    snapshotHeight: 160,
    snapshotBytes: 256,
    rasterDurationMs: 2
  };
}

function actionsFixture(input: {
  available: boolean;
  read?: WorkbenchActions['readCanvasTextPreviewSources'] | undefined;
  save?: WorkbenchActions['saveCanvasTextPreviewSource'] | undefined;
}): WorkbenchActions {
  return {
    readCanvasTextPreviewSources: input.read ?? (async (
      request: Parameters<WorkbenchActions['readCanvasTextPreviewSources']>[0]
    ) => ({
      sources: Object.fromEntries(request.sources.map((source) => [
        source.projectRelativePath,
        { ...source, status: input.available ? 'available' as const : 'missing' as const }
      ]))
    })),
    saveCanvasTextPreviewSource: input.save ?? (async (request) => saveResult(request))
  } as unknown as WorkbenchActions;
}

function saveResult(input: Parameters<WorkbenchActions['saveCanvasTextPreviewSource']>[0]) {
  return {
    ok: true as const,
    source: {
      projectRelativePath: input.projectRelativePath,
      fingerprint: input.fingerprint,
      status: 'available' as const
    }
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  let isSettled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value: T) {
      isSettled = true;
      resolvePromise(value);
    },
    reject(error: unknown) {
      isSettled = true;
      rejectPromise(error);
    },
    settled: () => isSettled
  };
}

function installAnimationFrameQueue() {
  const previousRequest = window.requestAnimationFrame;
  const previousCancel = window.cancelAnimationFrame;
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  window.requestAnimationFrame = (callback) => {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  };
  window.cancelAnimationFrame = (handle) => callbacks.delete(handle);
  return {
    pending: () => callbacks.size,
    async runNext() {
      const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!entry) {
        throw new Error('Expected an animation frame.');
      }
      callbacks.delete(entry[0]);
      await act(async () => {
        entry[1](performance.now());
        await Promise.resolve();
      });
    },
    restore() {
      window.requestAnimationFrame = previousRequest;
      window.cancelAnimationFrame = previousCancel;
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await flushWork();
  }
  throw new Error('Timed out waiting for Runtime state.');
}

async function flushWork(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function runFramesUntil(
  frames: ReturnType<typeof installAnimationFrameQueue>,
  predicate: () => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
    await waitFor(() => frames.pending() > 0);
    await frames.runNext();
  }
  if (!predicate()) {
    throw new Error('Timed out waiting for animation-frame publication.');
  }
}

function latest<T>(items: T[]): T | undefined {
  return items.at(-1);
}

function presentationCount(
  presentations: Record<string, CanvasTextPreviewPresentation> | undefined,
  layer: 'visible' | 'pending'
): number {
  return Object.values(presentations ?? {}).filter((presentation) => presentation[layer] !== undefined).length;
}

function committedPresentationCount(
  presentations: Record<string, CanvasTextPreviewPresentation> | undefined
): number {
  return Object.values(presentations ?? {}).filter((presentation) => (
    presentation.visibleCommittedSourceKey !== undefined
  )).length;
}
