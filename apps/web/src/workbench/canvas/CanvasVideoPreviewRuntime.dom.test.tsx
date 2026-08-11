import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CanvasFeedbackDocument,
  CanvasFeedbackVideoResource,
  CanvasVideoPreviewSourceRequest,
  CanvasVideoPreviewSourceResponse
} from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../types';
import type { ProjectedCanvasNode } from './CanvasScene';
import type {
  CanvasPreviewResourceRequest,
  CanvasPreviewResourceScheduler
} from './CanvasPreviewResourceScheduler';
import type { CanvasPreviewOrderSource } from './CanvasRenderLifecycle';
import {
  CanvasVideoPreviewProvider,
  canvasVideoPreviewTargetsForNodes,
  useCanvasVideoPreviewNode,
  useCanvasVideoPreviewRuntime,
  type CanvasVideoPreviewRuntimeValue
} from './CanvasVideoPreviewRuntime';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const sourceNodeReader = {
  getNode: () => undefined,
  getResolvedSource: () => undefined,
  getSourceVersion: () => 0,
  subscribeSources: () => () => undefined
};

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

describe('CanvasVideoPreviewRuntime', { tags: ['canvas-video'] }, () => {
  it('requires its provider', () => {
    expect(() => renderToStaticMarkup(<Consumer />)).toThrow('CanvasVideoPreviewProvider is required.');
  });

  it('targets playback and every persisted Feedback Moment independently', () => {
    const feedback: CanvasFeedbackDocument = {
      updatedAt: '2026-08-11T00:00:00.000Z',
      entries: {
        'media/a.mkv': {
          projectRelativePath: 'media/a.mkv',
          marks: [],
          nextMomentLabel: 2,
          nextSpatialLabel: 1,
          updatedAt: '2026-08-11T00:00:00.000Z',
          items: [{
            id: 'comment-1',
            kind: 'comment',
            scope: 'moment',
            comment: 'frame',
            createdAt: '2026-08-11T00:00:00.000Z',
            updatedAt: '2026-08-11T00:00:00.000Z',
            moment: { label: 'M1', currentTimeSeconds: 2.5 }
          }]
        }
      }
    };
    expect(canvasVideoPreviewTargetsForNodes([videoNode()], feedback.entries)).toEqual([{
      bindingId: 'project-1',
      projectRelativePath: 'media/a.mkv',
      sourceRevision: 'rev-a',
      sourceUrl: '/api/workbench/bindings/project-1/files/raw/media/a.mkv?v=rev-a',
      frameTimeMs: 1_000
    }, {
      bindingId: 'project-1',
      projectRelativePath: 'media/a.mkv',
      sourceRevision: 'rev-a',
      sourceUrl: '/api/workbench/bindings/project-1/files/raw/media/a.mkv?v=rev-a',
      frameTimeMs: 2_500
    }]);
  });

  it('rejects a raw-file URL outside the Runtime contract', () => {
    expect(() => canvasVideoPreviewTargetsForNodes([videoNode({
      fileUrl: 'http://127.0.0.1:17321/api/workbench/bindings/project-1/files/raw/media/a.mkv?v=rev-a'
    })])).toThrow('Canvas file URL must be a relative Runtime raw-file URL.');
  });

  it('reads persisted Feedback Moments for a video outside the disclosed Canvas resources', async () => {
    const projectRelativePath = 'archive/clip.mkv';
    const feedback = feedbackMomentDocument(projectRelativePath, 3.25);
    const read = vi.fn<WorkbenchActions['readCanvasVideoPreviewSources']>(async (input) => (
      availableResponse(input)
    ));
    await renderProvider({
      nodes: [],
      feedbackEntries: feedback.entries,
      feedbackVideoResources: [feedbackVideoResource(projectRelativePath)],
      actions: actionsWith({ readCanvasVideoPreviewSources: read }),
      children: <div />
    });
    await flushEffects();

    expect(read).toHaveBeenCalledWith({
      targets: [{
        projectRelativePath,
        sourceRevision: 'rev-hidden',
        frameTimeMs: 3_250
      }]
    }, expect.any(AbortSignal));
  });

  it('retries a hidden Feedback preview failure when the video is disclosed', async () => {
    const projectRelativePath = 'archive/clip.mkv';
    const feedback = feedbackMomentDocument(projectRelativePath, 3.25);
    let readCount = 0;
    const read = vi.fn<WorkbenchActions['readCanvasVideoPreviewSources']>(async (input) => {
      const attempt = readCount;
      readCount += 1;
      return {
        sources: input.targets.map((target) => (attempt === 0
          ? { ...target, status: 'error' as const, message: 'hidden decode failed' }
          : {
              ...target,
              status: 'available' as const,
              sourceWidth: 1_920,
              metadata: { width: 1_920, height: 1_080, durationSeconds: 4 }
            }))
      };
    });
    const rendered = await renderProvider({
      nodes: [],
      feedbackEntries: feedback.entries,
      feedbackVideoResources: [feedbackVideoResource(projectRelativePath)],
      actions: actionsWith({ readCanvasVideoPreviewSources: read }),
      children: <div />
    });
    await flushEffects();
    expect(read).toHaveBeenCalledTimes(1);

    const disclosed = videoNode({ projectRelativePath, revision: 'rev-hidden' });
    await rendered.rerender([disclosed], <PreviewProbe node={disclosed} />);
    await flushEffects();

    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]?.[0].targets.map((target) => target.frameTimeMs)).toEqual([
      1_000,
      3_250
    ]);
  });

  it('keeps pending reads paused during interaction and resumes afterward', async () => {
    const node = videoNode();
    const read = vi.fn(async (input: CanvasVideoPreviewSourceRequest) => availableResponse(input));
    const scheduler = createImmediateScheduler();
    await renderProvider({
      nodes: [node],
      actions: actionsWith({ readCanvasVideoPreviewSources: read }),
      interactionActive: true,
      scheduler,
      children: <PreviewProbe node={node} />
    });

    await flushEffects();
    expect(read).not.toHaveBeenCalled();

    await act(async () => scheduler.setInteractionState({
      cameraState: 'idle',
      pointerInteractionActive: false
    }));
    await flushEffects();
    expect(read).toHaveBeenCalledTimes(1);
    expect(previewSrc()).toContain('sourceRevision=rev-a');
  });

  it('ignores a stale read result and publishes only the replacement revision', async () => {
    const firstRead = deferred<CanvasVideoPreviewSourceResponse>();
    let readCount = 0;
    const read = vi.fn<WorkbenchActions['readCanvasVideoPreviewSources']>(async (input) => (
      (readCount += 1) === 1 ? firstRead.promise : availableResponse(input)
    ));
    const first = videoNode();
    const rendered = await renderProvider({
      nodes: [first],
      actions: actionsWith({ readCanvasVideoPreviewSources: read }),
      children: <PreviewProbe node={first} />
    });
    const firstRequest = read.mock.calls[0]![0];

    const replacement = videoNode({ revision: 'rev-b' });
    await rendered.rerender([replacement], <PreviewProbe node={replacement} />);
    await act(async () => firstRead.resolve(availableResponse(firstRequest)));
    await flushEffects();

    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]?.[0].targets[0]?.sourceRevision).toBe('rev-b');
    expect(previewSrc()).toContain('sourceRevision=rev-b');
    expect(previewSrc()).not.toContain('sourceRevision=rev-a');
  });

  it('cancels hidden capture when playback takes ownership of the path', async () => {
    const node = videoNode();
    let captureVideo: HTMLVideoElement | undefined;
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const element = createElement(tagName, options);
      if (tagName === 'video') captureVideo = element as HTMLVideoElement;
      return element;
    }) as typeof document.createElement);
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    const save = vi.fn<WorkbenchActions['saveCanvasVideoPreviewSource']>();
    const rendered = await renderProvider({
      nodes: [node],
      actions: actionsWith({
        readCanvasVideoPreviewSources: async (input) => ({
          sources: input.targets.map((target) => ({ ...target, status: 'missing' as const }))
        }),
        saveCanvasVideoPreviewSource: save
      }),
      children: <PreviewProbe node={node} />
    });
    await flushEffects();
    expect(captureVideo).toBeDefined();
    expect(load).toHaveBeenCalledTimes(1);

    await rendered.rerender([node], undefined, new Set([node.projectRelativePath]));
    await flushEffects();

    expect(load).toHaveBeenCalledTimes(2);
    expect(captureVideo?.hasAttribute('src')).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('does not auto-retry a failed read and retries explicitly', async () => {
    const node = videoNode();
    let readCount = 0;
    const read = vi.fn<WorkbenchActions['readCanvasVideoPreviewSources']>(async (input) => {
      if ((readCount += 1) === 1) {
        return {
          sources: input.targets.map((target) => ({
            ...target,
            status: 'error' as const,
            message: 'browser source read failed'
          }))
        };
      }
      return availableResponse(input);
    });
    let runtime: CanvasVideoPreviewRuntimeValue | undefined;
    const rendered = await renderProvider({
      nodes: [node],
      actions: actionsWith({ readCanvasVideoPreviewSources: read }),
      children: <><PreviewProbe node={node} /><RuntimeCapture onRuntime={(value) => { runtime = value; }} /></>
    });
    await flushEffects();
    expect(previewError()).toBe('browser source read failed');

    await rendered.rerender([{ ...node }]);
    await flushEffects();
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => runtime?.retryPreview(node.projectRelativePath));
    await flushEffects();
    expect(read).toHaveBeenCalledTimes(2);
    expect(previewError()).toBeUndefined();
    expect(previewSrc()).toContain('frameTimeMs=1000');
  });

  it('publishes source and metadata only for the matching path', async () => {
    const first = videoNode();
    const second = videoNode({
      projectRelativePath: 'media/b.webm',
      revision: 'rev-b',
      fileUrl: '/api/workbench/bindings/project-1/files/raw/media/b.webm?v=rev-b'
    });
    const onMetadata = vi.fn();
    let runtime: CanvasVideoPreviewRuntimeValue | undefined;
    await renderProvider({
      nodes: [first, second],
      actions: actionsWith(),
      onMetadata,
      children: <RuntimeCapture onRuntime={(value) => { runtime = value; }} />
    });
    await flushEffects();
    expect(runtime!.getNodeSnapshot(first).request.continuityKey).toBeTruthy();
    expect(runtime!.getNodeSnapshot(second).request.continuityKey).toBeTruthy();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const unsubscribeFirst = runtime!.subscribeNode(first, firstListener);
    const unsubscribeSecond = runtime!.subscribeNode(second, secondListener);

    await act(async () => runtime!.acceptNode(videoNode({ revision: 'rev-c' })));

    expect(firstListener).toHaveBeenCalled();
    expect(secondListener).not.toHaveBeenCalled();
    expect(onMetadata).toHaveBeenCalledWith({
      projectRelativePath: first.projectRelativePath,
      sourceRevision: 'rev-a',
      metadata: { width: 1_920, height: 1_080, durationSeconds: 4 }
    });
    unsubscribeFirst();
    unsubscribeSecond();
  });
});

function Consumer(): React.ReactElement {
  useCanvasVideoPreviewRuntime();
  return <div />;
}

function RuntimeCapture({
  onRuntime
}: {
  onRuntime: (runtime: CanvasVideoPreviewRuntimeValue) => void;
}): React.ReactElement {
  const runtime = useCanvasVideoPreviewRuntime();
  React.useEffect(() => onRuntime(runtime), [onRuntime, runtime]);
  return <div />;
}

function PreviewProbe({ node }: { node: ProjectedCanvasNode }): React.ReactElement {
  const { request, previewError } = useCanvasVideoPreviewNode(node);
  const src = request.variantTarget?.srcForWidth(300);
  return (
    <div>
      {src ? <span data-preview-src={src} /> : null}
      {previewError ? <span data-preview-error={previewError} /> : null}
    </div>
  );
}

async function renderProvider(input: {
  nodes: ProjectedCanvasNode[];
  actions: WorkbenchActions;
  children: React.ReactNode;
  interactionActive?: boolean;
  scheduler?: CanvasPreviewResourceScheduler;
  onMetadata?: (update: {
    projectRelativePath: string;
    sourceRevision: string;
    metadata: { width: number; height: number; durationSeconds?: number };
  }) => void;
  activeVideoPaths?: ReadonlySet<string>;
  feedbackEntries?: CanvasFeedbackDocument['entries'];
  feedbackVideoResources?: Parameters<typeof CanvasVideoPreviewProvider>[0]['feedbackVideoResources'];
}): Promise<{
  rerender(
    nodes: ProjectedCanvasNode[],
    children?: React.ReactNode,
    activeVideoPaths?: ReadonlySet<string>
  ): Promise<void>;
}> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const scheduler = input.scheduler ?? createImmediateScheduler();
  let currentChildren = input.children;
  let currentActiveVideoPaths = input.activeVideoPaths ?? new Set<string>();
  const render = (nodes: ProjectedCanvasNode[], interactionActive = input.interactionActive ?? false) => {
    scheduler.setInteractionState({
      cameraState: interactionActive ? 'moving' : 'idle',
      pointerInteractionActive: false
    });
    root?.render(
      <CanvasVideoPreviewProvider
        nodes={nodes}
        feedbackVideoResources={input.feedbackVideoResources}
        sourceResolutionRuntime={sourceNodeReader}
        activeVideoPaths={currentActiveVideoPaths}
        feedbackEntries={input.feedbackEntries}
        actions={input.actions}
        previewOrder={previewOrderSource()}
        previewResourceScheduler={scheduler}
        onMetadata={input.onMetadata}
      >
        {currentChildren}
      </CanvasVideoPreviewProvider>
    );
  };
  await act(async () => render(input.nodes));
  return {
    rerender: async (nodes, children, activeVideoPaths) => {
      if (children !== undefined) currentChildren = children;
      if (activeVideoPaths !== undefined) currentActiveVideoPaths = activeVideoPaths;
      await act(async () => render(nodes, false));
    }
  };
}

function actionsWith(overrides: Partial<WorkbenchActions> = {}): WorkbenchActions {
  return {
    readCanvasVideoPreviewSources: async (input) => availableResponse(input),
    saveCanvasVideoPreviewSource: async (input) => ({
      ok: true,
      source: {
        projectRelativePath: input.projectRelativePath,
        sourceRevision: input.sourceRevision,
        frameTimeMs: input.frameTimeMs,
        status: 'available',
        sourceWidth: input.metadata.width,
        metadata: input.metadata
      }
    }),
    ...overrides
  } as WorkbenchActions;
}

function availableResponse(input: CanvasVideoPreviewSourceRequest): CanvasVideoPreviewSourceResponse {
  return {
    sources: input.targets.map((target) => ({
      ...target,
      status: 'available',
      sourceWidth: 1_920,
      metadata: { width: 1_920, height: 1_080, durationSeconds: 4 }
    }))
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
      for (const listener of listeners) listener(interaction);
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
  if (request.isCurrent()) request.run();
}

function previewOrderSource(): CanvasPreviewOrderSource {
  const snapshot = { x: 0, y: 0, width: 1_000, height: 1_000 };
  return {
    getPreviewOrderSnapshot: () => snapshot,
    subscribePreviewOrder: () => () => undefined
  };
}

function feedbackMomentDocument(
  projectRelativePath: string,
  currentTimeSeconds: number
): CanvasFeedbackDocument {
  return {
    updatedAt: '2026-08-11T00:00:00.000Z',
    entries: {
      [projectRelativePath]: {
        projectRelativePath,
        marks: [],
        nextMomentLabel: 2,
        nextSpatialLabel: 1,
        updatedAt: '2026-08-11T00:00:00.000Z',
        items: [{
          id: 'hidden-moment',
          kind: 'comment',
          scope: 'moment',
          comment: 'hidden frame',
          createdAt: '2026-08-11T00:00:00.000Z',
          updatedAt: '2026-08-11T00:00:00.000Z',
          moment: { label: 'M1', currentTimeSeconds }
        }]
      }
    }
  };
}

function feedbackVideoResource(projectRelativePath: string): CanvasFeedbackVideoResource {
  return {
    projectRelativePath,
    nodeKind: 'file',
    mediaKind: 'video',
    availability: {
      state: 'available',
      size: 1,
      mimeType: 'video/x-matroska',
      fileUrl: `/api/workbench/bindings/project-1/files/raw/${projectRelativePath}?v=rev-hidden`,
      revision: 'rev-hidden'
    }
  };
}

function videoNode(overrides: {
  projectRelativePath?: string;
  revision?: string;
  fileUrl?: string;
} = {}): ProjectedCanvasNode {
  const projectRelativePath = overrides.projectRelativePath ?? 'media/a.mkv';
  const revision = overrides.revision ?? 'rev-a';
  return {
    nodeKind: 'file',
    mediaKind: 'video',
    projectRelativePath,
    displayName: projectRelativePath,
    x: 0,
    y: 0,
    width: 3_200,
    height: 1_800,
    z: 0,
    videoPlayback: { currentTimeMs: 1_000 },
    availability: {
      state: 'available',
      size: 1,
      mimeType: 'video/x-matroska',
      fileUrl: overrides.fileUrl
        ?? `/api/workbench/bindings/project-1/files/raw/${projectRelativePath}?v=${revision}`,
      revision
    }
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
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
