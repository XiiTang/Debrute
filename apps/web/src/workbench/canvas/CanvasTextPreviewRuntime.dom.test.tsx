import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types.js';
import type {
  CanvasTextPreviewCaptureResult,
  CanvasTextPreviewCaptureTarget
} from './CanvasTextPreviewCapture.js';
import type { CanvasTextPreviewFailure } from './CanvasTextPreviewFailure.js';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler.js';
import type { CanvasPreviewOrderSource } from './CanvasRenderLifecycle.js';
import {
  CanvasTextPreviewProvider,
  useCanvasTextPreviewNode,
  useCanvasTextPreviewRuntime
} from './CanvasTextPreviewRuntime.js';
import type { CanvasTextRenderProfile } from './CanvasTextRenderProfile.js';
import { CanvasTextRenderProfileGate } from './CanvasTextRenderProfileContext.js';
import { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } from './CanvasTextRenderProfile.test-support.js';
import type { CanvasTextPreviewFontSession } from './font-subset/CanvasTextPreviewFontSession.js';

type SavePreviewResult = Awaited<ReturnType<WorkbenchActions['saveCanvasTextPreviewSource']>>;

const TEST_PROFILE = DEFAULT_CANVAS_TEXT_RENDER_PROFILE;

const fontEnvironmentMock = vi.hoisted(() => {
  const activeFont = {
    resourceIdentity: 'test-font',
    embeddedFaces: [{ family: 'test', weight: '400', css: '@font-face{}' }]
  };
  const prepareCoverage = vi.fn<CanvasTextPreviewFontSession['prepareCoverage']>(async () => ({
    activate: () => activeFont,
    discard: () => undefined
  }));
  return {
    previewSession: { prepareCoverage, dispose: vi.fn() },
    prepareCoverage,
    prepareInteractive: vi.fn(async () => undefined),
    setPreviewMetricsObserver: vi.fn()
  };
});

const styleKeyMock = vi.hoisted(() => ({
  snapshot: vi.fn((profile: CanvasTextRenderProfile) => ({ identity: profile.identity })),
  key: vi.fn(async (snapshot: { identity: string }) => `sha256:${snapshot.identity}`)
}));

vi.mock('./font-subset/CanvasTextProjectFontEnvironment.js', () => ({
  useCanvasTextProjectFontEnvironment: () => fontEnvironmentMock
}));

const laneMock = vi.hoisted(() => ({
  props: undefined as {
    target: CanvasTextPreviewCaptureTarget | undefined;
    onRasterized(target: CanvasTextPreviewCaptureTarget, result: CanvasTextPreviewCaptureResult): void;
    onFailure(target: CanvasTextPreviewCaptureTarget, failure: CanvasTextPreviewFailure): void;
  } | undefined,
  history: [] as string[]
}));

vi.mock('./CanvasTextPreviewCaptureLane.js', async () => {
  const ReactModule = await import('react');
  return {
    CanvasTextPreviewCaptureLane: (props: NonNullable<typeof laneMock.props>) => {
      laneMock.props = props;
      if (props.target && laneMock.history.at(-1) !== props.target.projectRelativePath) {
        laneMock.history.push(props.target.projectRelativePath);
      }
      return ReactModule.createElement('div', { 'data-capture-target': props.target?.projectRelativePath });
    }
  };
});

vi.mock('./CanvasTextPreviewStyleKey.js', () => ({
  canvasTextPreviewStyleSnapshotForDocument: styleKeyMock.snapshot,
  canvasTextPreviewStyleKey: styleKeyMock.key
}));

describe('CanvasTextPreviewRuntime', { tags: ['canvas-text'] }, () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    styleKeyMock.snapshot.mockImplementation((profile) => ({ identity: profile.identity }));
    styleKeyMock.key.mockImplementation(async (snapshot) => `sha256:${snapshot.identity}`);
    laneMock.props = undefined;
    laneMock.history = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('requires a provider', () => {
    expect(() => renderToStaticMarkup(<RuntimeConsumer />)).toThrow('CanvasTextPreviewProvider is required.');
  });

  it('checks canonical source availability before reading content or preparing fonts', async () => {
    const readProjectTextFile = vi.fn<WorkbenchActions['readProjectTextFile']>();
    const readCanvasTextPreviewSources = vi.fn<WorkbenchActions['readCanvasTextPreviewSources']>(async (request) => ({
      sources: Object.fromEntries(request.sources.map((source) => [
        source.projectRelativePath,
        { ...source, status: 'available' as const }
      ]))
    }));
    await renderProvider({
      nodes: [textNode('cached.md', 0, 0)],
      actions: actionsFixture({ readProjectTextFile, readCanvasTextPreviewSources })
    });
    await waitFor(() => readCanvasTextPreviewSources.mock.calls.length === 1);
    await flushWork();
    await flushWork();

    expect(readCanvasTextPreviewSources).toHaveBeenCalledTimes(1);
    expect(readProjectTextFile).not.toHaveBeenCalled();
    expect(fontEnvironmentMock.prepareCoverage).not.toHaveBeenCalled();
    expect(laneMock.props?.target).toBeUndefined();
  });

  it('admits offscreen targets and uses viewport only to order canonical work', async () => {
    const reads = new Map<string, ReturnType<typeof deferred<Awaited<ReturnType<WorkbenchActions['readProjectTextFile']>>>>>();
    const readProjectTextFile = vi.fn<WorkbenchActions['readProjectTextFile']>((path) => {
      const pending = deferred<Awaited<ReturnType<WorkbenchActions['readProjectTextFile']>>>();
      reads.set(path, pending);
      return pending.promise;
    });
    const readCanvasTextPreviewSources = vi.fn<WorkbenchActions['readCanvasTextPreviewSources']>(async (request) => ({
      sources: Object.fromEntries(request.sources.map((source) => [
        source.projectRelativePath,
        { ...source, status: 'missing' as const }
      ]))
    }));
    await renderProvider({
      nodes: [
        textNode('outside.md', 5000, 0),
        textNode('priority.md', 1200, 0),
        textNode('visible.md', 0, 0)
      ],
      textFileBuffers: {},
      visibleRect: { x: 0, y: 0, width: 800, height: 800 },
      actions: actionsFixture({ readProjectTextFile, readCanvasTextPreviewSources })
    });
    await waitFor(() => readProjectTextFile.mock.calls.length === 2);

    expect(readCanvasTextPreviewSources.mock.calls[0]![0].sources.map((source) => source.projectRelativePath)).toEqual([
      'visible.md', 'priority.md', 'outside.md'
    ]);
    expect(readProjectTextFile.mock.calls.map(([path]) => path)).toEqual(['visible.md', 'priority.md']);

    reads.get('visible.md')!.resolve(textFile('visible.md'));
    await waitFor(() => readProjectTextFile.mock.calls.length === 3);
    expect(readProjectTextFile.mock.calls[2]![0]).toBe('outside.md');
  });

  it('limits physical content reads when a latest-wins target replaces an in-flight task', async () => {
    const reads: Array<{
      path: string;
      pending: ReturnType<typeof deferred<Awaited<ReturnType<WorkbenchActions['readProjectTextFile']>>>>;
    }> = [];
    const readProjectTextFile = vi.fn<WorkbenchActions['readProjectTextFile']>((path) => {
      const pending = deferred<Awaited<ReturnType<WorkbenchActions['readProjectTextFile']>>>();
      reads.push({ path, pending });
      return pending.promise;
    });
    const readCanvasTextPreviewSources = vi.fn<WorkbenchActions['readCanvasTextPreviewSources']>(async (request) => ({
      sources: Object.fromEntries(request.sources.map((source) => [
        source.projectRelativePath,
        { ...source, status: 'missing' as const }
      ]))
    }));
    const actions = actionsFixture({ readProjectTextFile, readCanvasTextPreviewSources });
    const previewResourceScheduler = immediateScheduler();
    const nodes = [
      textNode('a.md', 0, 0),
      textNode('b.md', 0, 1000),
      textNode('c.md', 0, 2000)
    ];

    await renderProvider({ nodes, textFileBuffers: {}, actions, previewResourceScheduler });
    await waitFor(() => reads.length === 2);
    expect(reads.map((read) => read.path)).toEqual(['a.md', 'b.md']);

    const replacement = {
      ...nodes[0]!,
      availability: {
        ...nodes[0]!.availability,
        revision: 'sha256:a-next'
      }
    };
    await renderProvider({
      nodes: [replacement, nodes[1]!, nodes[2]!],
      textFileBuffers: {},
      actions,
      previewResourceScheduler
    });
    await waitFor(() => readCanvasTextPreviewSources.mock.calls.length === 2);
    expect(reads).toHaveLength(2);

    reads[1]!.pending.resolve(textFile('b.md'));
    await waitFor(() => reads.length === 3);
    expect(reads[2]!.path).toBe('c.md');

    reads[0]!.pending.resolve(textFile('a.md'));
    await waitFor(() => reads.length === 4);
    expect(reads[3]!.path).toBe('a.md');
  });

  it('does not dispatch availability, content, font, or capture jobs during interaction', async () => {
    const readCanvasTextPreviewSources = vi.fn<WorkbenchActions['readCanvasTextPreviewSources']>(async (request) => ({
      sources: Object.fromEntries(request.sources.map((source) => [
        source.projectRelativePath,
        { ...source, status: 'missing' as const }
      ]))
    }));
    const previewResourceScheduler = immediateScheduler();
    const input = {
      nodes: [textNode('a.md', 0, 0)],
      actions: actionsFixture({ readCanvasTextPreviewSources }),
      interactionActive: true,
      previewResourceScheduler
    };
    await renderProvider(input);
    await flushWork();
    expect(readCanvasTextPreviewSources).not.toHaveBeenCalled();

    await act(async () => previewResourceScheduler.setInteractionState({
      cameraState: 'idle',
      pointerInteractionActive: false
    }));
    await waitFor(() => readCanvasTextPreviewSources.mock.calls.length === 1);
  });

  it('keeps capture and the current concurrent upload path decoupled', async () => {
    const uploads = [deferred<SavePreviewResult>(), deferred<SavePreviewResult>()];
    let uploadIndex = 0;
    const saveCanvasTextPreviewSource = vi.fn<WorkbenchActions['saveCanvasTextPreviewSource']>(() => {
      const upload = uploads[uploadIndex]!;
      uploadIndex += 1;
      return upload.promise;
    });
    await renderProvider({
      nodes: [textNode('a.md', 0, 0), textNode('b.md', 0, 1000)],
      actions: actionsFixture({ saveCanvasTextPreviewSource })
    });
    await waitFor(() => laneMock.props?.target?.projectRelativePath === 'a.md');
    const first = laneMock.props!.target!;
    await act(async () => laneMock.props!.onRasterized(first, rasterResult()));
    await waitFor(() => laneMock.props?.target?.projectRelativePath === 'b.md');

    expect(saveCanvasTextPreviewSource).toHaveBeenCalledTimes(1);
    expect(uploads[0]!.settled).toBe(false);
    expect(laneMock.history).toEqual(['a.md', 'b.md']);
  });

  it('does not commit the stable text preview provider when Canvas interaction changes', async () => {
    const scheduler = immediateScheduler();
    const node = textNode('failed.md', 0, 0);
    const readCanvasTextPreviewSources = vi.fn<WorkbenchActions['readCanvasTextPreviewSources']>(async (request) => ({
      sources: Object.fromEntries(request.sources.map((source) => [
        source.projectRelativePath,
        { ...source, status: 'error' as const, message: 'preview unavailable' }
      ]))
    }));
    let commitCount = 0;
    await renderProvider({
      nodes: [node],
      actions: actionsFixture({ readCanvasTextPreviewSources }),
      previewResourceScheduler: scheduler,
      consumerNode: node,
      onRender: () => {
        commitCount += 1;
      }
    });
    await waitFor(() => container.querySelector('[data-preview-error]')?.getAttribute(
      'data-preview-error'
    ) === 'preview unavailable');
    commitCount = 0;

    await act(async () => scheduler.setInteractionState({
      cameraState: 'moving',
      pointerInteractionActive: false
    }));
    await act(async () => scheduler.setInteractionState({
      cameraState: 'idle',
      pointerInteractionActive: false
    }));

    expect(commitCount).toBe(0);
  });

  it('does not auto-retry a failed source check and explicit Retry restarts checking', async () => {
    const node = textNode('retry.md', 0, 0);
    let requestCount = 0;
    let runtime: ReturnType<typeof useCanvasTextPreviewRuntime> | undefined;
    const readCanvasTextPreviewSources = vi.fn<WorkbenchActions['readCanvasTextPreviewSources']>(async (request) => ({
      sources: Object.fromEntries(request.sources.map((source) => [
        source.projectRelativePath,
        (requestCount += 1) === 1
          ? { ...source, status: 'error' as const, message: 'preview unavailable' }
          : { ...source, status: 'available' as const }
      ]))
    }));
    const input = {
      nodes: [node],
      actions: actionsFixture({ readCanvasTextPreviewSources }),
      consumerNode: node,
      children: (
        <>
          <RuntimeSnapshotProbe node={node} />
          <TextRuntimeCapture onRuntime={(value) => { runtime = value; }} />
        </>
      )
    };
    await renderProvider(input);
    await waitFor(() => container.querySelector('[data-preview-error]')?.getAttribute(
      'data-preview-error'
    ) === 'preview unavailable');

    await renderProvider(input);
    await flushWork();
    expect(readCanvasTextPreviewSources).toHaveBeenCalledTimes(1);

    await act(async () => runtime?.retryPreview(node.projectRelativePath));
    await waitFor(() => readCanvasTextPreviewSources.mock.calls.length === 2);
    await waitFor(() => container.querySelector('[data-preview-error]')?.getAttribute(
      'data-preview-error'
    ) === '');
  });

  it('adds a node leaving edit mode to the live registry without waiting for existing upload work', async () => {
    const save = deferred<SavePreviewResult>();
    const nodes = [textNode('a.md', 0, 0), textNode('b.md', 0, 1000)];
    const actions = actionsFixture({ saveCanvasTextPreviewSource: () => save.promise });
    await renderProvider({ nodes, actions, activeInlineTextPath: 'a.md' });
    await waitFor(() => laneMock.props?.target?.projectRelativePath === 'b.md');
    const b = laneMock.props!.target!;
    await act(async () => laneMock.props!.onRasterized(b, rasterResult()));

    await renderProvider({ nodes, actions, activeInlineTextPath: undefined });
    await waitFor(() => laneMock.props?.target?.projectRelativePath === 'a.md');
    expect(save.settled).toBe(false);
  });

  async function renderProvider(input: {
    nodes: ProjectedCanvasNode[];
    actions: WorkbenchActions;
    textFileBuffers?: Record<string, TextFileBuffer>;
    activeInlineTextPath?: string | undefined;
    interactionActive?: boolean;
    visibleRect?: { x: number; y: number; width: number; height: number };
    previewResourceScheduler?: CanvasPreviewResourceScheduler;
    consumerNode?: ProjectedCanvasNode | undefined;
    children?: React.ReactNode;
    onRender?: React.ProfilerOnRenderCallback | undefined;
  }): Promise<void> {
    const buffers = input.textFileBuffers ?? Object.fromEntries(input.nodes.map((node) => [
      node.projectRelativePath,
      buffer(node.projectRelativePath)
    ]));
    const scheduler = input.previewResourceScheduler ?? immediateScheduler();
    const previewOrder = previewOrderSource({
      visibleRect: input.visibleRect ?? { x: 0, y: 0, width: 800, height: 800 },
    });
    await act(async () => {
      scheduler.setInteractionState({
        cameraState: input.interactionActive ? 'moving' : 'idle',
        pointerInteractionActive: false
      });
      const tree = (
        <CanvasTextRenderProfileGate profile={TEST_PROFILE} pending={null}>
          <CanvasTextPreviewProvider
            canvasId="canvas-1"
            nodes={input.nodes}
            activeInlineTextPath={input.activeInlineTextPath}
            textFileBuffers={buffers}
            actions={input.actions}
            previewOrder={previewOrder}
            styleDependencyKey="test"
            previewResourceScheduler={scheduler}
          >
            {input.children ?? (input.consumerNode ? (
              <RuntimeSnapshotProbe node={input.consumerNode} />
            ) : <div />)}
          </CanvasTextPreviewProvider>
        </CanvasTextRenderProfileGate>
      );
      root.render(input.onRender ? (
        <React.Profiler id="canvas-text-preview-provider" onRender={input.onRender}>
          {tree}
        </React.Profiler>
      ) : tree);
    });
  }
});

function RuntimeConsumer(): React.ReactElement {
  useCanvasTextPreviewRuntime();
  return <div />;
}

function TextRuntimeCapture({
  onRuntime
}: {
  onRuntime: (runtime: ReturnType<typeof useCanvasTextPreviewRuntime>) => void;
}): React.ReactElement {
  const runtime = useCanvasTextPreviewRuntime();
  React.useEffect(() => onRuntime(runtime), [onRuntime, runtime]);
  return <div />;
}

function previewOrderSource(input: {
  visibleRect: { x: number; y: number; width: number; height: number };
}): CanvasPreviewOrderSource {
  return {
    getPreviewOrderSnapshot: () => input.visibleRect,
    subscribePreviewOrder: () => () => undefined
  };
}

function RuntimeSnapshotProbe({ node }: { node: ProjectedCanvasNode }): React.ReactElement {
  const { request, previewError } = useCanvasTextPreviewNode(node);
  return (
    <div
      data-preview-presented={Boolean(request.variantTarget)}
      data-preview-error={previewError ?? ''}
    />
  );
}

function textNode(path: string, x: number, y: number): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    nodeKind: 'file',
    mediaKind: 'text',
    textLanguage: 'markdown',
    x,
    y,
    width: 4200,
    height: 2800,
    z: 0,
    availability: {
      state: 'available',
      size: path.length,
      mimeType: 'text/markdown',
      fileUrl: `/api/projects/p/files/raw/${path}?v=sha256%3A${path}`,
      revision: `sha256:${path}`
    }
  };
}

function buffer(path: string): TextFileBuffer {
  return {
    projectRelativePath: path,
    content: path,
    language: 'markdown',
    wordWrap: false,
    dirty: false,
    saving: false,
    baseRevision: `sha256:${path}`,
    externalChange: false
  };
}

function textFile(path: string) {
  return {
    projectRelativePath: path,
    content: path,
    size: path.length,
    mtimeMs: 0,
    revision: `sha256:${path}`,
    language: 'markdown' as const,
    mimeType: 'text/markdown'
  };
}

function actionsFixture(overrides: Partial<WorkbenchActions> = {}): WorkbenchActions {
  return {
    readProjectTextFile: async (path) => textFile(path),
    readCanvasTextPreviewSources: async (request) => ({
      sources: Object.fromEntries(request.sources.map((source) => [
        source.projectRelativePath,
        { ...source, status: 'missing' as const }
      ]))
    }),
    saveCanvasTextPreviewSource: async (request) => ({
      ok: true,
      source: { projectRelativePath: request.projectRelativePath, targetIdentity: request.targetIdentity, status: 'available' }
    }),
    ...overrides
  } as WorkbenchActions;
}

function immediateScheduler(overrides: Partial<CanvasPreviewResourceScheduler> = {}): CanvasPreviewResourceScheduler {
  let interaction: ReturnType<CanvasPreviewResourceScheduler['getInteractionState']> = {
    cameraState: 'idle',
    pointerInteractionActive: false
  };
  const interactionListeners = new Set<Parameters<
    CanvasPreviewResourceScheduler['subscribeInteraction']
  >[0]>();
  return {
    enqueue: () => undefined,
    enqueuePublication: () => undefined,
    cancel: () => undefined,
    setInteractionState: (next) => {
      interaction = next.cameraState === 'idle'
        ? { cameraState: 'idle', pointerInteractionActive: next.pointerInteractionActive }
        : { cameraState: 'moving', pointerInteractionActive: next.pointerInteractionActive };
      for (const listener of interactionListeners) {
        listener(interaction);
      }
    },
    getInteractionState: () => interaction,
    subscribeInteraction: (listener) => {
      interactionListeners.add(listener);
      return () => interactionListeners.delete(listener);
    },
    dispose: () => undefined,
    ...overrides
  };
}

function rasterResult(): CanvasTextPreviewCaptureResult {
  return {
    sourcePng: new Blob(['png'], { type: 'image/png' }),
    cssWidth: 420,
    cssHeight: 248,
    sourcePixelWidth: 1680,
    sourcePixelHeight: 992,
    snapshotDurationMs: 1,
    rasterDurationMs: 1,
    captureDurationMs: 2,
    snapshotBytes: 128,
    snapshotElementCount: 8,
    maxSynchronousSliceMs: 1
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) {
      return;
    }
    await flushWork();
  }
  throw new Error('Timed out waiting for Canvas text preview work.');
}

async function flushWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value: T) {
      settled = true;
      resolvePromise(value);
    },
    reject(reason?: unknown) {
      settled = true;
      rejectPromise(reason);
    }
  };
}
