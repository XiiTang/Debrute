import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { CanvasVideoPreviewSourceRequest } from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../types';
import type { CanvasPreviewResourceRequest, CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import {
  CanvasVideoPreviewProvider,
  canvasVideoPreviewTargetsForNodes,
  shouldStartCanvasVideoPreviewSourceWork,
  useCanvasVideoPreviewRuntime
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
    const renderResult = await renderVideoPreviewProvider({
      nodes: [node],
      actions: { readCanvasVideoPreviewSources } as unknown as WorkbenchActions,
      interactionActive: true,
      children: <PreviewProbe node={node} />
    });

    await act(async () => undefined);
    expect(readCanvasVideoPreviewSources).not.toHaveBeenCalled();

    await renderResult.rerender([node], false);
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

  it('retains a published video preview while interaction culls and reveals the node', async () => {
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

    await renderResult.rerender(nodes, true, new Set([node.projectRelativePath]));
    expect(container?.querySelector('[data-preview-src]')?.getAttribute('data-preview-src')).toBe(previewSrc);

    await renderResult.rerender(nodes, true, new Set());
    expect(container?.querySelector('[data-preview-src]')?.getAttribute('data-preview-src')).toBe(previewSrc);
    expect(readCanvasVideoPreviewSources).toHaveBeenCalledTimes(1);
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

async function renderVideoPreviewProvider(input: {
  nodes: ProjectedCanvasNode[];
  actions: WorkbenchActions;
  children: React.ReactNode;
  interactionActive?: boolean | undefined;
}): Promise<{
  rerender(
    nodes: ProjectedCanvasNode[],
    interactionActive?: boolean,
    culledNodePaths?: ReadonlySet<string>
  ): Promise<void>;
}> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const activeVideoPaths = new Set<string>();
  const defaultCulledNodePaths = new Set<string>();
  const previewResourceScheduler = createImmediateScheduler();
  const render = (
    nodes: ProjectedCanvasNode[],
    interactionActive = input.interactionActive ?? false,
    culledNodePaths: ReadonlySet<string> = defaultCulledNodePaths
  ) => {
    root?.render(
      <CanvasVideoPreviewProvider
        canvasId="canvas-1"
        nodes={nodes}
        activeVideoPaths={activeVideoPaths}
        actions={input.actions}
        interactionActive={interactionActive}
        resourceZoom={0.1}
        devicePixelRatio={2}
        culledNodePaths={culledNodePaths}
        previewResourceScheduler={previewResourceScheduler}
      >
        {input.children}
      </CanvasVideoPreviewProvider>
    );
  };
  await act(async () => {
    render(input.nodes);
  });
  return {
    rerender: async (nodes, interactionActive, culledNodePaths) => {
      await act(async () => {
        render(nodes, interactionActive, culledNodePaths);
      });
    }
  };
}

function PreviewProbe({ node }: { node: ProjectedCanvasNode }): React.ReactElement {
  const runtime = useCanvasVideoPreviewRuntime();
  const preview = runtime.previewForNode({ node });
  const error = runtime.previewErrorForNode({ node });
  return (
    <div>
      {preview ? <span data-preview-src={preview.src} /> : null}
      {error ? <span data-preview-error={error} /> : null}
    </div>
  );
}

function PreviewImageFailureProbe({ node }: { node: ProjectedCanvasNode }): React.ReactElement {
  const runtime = useCanvasVideoPreviewRuntime();
  const preview = runtime.previewForNode({ node });
  const error = runtime.previewErrorForNode({ node });
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
  return {
    enqueue: (request: CanvasPreviewResourceRequest) => {
      if (request.isCurrent() && !request.isCulled()) {
        request.run();
      }
    },
    enqueuePublication: (request: CanvasPreviewResourceRequest) => {
      if (request.isCurrent() && !request.isCulled()) {
        request.run();
      }
    },
    cancel: () => undefined,
    setInteractionState: () => undefined,
    getInteractionState: () => ({ cameraState: 'idle', dragActive: false }),
    notifyVisibilityChanged: () => undefined,
    dispose: () => undefined
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
