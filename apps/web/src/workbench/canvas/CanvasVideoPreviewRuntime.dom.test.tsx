import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { CanvasVideoPreviewSourceRequest } from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../types';
import type { CanvasPreviewResourceRequest, CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import type { CanvasPreviewOrderSource } from './CanvasRenderLifecycle.js';
import {
  CanvasVideoPreviewProvider,
  canvasVideoPreviewTargetsForNodes,
  shouldStartCanvasVideoPreviewSourceWork,
  useCanvasVideoPreviewNode,
  useCanvasVideoPreviewRuntime,
  type CanvasVideoPreviewRuntimeValue
} from './CanvasVideoPreviewRuntime';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

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

  it('targets inactive available video nodes and excludes active video nodes', () => {
    expect(canvasVideoPreviewTargetsForNodes({
      canvasId: 'canvas-1',
      nodes: [
        videoNode('media/a.mp4', 'rev-a'),
        videoNode('media/b.mp4', 'rev-b'),
        { ...videoNode('media/c.mp4', 'rev-c'), availability: { state: 'missing', message: 'missing' } }
      ],
      activeVideoPaths: new Set(['media/b.mp4'])
    })).toEqual([{
      canvasId: 'canvas-1',
      projectRelativePath: 'media/a.mp4',
      videoRevision: 'rev-a',
      currentTimeSeconds: 0
    }]);
  });

  it('starts source work only when preview interaction is inactive', () => {
    expect(shouldStartCanvasVideoPreviewSourceWork({
      interactionActive: false,
      pendingSourceCount: 1
    })).toBe(true);
    expect(shouldStartCanvasVideoPreviewSourceWork({
      interactionActive: true,
      pendingSourceCount: 1
    })).toBe(false);
    expect(shouldStartCanvasVideoPreviewSourceWork({
      interactionActive: false,
      pendingSourceCount: 0
    })).toBe(false);
  });

  it('keeps pending video preview work paused during interaction and resumes it afterward', async () => {
    const node = videoNode('media/a.mp4', 'rev-a');
    const readCanvasVideoPreviewSources = vi.fn(async () => ({ sources: {} }));
    const previewResourceScheduler = createImmediateScheduler();
    await renderVideoPreviewProvider({
      nodes: [node],
      actions: { readCanvasVideoPreviewSources } as unknown as WorkbenchActions,
      interactionActive: true,
      previewResourceScheduler,
      children: <PreviewProbe node={node} />
    });

    await act(async () => undefined);
    expect(readCanvasVideoPreviewSources).not.toHaveBeenCalled();

    await act(async () => previewResourceScheduler.setInteractionState({
      cameraState: 'idle',
      pointerInteractionActive: false
    }));
    await act(async () => undefined);
    expect(readCanvasVideoPreviewSources).toHaveBeenCalled();
  });

  it('does not restart in-flight source work when the interaction flag is unchanged', async () => {
    const node = videoNode('media/a.mp4', 'rev-a');
    const nodes = [node];
    const readCanvasVideoPreviewSources = vi.fn(() => new Promise<never>(() => undefined));
    const renderResult = await renderVideoPreviewProvider({
      nodes,
      actions: { readCanvasVideoPreviewSources } as unknown as WorkbenchActions,
      children: <PreviewProbe node={node} />
    });

    expect(readCanvasVideoPreviewSources).toHaveBeenCalledTimes(1);
    await renderResult.rerender(nodes, false);
    expect(readCanvasVideoPreviewSources).toHaveBeenCalledTimes(1);
  });

  it('publishes the first ready source immediately for inactive videos', async () => {
    const node = videoNode('media/a.mp4', 'rev-a');
    await renderVideoPreviewProvider({
      nodes: [node],
      actions: {
        readCanvasVideoPreviewSources: async (input: CanvasVideoPreviewSourceRequest) => ({
          sources: Object.fromEntries(input.targets.map((target) => [
            target.projectRelativePath,
            {
              ...target,
              status: 'available' as const,
              sourceKind: 'initial-poster' as const,
              sourceKey: 'v1--explicit--poster',
              sourceWidth: 1200
            }
          ]))
        })
      } as unknown as WorkbenchActions,
      children: <PreviewProbe node={node} />
    });

    await act(async () => undefined);

    expect(container?.querySelector('[data-preview-src]')?.getAttribute('data-preview-src')).toBe(
      '/api/projects/p/canvas-video-preview?canvasId=canvas-1&path=media%2Fa.mp4&videoRevision=rev-a&t=0&sourceKey=v1--explicit--poster&w=300'
    );
  });

  it('retains a published video preview throughout camera interaction', async () => {
    const node = videoNode('media/a.mp4', 'rev-a');
    const nodes = [node];
    const readCanvasVideoPreviewSources = vi.fn(async (input: CanvasVideoPreviewSourceRequest) => ({
      sources: Object.fromEntries(input.targets.map((target) => [
        target.projectRelativePath,
        {
          ...target,
          status: 'available' as const,
          sourceKind: 'initial-poster' as const,
          sourceKey: 'v1--explicit--poster',
          sourceWidth: 1200
        }
      ]))
    }));
    const renderResult = await renderVideoPreviewProvider({
      nodes,
      actions: { readCanvasVideoPreviewSources } as unknown as WorkbenchActions,
      children: <PreviewProbe node={node} />
    });
    await act(async () => undefined);
    const previewSrc = container?.querySelector('[data-preview-src]')?.getAttribute('data-preview-src');
    expect(previewSrc).toBeTruthy();

    await renderResult.rerender(nodes, true);
    expect(container?.querySelector('[data-preview-src]')?.getAttribute('data-preview-src')).toBe(previewSrc);

    await renderResult.rerender(nodes, false);
    expect(container?.querySelector('[data-preview-src]')?.getAttribute('data-preview-src')).toBe(previewSrc);
    expect(readCanvasVideoPreviewSources).toHaveBeenCalledTimes(1);
  });

  it('notifies only the video node whose preview state changes', async () => {
    const first = videoNode('media/first.mp4', 'rev-a');
    const second = videoNode('media/second.mp4', 'rev-b');
    const renders = new Map<string, number>();
    let runtime: CanvasVideoPreviewRuntimeValue | undefined;
    await renderVideoPreviewProvider({
      nodes: [first, second],
      actions: {
        readCanvasVideoPreviewSources: async (input: CanvasVideoPreviewSourceRequest) => ({
          sources: Object.fromEntries(input.targets.map((target) => [
            target.projectRelativePath,
            {
              ...target,
              status: 'available' as const,
              sourceKind: 'initial-poster' as const,
              sourceKey: `${target.projectRelativePath}:poster`,
              sourceWidth: 1200
            }
          ]))
        })
      } as unknown as WorkbenchActions,
      children: (
        <>
          <VideoPreviewRenderCountProbe node={first} renders={renders} />
          <VideoPreviewRenderCountProbe node={second} renders={renders} />
          <VideoRuntimeCapture onRuntime={(value) => { runtime = value; }} />
        </>
      )
    });
    await act(async () => undefined);
    await act(async () => undefined);
    const preview = runtime?.getNodeSnapshot(first).preview;
    expect(preview).toBeDefined();
    renders.clear();

    await act(async () => runtime?.reportPreviewError({
      projectRelativePath: first.projectRelativePath,
      preview: preview!,
      message: 'failed'
    }));

    expect(renders.get(first.projectRelativePath)).toBeGreaterThan(0);
    expect(renders.get(second.projectRelativePath) ?? 0).toBe(0);
  });

  it('does not commit the stable video preview provider when Canvas interaction changes', async () => {
    const previewResourceScheduler = createImmediateScheduler();
    const node = videoNode('media/stable.mp4', 'rev-stable');
    let commitCount = 0;
    await renderVideoPreviewProvider({
      nodes: [node],
      actions: {
        readCanvasVideoPreviewSources: async (input: CanvasVideoPreviewSourceRequest) => ({
          sources: Object.fromEntries(input.targets.map((target) => [
            target.projectRelativePath,
            {
              ...target,
              status: 'available' as const,
              sourceKind: 'initial-poster' as const,
              sourceKey: 'stable-source',
              sourceWidth: 1200
            }
          ]))
        })
      } as unknown as WorkbenchActions,
      previewResourceScheduler,
      onRender: () => {
        commitCount += 1;
      },
      children: <PreviewProbe node={node} />
    });
    await act(async () => undefined);
    expect(container?.querySelector('[data-preview-src]')).not.toBeNull();
    commitCount = 0;

    await act(async () => previewResourceScheduler.setInteractionState({
      cameraState: 'moving',
      pointerInteractionActive: false
    }));
    await act(async () => previewResourceScheduler.setInteractionState({
      cameraState: 'idle',
      pointerInteractionActive: false
    }));

    expect(commitCount).toBe(0);
  });

  it('publishes a source error that resolves while Canvas interaction is active', async () => {
    const node = videoNode('media/error-during-pan.mp4', 'rev-a');
    const sourceResponse = deferred<Awaited<ReturnType<WorkbenchActions['readCanvasVideoPreviewSources']>>>();
    const previewResourceScheduler = createImmediateScheduler();
    await renderVideoPreviewProvider({
      nodes: [node],
      actions: {
        readCanvasVideoPreviewSources: () => sourceResponse.promise
      } as unknown as WorkbenchActions,
      previewResourceScheduler,
      children: <PreviewProbe node={node} />
    });

    await act(async () => previewResourceScheduler.setInteractionState({
      cameraState: 'moving',
      pointerInteractionActive: false
    }));
    await act(async () => sourceResponse.resolve({
      sources: {
        [node.projectRelativePath]: {
          projectRelativePath: node.projectRelativePath,
          videoRevision: 'rev-a',
          currentTimeSeconds: 0,
          status: 'error',
          sourceKind: 'initial-poster',
          message: 'poster failed during pan'
        }
      }
    }));
    expect(container?.querySelector('[data-preview-error]')).toBeNull();

    await act(async () => previewResourceScheduler.setInteractionState({
      cameraState: 'idle',
      pointerInteractionActive: false
    }));

    expect(container?.querySelector('[data-preview-error]')?.getAttribute('data-preview-error')).toBe(
      'poster failed during pan'
    );
  });

  it('publishes a changed source identity that resolves while Canvas interaction is active', async () => {
    const node = videoNode('media/source-during-pan.mp4', 'rev-a');
    const nextSourceResponse = deferred<Awaited<ReturnType<WorkbenchActions['readCanvasVideoPreviewSources']>>>();
    let sourceRequestCount = 0;
    const readCanvasVideoPreviewSources = vi.fn<WorkbenchActions['readCanvasVideoPreviewSources']>(async (input) => (
      (sourceRequestCount += 1) === 1
        ? {
            sources: Object.fromEntries(input.targets.map((target) => [
              target.projectRelativePath,
              {
                ...target,
                status: 'available' as const,
                sourceKind: 'initial-poster' as const,
                sourceKey: 'source-a',
                sourceWidth: 1200
              }
            ]))
          }
        : nextSourceResponse.promise
    ));
    const previewResourceScheduler = createImmediateScheduler();
    const renderResult = await renderVideoPreviewProvider({
      nodes: [node],
      actions: { readCanvasVideoPreviewSources } as unknown as WorkbenchActions,
      previewResourceScheduler,
      children: <PreviewProbe node={node} />
    });
    await act(async () => undefined);
    expect(container?.querySelector('[data-preview-src]')?.getAttribute('data-preview-src')).toContain(
      'sourceKey=source-a'
    );

    await renderResult.rerender([{ ...node }]);
    expect(readCanvasVideoPreviewSources).toHaveBeenCalledTimes(2);
    await act(async () => previewResourceScheduler.setInteractionState({
      cameraState: 'moving',
      pointerInteractionActive: false
    }));
    await act(async () => nextSourceResponse.resolve({
      sources: {
        [node.projectRelativePath]: {
          projectRelativePath: node.projectRelativePath,
          videoRevision: 'rev-a',
          currentTimeSeconds: 0,
          status: 'available',
          sourceKind: 'initial-poster',
          sourceKey: 'source-b',
          sourceWidth: 1200
        }
      }
    }));
    expect(container?.querySelector('[data-preview-src]')?.getAttribute('data-preview-src')).toContain(
      'sourceKey=source-a'
    );

    await act(async () => previewResourceScheduler.setInteractionState({
      cameraState: 'idle',
      pointerInteractionActive: false
    }));

    expect(container?.querySelector('[data-preview-src]')?.getAttribute('data-preview-src')).toContain(
      'sourceKey=source-b'
    );
  });

  it('exposes source errors for the current video target', async () => {
    const node = videoNode('media/a.mp4', 'rev-a');
    await renderVideoPreviewProvider({
      nodes: [node],
      actions: {
        readCanvasVideoPreviewSources: async (input: CanvasVideoPreviewSourceRequest) => ({
          sources: Object.fromEntries(input.targets.map((target) => [
            target.projectRelativePath,
            {
              ...target,
              status: 'error' as const,
              sourceKind: 'initial-poster' as const,
              message: 'poster is broken'
            }
          ]))
        })
      } as unknown as WorkbenchActions,
      children: <PreviewProbe node={node} />
    });

    await act(async () => undefined);

    expect(container?.querySelector('[data-preview-error]')?.getAttribute('data-preview-error')).toBe('poster is broken');
  });

  it('exposes a protocol error when source readiness omits a requested video target', async () => {
    const node = videoNode('media/a.mp4', 'rev-a');
    await renderVideoPreviewProvider({
      nodes: [node],
      actions: {
        readCanvasVideoPreviewSources: async () => ({ sources: {} })
      } as unknown as WorkbenchActions,
      children: <PreviewProbe node={node} />
    });

    await act(async () => undefined);

    expect(container?.querySelector('[data-preview-error]')?.getAttribute('data-preview-error')).toBe(
      'Canvas video preview source response is missing media/a.mp4.'
    );
  });

  it('rechecks source readiness when the Canvas projection refreshes with the same video revision and timestamp', async () => {
    const node = videoNode('media/a.mp4', 'rev-a');
    const readCanvasVideoPreviewSources = vi.fn(async (input: CanvasVideoPreviewSourceRequest) => ({
      sources: Object.fromEntries(input.targets.map((target) => [
        target.projectRelativePath,
        readCanvasVideoPreviewSources.mock.calls.length === 1
          ? {
              ...target,
              status: 'error' as const,
              sourceKind: 'initial-poster' as const,
              message: 'poster is broken'
            }
          : {
              ...target,
              status: 'available' as const,
              sourceKind: 'initial-poster' as const,
              sourceKey: 'v1--explicit--poster-rev-b',
              sourceWidth: 1200
            }
      ]))
    }));
    const renderResult = await renderVideoPreviewProvider({
      nodes: [node],
      actions: {
        readCanvasVideoPreviewSources
      } as unknown as WorkbenchActions,
      children: <PreviewProbe node={node} />
    });
    await act(async () => undefined);
    expect(container?.querySelector('[data-preview-error]')?.getAttribute('data-preview-error')).toBe('poster is broken');

    await renderResult.rerender([{ ...node }]);
    await act(async () => undefined);

    expect(readCanvasVideoPreviewSources).toHaveBeenCalledTimes(2);
    expect(container?.querySelector('[data-preview-error]')).toBeNull();
    expect(container?.querySelector('[data-preview-src]')?.getAttribute('data-preview-src')).toContain('sourceKey=v1--explicit--poster-rev-b');
  });

  it('exposes inactive image load failures as preview errors for the current source', async () => {
    const node = videoNode('media/a.mp4', 'rev-a');
    await renderVideoPreviewProvider({
      nodes: [node],
      actions: {
        readCanvasVideoPreviewSources: async (input: CanvasVideoPreviewSourceRequest) => ({
          sources: Object.fromEntries(input.targets.map((target) => [
            target.projectRelativePath,
            {
              ...target,
              status: 'available' as const,
              sourceKind: 'initial-poster' as const,
              sourceKey: 'v1--explicit--poster',
              sourceWidth: 1200
            }
          ]))
        })
      } as unknown as WorkbenchActions,
      children: <PreviewImageFailureProbe node={node} />
    });

    await act(async () => undefined);
    await act(async () => undefined);

    expect(container?.querySelector('[data-preview-error]')?.getAttribute('data-preview-error')).toBe('Video preview image failed to load.');
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

function VideoPreviewRenderCountProbe({
  node,
  renders
}: {
  node: ProjectedCanvasNode;
  renders: Map<string, number>;
}): React.ReactElement {
  useCanvasVideoPreviewNode(node);
  renders.set(node.projectRelativePath, (renders.get(node.projectRelativePath) ?? 0) + 1);
  return <div />;
}

async function renderVideoPreviewProvider(input: {
  nodes: ProjectedCanvasNode[];
  actions: WorkbenchActions;
  children: React.ReactNode;
  interactionActive?: boolean | undefined;
  previewResourceScheduler?: CanvasPreviewResourceScheduler | undefined;
  onRender?: React.ProfilerOnRenderCallback | undefined;
}): Promise<{
  rerender(
    nodes: ProjectedCanvasNode[],
    interactionActive?: boolean
  ): Promise<void>;
}> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const activeVideoPaths = new Set<string>();
  const previewResourceScheduler = input.previewResourceScheduler ?? createImmediateScheduler();
  const render = (
    nodes: ProjectedCanvasNode[],
    interactionActive = input.interactionActive ?? false
  ) => {
    previewResourceScheduler.setInteractionState({
      cameraState: interactionActive ? 'moving' : 'idle',
      pointerInteractionActive: false
    });
    const previewOrder = previewOrderSource();
    const tree = (
      <CanvasVideoPreviewProvider
        canvasId="canvas-1"
        nodes={nodes}
        activeVideoPaths={activeVideoPaths}
        actions={input.actions}
        resourceZoom={0.1}
        devicePixelRatio={2}
        previewOrder={previewOrder}
        previewResourceScheduler={previewResourceScheduler}
      >
        {input.children}
      </CanvasVideoPreviewProvider>
    );
    root?.render(input.onRender ? (
      <React.Profiler id="canvas-video-preview-provider" onRender={input.onRender}>
        {tree}
      </React.Profiler>
    ) : tree);
  };
  await act(async () => {
    render(input.nodes);
  });
  return {
    rerender: async (nodes, interactionActive) => {
      await act(async () => {
        render(nodes, interactionActive);
      });
    }
  };
}

function PreviewProbe({ node }: { node: ProjectedCanvasNode }): React.ReactElement {
  const { preview, previewError: error } = useCanvasVideoPreviewNode(node);
  return (
    <div>
      {preview ? <span data-preview-src={preview.src} /> : null}
      {error ? <span data-preview-error={error} /> : null}
    </div>
  );
}

function PreviewImageFailureProbe({ node }: { node: ProjectedCanvasNode }): React.ReactElement {
  const runtime = useCanvasVideoPreviewRuntime();
  const { preview, previewError: error } = useCanvasVideoPreviewNode(node);
  React.useEffect(() => {
    if (preview) {
      runtime.reportPreviewError({
        projectRelativePath: node.projectRelativePath,
        preview,
        message: 'Video preview image failed to load.'
      });
    }
  }, [node.projectRelativePath, preview, runtime]);
  return (
    <div>
      {preview ? <span data-preview-src={preview.src} /> : null}
      {error ? <span data-preview-error={error} /> : null}
    </div>
  );
}

function createImmediateScheduler(): CanvasPreviewResourceScheduler {
  let interaction: ReturnType<CanvasPreviewResourceScheduler['getInteractionState']> = {
    cameraState: 'idle',
    pointerInteractionActive: false
  };
  const interactionListeners = new Set<Parameters<
    CanvasPreviewResourceScheduler['subscribeInteraction']
  >[0]>();
  return {
    enqueue: (request: CanvasPreviewResourceRequest) => {
      if (request.isCurrent()) {
        request.run();
      }
    },
    enqueuePublication: (request: CanvasPreviewResourceRequest) => {
      if (request.isCurrent()) {
        request.run();
      }
    },
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
    dispose: () => undefined
  };
}

function previewOrderSource(): CanvasPreviewOrderSource {
  const snapshot = { x: 0, y: 0, width: 1000, height: 1000 };
  return {
    getPreviewOrderSnapshot: () => snapshot,
    subscribePreviewOrder: () => () => undefined
  };
}

function videoNode(projectRelativePath: string, revision: string): ProjectedCanvasNode {
  return {
    projectRelativePath,
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
      fileUrl: `/api/projects/p/files/raw/${projectRelativePath}?v=${revision}`,
      revision
    },
    videoPresentation: {
      kind: 'video',
      width: 640,
      height: 360,
      textTracks: []
    }
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}
