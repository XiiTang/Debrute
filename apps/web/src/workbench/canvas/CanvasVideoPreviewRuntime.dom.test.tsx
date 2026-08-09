import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasVideoPreviewProbeRequest } from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from './CanvasScene.js';
import type { WorkbenchActions } from '../../types.js';
import type {
  CanvasPreviewResourceRequest,
  CanvasPreviewResourceScheduler
} from './CanvasPreviewResourceScheduler.js';
import type { CanvasPreviewOrderSource } from './CanvasRenderLifecycle.js';
import {
  CanvasVideoPreviewProvider,
  canvasVideoPreviewTargetsForNodes,
  useCanvasVideoPreviewNode,
  useCanvasVideoPreviewRuntime,
  type CanvasVideoPreviewRuntimeValue
} from './CanvasVideoPreviewRuntime.js';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const sourceNodeReader = { getNode: () => undefined };

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = undefined;
  container?.remove();
  container = undefined;
});

describe('CanvasVideoPreviewRuntime', { tags: ['canvas-video'] }, () => {
  it('requires CanvasVideoPreviewProvider', () => {
    expect(() => renderToStaticMarkup(<VideoRuntimeConsumer />)).toThrow('CanvasVideoPreviewProvider is required.');
  });

  it('targets available videos with integer millisecond frame identity', () => {
    expect(canvasVideoPreviewTargetsForNodes([
        videoNode('media/a.mp4', 'rev-a', 4_250),
        videoNode('media/b.mp4', 'rev-b'),
        { ...videoNode('media/c.mp4', 'rev-c'), availability: { state: 'missing', message: 'missing' } }
      ])).toEqual([{
      bindingId: 'p',
      projectRelativePath: 'media/a.mp4',
      sourceRevision: 'rev-a',
      frameTimeMs: 4_250
    }, {
      bindingId: 'p',
      projectRelativePath: 'media/b.mp4',
      sourceRevision: 'rev-b',
      frameTimeMs: 0
    }]);
  });

  it('rejects a video target whose raw-file URL is outside the Runtime contract', () => {
    expect(() => canvasVideoPreviewTargetsForNodes([videoNode(
        'media/a.mp4',
        'rev-a',
        0,
        'http://127.0.0.1:17321/api/workbench/bindings/p/files/raw/media/a.mp4?v=rev-a'
      )])).toThrow('Canvas file URL must be a relative Runtime raw-file URL.');
  });

  it('keeps pending Probe work paused during interaction and resumes it afterward', async () => {
    const node = videoNode('media/a.mp4', 'rev-a');
    const probe = vi.fn(async (input: CanvasVideoPreviewProbeRequest) => readyProbeResponse(input));
    const scheduler = createImmediateScheduler();
    await renderVideoPreviewProvider({
      nodes: [node],
      actions: actionsWith({ probeCanvasVideoPreviewSources: probe }),
      interactionActive: true,
      previewResourceScheduler: scheduler,
      children: <PreviewProbe node={node} />
    });

    await flushEffects();
    expect(probe).not.toHaveBeenCalled();

    await act(async () => scheduler.setInteractionState({
      cameraState: 'idle',
      pointerInteractionActive: false
    }));
    await flushEffects();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('dispatches only the latest target when identity changes as interaction ends', async () => {
    const probe = vi.fn<WorkbenchActions['probeCanvasVideoPreviewSources']>(async (input) => (
      readyProbeResponse(input)
    ));
    const scheduler = createImmediateScheduler();
    const rendered = await renderVideoPreviewProvider({
      nodes: [videoNode('media/a.mp4', 'rev-a')],
      actions: actionsWith({ probeCanvasVideoPreviewSources: probe }),
      interactionActive: true,
      previewResourceScheduler: scheduler,
      children: <PreviewProbe node={videoNode('media/a.mp4', 'rev-a')} />
    });

    await rendered.rerender([videoNode('media/a.mp4', 'rev-a2')], false);
    await flushEffects();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0].targets).toEqual([{
      projectRelativePath: 'media/a.mp4',
      sourceRevision: 'rev-a2',
      frameTimeMs: 0
    }]);
  });

  it('publishes a Probe-ready canonical source without an Ensure call', async () => {
    const node = videoNode('media/a.mp4', 'rev-a');
    const ensure = vi.fn<WorkbenchActions['ensureCanvasVideoPreviewSource']>();
    await renderVideoPreviewProvider({
      nodes: [node],
      actions: actionsWith({ ensureCanvasVideoPreviewSource: ensure }),
      children: <PreviewProbe node={node} />
    });

    await flushEffects();

    expect(ensure).not.toHaveBeenCalled();
    expect(previewSrc()).toBe(
      '/api/workbench/bindings/p/canvas-video-preview?path=media%2Fa.mp4&sourceRevision=rev-a&frameTimeMs=0&canonicalSourceIdentity=frame-v1--ms-0&w=300'
    );
  });

  it('Ensures one target after Probe reports needs-source', async () => {
    const node = videoNode('media/a.mp4', 'rev-a', 2_500);
    const ensure = vi.fn<WorkbenchActions['ensureCanvasVideoPreviewSource']>(async () => ({
      status: 'ready' as const,
      canonicalSourceIdentity: 'frame-v1--ms-2500',
      sourceWidth: 1920
    }));
    await renderVideoPreviewProvider({
      nodes: [node],
      actions: actionsWith({
        probeCanvasVideoPreviewSources: async (input) => needsSourceProbeResponse(input),
        ensureCanvasVideoPreviewSource: ensure
      }),
      children: <PreviewProbe node={node} />
    });

    await flushEffects();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0]?.[0]).toEqual({
      target: {
        projectRelativePath: 'media/a.mp4',
        sourceRevision: 'rev-a',
        frameTimeMs: 2_500
      },
      canonicalSourceIdentity: 'frame-v1--ms-2500'
    });
    expect(previewSrc()).toContain('frameTimeMs=2500');
    expect(previewSrc()).toContain('canonicalSourceIdentity=frame-v1--ms-2500');
  });

  it('allows the next Probe window to overlap the single in-flight Ensure', async () => {
    const nodes = Array.from({ length: 11 }, (_, index) => videoNode(`media/${index}.mp4`, `rev-${index}`));
    const secondProbe = deferred<ReturnType<typeof readyProbeResponse>>();
    const ensureResult = deferred<{ status: 'ready'; canonicalSourceIdentity: string; sourceWidth: number }>();
    let probeCount = 0;
    const probe = vi.fn<WorkbenchActions['probeCanvasVideoPreviewSources']>(async (input) => (
      (probeCount += 1) === 1 ? needsSourceProbeResponse(input) : secondProbe.promise
    ));
    const ensure = vi.fn<WorkbenchActions['ensureCanvasVideoPreviewSource']>(() => ensureResult.promise);
    await renderVideoPreviewProvider({
      nodes,
      actions: actionsWith({
        probeCanvasVideoPreviewSources: probe,
        ensureCanvasVideoPreviewSource: ensure
      }),
      children: <PreviewProbe node={nodes[0]!} />
    });

    await flushEffects();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[0]?.[0].targets).toHaveLength(10);
    expect(probe.mock.calls[1]?.[0].targets).toHaveLength(1);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(secondProbe.settled).toBe(false);
    expect(ensureResult.settled).toBe(false);

    await act(async () => secondProbe.resolve(readyProbeResponse(probe.mock.calls[1]![0])));
    await act(async () => ensureResult.resolve({
      status: 'ready',
      canonicalSourceIdentity: ensure.mock.calls[0]![0].canonicalSourceIdentity,
      sourceWidth: 1920
    }));
  });

  it('does not cancel a Probe when one requested target becomes stale', async () => {
    const first = videoNode('media/a.mp4', 'rev-a');
    const second = videoNode('media/b.mp4', 'rev-b');
    const firstProbe = deferred<ReturnType<typeof readyProbeResponse>>();
    const probeSignals: AbortSignal[] = [];
    let probeCount = 0;
    const probe = vi.fn<WorkbenchActions['probeCanvasVideoPreviewSources']>((input, signal) => {
      if (signal) {
        probeSignals.push(signal);
      }
      return (probeCount += 1) === 1 ? firstProbe.promise : Promise.resolve(readyProbeResponse(input));
    });
    const rendered = await renderVideoPreviewProvider({
      nodes: [first, second],
      actions: actionsWith({ probeCanvasVideoPreviewSources: probe }),
      children: <><PreviewProbe node={first} /><PreviewProbe node={second} /></>
    });
    const firstRequest = probe.mock.calls[0]![0];

    await rendered.rerender([videoNode('media/a.mp4', 'rev-a2'), second]);
    expect(probeSignals[0]?.aborted).toBe(false);

    await act(async () => firstProbe.resolve(readyProbeResponse(firstRequest)));
    await flushEffects();

    expect(container?.querySelectorAll('[data-preview-src]')).toHaveLength(2);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[1]?.[0].targets).toEqual([{
      projectRelativePath: 'media/a.mp4',
      sourceRevision: 'rev-a2',
      frameTimeMs: 0
    }]);
  });

  it('dispatches a replacement target after an entirely stale Probe batch settles', async () => {
    const firstProbe = deferred<ReturnType<typeof readyProbeResponse>>();
    let probeCount = 0;
    const probe = vi.fn<WorkbenchActions['probeCanvasVideoPreviewSources']>((input) => (
      (probeCount += 1) === 1 ? firstProbe.promise : Promise.resolve(readyProbeResponse(input))
    ));
    const rendered = await renderVideoPreviewProvider({
      nodes: [videoNode('media/a.mp4', 'rev-a')],
      actions: actionsWith({ probeCanvasVideoPreviewSources: probe }),
      children: <PreviewProbe node={videoNode('media/a.mp4', 'rev-a')} />
    });
    const firstRequest = probe.mock.calls[0]![0];

    await rendered.rerender([videoNode('media/a.mp4', 'rev-a2')]);
    await act(async () => firstProbe.resolve(readyProbeResponse(firstRequest)));
    await flushEffects();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[1]?.[0].targets).toEqual([{
      projectRelativePath: 'media/a.mp4',
      sourceRevision: 'rev-a2',
      frameTimeMs: 0
    }]);
    expect(previewSrc()).toContain('sourceRevision=rev-a2');
  });

  it('cancels Ensure when its exact target identity becomes stale', async () => {
    const firstEnsure = deferred<{ status: 'ready'; canonicalSourceIdentity: string; sourceWidth: number }>();
    let ensureSignal: AbortSignal | undefined;
    const probe = vi.fn<WorkbenchActions['probeCanvasVideoPreviewSources']>(async (input) => (
      input.targets[0]?.sourceRevision === 'rev-a'
        ? needsSourceProbeResponse(input)
        : readyProbeResponse(input)
    ));
    const ensure = vi.fn<WorkbenchActions['ensureCanvasVideoPreviewSource']>((_input, signal) => {
      ensureSignal = signal;
      return firstEnsure.promise;
    });
    const rendered = await renderVideoPreviewProvider({
      nodes: [videoNode('media/a.mp4', 'rev-a')],
      actions: actionsWith({
        probeCanvasVideoPreviewSources: probe,
        ensureCanvasVideoPreviewSource: ensure
      }),
      children: <PreviewProbe node={videoNode('media/a.mp4', 'rev-a')} />
    });
    await flushEffects();
    expect(ensure).toHaveBeenCalledTimes(1);

    await rendered.rerender([videoNode('media/a.mp4', 'rev-a2')]);

    expect(ensureSignal?.aborted).toBe(true);
    await flushEffects();
    expect(previewSrc()).toContain('sourceRevision=rev-a2');
  });

  it('does not dispatch stale needs-source work when identity changes as interaction ends', async () => {
    const firstProbe = deferred<ReturnType<typeof needsSourceProbeResponse>>();
    let probeCount = 0;
    const probe = vi.fn<WorkbenchActions['probeCanvasVideoPreviewSources']>((input) => (
      (probeCount += 1) === 1 ? firstProbe.promise : Promise.resolve(readyProbeResponse(input))
    ));
    const ensure = vi.fn<WorkbenchActions['ensureCanvasVideoPreviewSource']>();
    const scheduler = createImmediateScheduler();
    const rendered = await renderVideoPreviewProvider({
      nodes: [videoNode('media/a.mp4', 'rev-a')],
      actions: actionsWith({
        probeCanvasVideoPreviewSources: probe,
        ensureCanvasVideoPreviewSource: ensure
      }),
      previewResourceScheduler: scheduler,
      children: <PreviewProbe node={videoNode('media/a.mp4', 'rev-a')} />
    });
    const firstRequest = probe.mock.calls[0]![0];

    await rendered.rerender([videoNode('media/a.mp4', 'rev-a')], true);
    await act(async () => firstProbe.resolve(needsSourceProbeResponse(firstRequest)));
    await flushEffects();
    expect(ensure).not.toHaveBeenCalled();

    await rendered.rerender([videoNode('media/a.mp4', 'rev-a2')], false);
    await flushEffects();

    expect(ensure).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[1]?.[0].targets[0]?.sourceRevision).toBe('rev-a2');
  });

  it('returns source-changed Ensure results to needs-probe', async () => {
    let probeCount = 0;
    const probe = vi.fn<WorkbenchActions['probeCanvasVideoPreviewSources']>(async (input) => (
      (probeCount += 1) === 1 ? needsSourceProbeResponse(input) : readyProbeResponse(input)
    ));
    await renderVideoPreviewProvider({
      nodes: [videoNode('media/a.mp4', 'rev-a')],
      actions: actionsWith({
        probeCanvasVideoPreviewSources: probe,
        ensureCanvasVideoPreviewSource: async () => ({ status: 'source-changed' })
      }),
      children: <PreviewProbe node={videoNode('media/a.mp4', 'rev-a')} />
    });

    await flushEffects();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(previewSrc()).toContain('canonicalSourceIdentity=frame-v1--ms-0');
  });

  it('does not auto-retry a failed Probe and explicit node Retry restarts needs-probe', async () => {
    const node = videoNode('media/a.mp4', 'rev-a');
    let probeCount = 0;
    const probe = vi.fn<WorkbenchActions['probeCanvasVideoPreviewSources']>(async (input) => (
      (probeCount += 1) === 1
        ? {
            sources: Object.fromEntries(input.targets.map((target) => [target.projectRelativePath, {
              ...target,
              status: 'failed' as const,
              message: 'probe failed'
            }]))
          }
        : readyProbeResponse(input)
    ));
    let runtime: CanvasVideoPreviewRuntimeValue | undefined;
    const rendered = await renderVideoPreviewProvider({
      nodes: [node],
      actions: actionsWith({ probeCanvasVideoPreviewSources: probe }),
      children: <><PreviewProbe node={node} /><VideoRuntimeCapture onRuntime={(value) => { runtime = value; }} /></>
    });
    await flushEffects();
    expect(previewError()).toBe('probe failed');

    await rendered.rerender([{ ...node }]);
    await flushEffects();
    expect(probe).toHaveBeenCalledTimes(1);

    await act(async () => runtime?.retryPreview(node.projectRelativePath));
    await flushEffects();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(previewError()).toBeUndefined();
    expect(previewSrc()).toContain('canonicalSourceIdentity=frame-v1--ms-0');
  });

  it('publishes an accepted source target only to the matching video path', async () => {
    const [a, b] = [videoNode('media/a.mp4', 'rev-a'), videoNode('media/b.mp4', 'rev-b')];
    let runtime: CanvasVideoPreviewRuntimeValue | undefined;
    await renderVideoPreviewProvider({
      nodes: [a, b],
      actions: actionsWith(),
      children: <VideoRuntimeCapture onRuntime={(value) => { runtime = value; }} />
    });
    await flushEffects();
    expect(runtime!.getNodeSnapshot(a).request.continuityKey).toBeTruthy();
    expect(runtime!.getNodeSnapshot(b).request.continuityKey).toBeTruthy();
    const aListener = vi.fn();
    const bListener = vi.fn();
    const unsubscribeA = runtime!.subscribeNode(a, aListener);
    const unsubscribeB = runtime!.subscribeNode(b, bListener);

    await act(async () => runtime!.acceptNode(videoNode('media/a.mp4', 'rev-a2')));

    expect(aListener).toHaveBeenCalled();
    expect(bListener).not.toHaveBeenCalled();
    unsubscribeA();
    unsubscribeB();
  });

});

function VideoRuntimeConsumer(): React.ReactElement {
  useCanvasVideoPreviewRuntime();
  return <div />;
}

function VideoRuntimeCapture({
  onRuntime
}: {
  onRuntime: (runtime: CanvasVideoPreviewRuntimeValue) => void;
}): React.ReactElement {
  const runtime = useCanvasVideoPreviewRuntime();
  React.useEffect(() => onRuntime(runtime), [onRuntime, runtime]);
  return <div />;
}

async function renderVideoPreviewProvider(input: {
  nodes: ProjectedCanvasNode[];
  actions: WorkbenchActions;
  children: React.ReactNode;
  interactionActive?: boolean | undefined;
  previewResourceScheduler?: CanvasPreviewResourceScheduler | undefined;
}): Promise<{
  rerender(nodes: ProjectedCanvasNode[], interactionActive?: boolean): Promise<void>;
}> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const scheduler = input.previewResourceScheduler ?? createImmediateScheduler();
  const render = (nodes: ProjectedCanvasNode[], interactionActive = input.interactionActive ?? false) => {
    scheduler.setInteractionState({
      cameraState: interactionActive ? 'moving' : 'idle',
      pointerInteractionActive: false
    });
    root?.render(
      <CanvasVideoPreviewProvider
        nodes={nodes}
        sourceResolutionRuntime={sourceNodeReader}
        activeVideoPaths={new Set()}
        actions={input.actions}
        previewOrder={previewOrderSource()}
        previewResourceScheduler={scheduler}
      >
        {input.children}
      </CanvasVideoPreviewProvider>
    );
  };
  await act(async () => render(input.nodes));
  return {
    rerender: async (nodes, interactionActive) => {
      await act(async () => render(nodes, interactionActive));
    }
  };
}

function PreviewProbe({ node }: { node: ProjectedCanvasNode }): React.ReactElement {
  const { request, previewError: error } = useCanvasVideoPreviewNode(node);
  const previewSrc = request.variantTarget?.srcForWidth(300);
  return (
    <div data-preview-path={node.projectRelativePath}>
      {previewSrc ? <span data-preview-src={previewSrc} /> : null}
      {error ? <span data-preview-error={error} /> : null}
    </div>
  );
}

function actionsWith(overrides: Partial<WorkbenchActions> = {}): WorkbenchActions {
  return {
    probeCanvasVideoPreviewSources: async (input) => readyProbeResponse(input),
    ensureCanvasVideoPreviewSource: async (input) => ({
      status: 'ready',
      canonicalSourceIdentity: input.canonicalSourceIdentity,
      sourceWidth: 1920
    }),
    ...overrides
  } as WorkbenchActions;
}

function readyProbeResponse(input: CanvasVideoPreviewProbeRequest) {
  return {
    sources: Object.fromEntries(input.targets.map((target) => [target.projectRelativePath, {
      ...target,
      status: 'ready' as const,
      canonicalSourceIdentity: `frame-v1--ms-${target.frameTimeMs}`,
      sourceWidth: 1200
    }]))
  };
}

function needsSourceProbeResponse(input: CanvasVideoPreviewProbeRequest) {
  return {
    sources: Object.fromEntries(input.targets.map((target) => [target.projectRelativePath, {
      ...target,
      status: 'needs-source' as const,
      canonicalSourceIdentity: `frame-v1--ms-${target.frameTimeMs}`
    }]))
  };
}

function createImmediateScheduler(): CanvasPreviewResourceScheduler {
  let interaction: ReturnType<CanvasPreviewResourceScheduler['getInteractionState']> = {
    cameraState: 'idle',
    pointerInteractionActive: false
  };
  const listeners = new Set<Parameters<CanvasPreviewResourceScheduler['subscribeInteraction']>[0]>();
  return {
    enqueue: runImmediately,
    enqueuePublication: runImmediately,
    cancel: () => undefined,
    setInteractionState: (next) => {
      interaction = { ...next };
      for (const listener of listeners) {
        listener(interaction);
      }
    },
    getInteractionState: () => interaction,
    subscribeInteraction: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => undefined
  };
}

function runImmediately(request: CanvasPreviewResourceRequest): void {
  if (request.isCurrent()) {
    request.run();
  }
}

function previewOrderSource(): CanvasPreviewOrderSource {
  const snapshot = { x: 0, y: 0, width: 1000, height: 1000 };
  return {
    getPreviewOrderSnapshot: () => snapshot,
    subscribePreviewOrder: () => () => undefined
  };
}

function videoNode(
  projectRelativePath: string,
  revision: string,
  currentTimeMs = 0,
  fileUrl = `/api/workbench/bindings/p/files/raw/${projectRelativePath}?v=${revision}`
): ProjectedCanvasNode {
  return {
    projectRelativePath,
    displayName: projectRelativePath,
    nodeKind: 'file',
    mediaKind: 'video',
    x: 0,
    y: 0,
    width: 1200,
    height: 675,
    z: 0,
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'video/mp4',
      fileUrl,
      revision
    },
    videoPresentation: {
      kind: 'video',
      width: 640,
      height: 360,
      textTracks: []
    },
    ...(currentTimeMs === 0 ? {} : { videoPlayback: { currentTimeMs } })
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function previewSrc(): string | undefined {
  return container?.querySelector('[data-preview-src]')?.getAttribute('data-preview-src') ?? undefined;
}

function previewError(): string | undefined {
  return container?.querySelector('[data-preview-error]')?.getAttribute('data-preview-error') ?? undefined;
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = (value) => {
      settled = true;
      resolve(value);
    };
    rejectPromise = (reason) => {
      settled = true;
      reject(reason);
    };
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    get settled() {
      return settled;
    }
  };
}
