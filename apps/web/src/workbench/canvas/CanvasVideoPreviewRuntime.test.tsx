// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { CanvasVideoPreviewSourceRequest } from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../types';
import type { CanvasPreviewResourceRequest, CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import {
  CanvasVideoPreviewProvider,
  canvasVideoPreviewTargetsForNodes,
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

describe('CanvasVideoPreviewRuntime', () => {
  it('targets inactive available video nodes and excludes active video nodes', () => {
    expect(canvasVideoPreviewTargetsForNodes({
      canvasId: 'canvas-1',
      nodes: [
        videoNode('media/a.mp4', 'rev-a'),
        videoNode('media/b.mp4', 'rev-b'),
        { ...videoNode('media/c.mp4', 'rev-c'), availability: { state: 'missing', message: 'missing' } }
      ],
      activeVideoPaths: new Set(['media/b.mp4']),
      culledNodePaths: new Set()
    })).toEqual([{
      canvasId: 'canvas-1',
      projectRelativePath: 'media/a.mp4',
      videoRevision: 'rev-a',
      currentTimeSeconds: 0
    }]);
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

async function renderVideoPreviewProvider(input: {
  nodes: ProjectedCanvasNode[];
  actions: WorkbenchActions;
  children: React.ReactNode;
}): Promise<{ rerender(nodes: ProjectedCanvasNode[]): Promise<void> }> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const render = (nodes: ProjectedCanvasNode[]) => {
    root?.render(
      <CanvasVideoPreviewProvider
        canvasId="canvas-1"
        nodes={nodes}
        activeVideoPaths={new Set()}
        actions={input.actions}
        cameraState="idle"
        dragState={undefined}
        resourceZoom={0.1}
        devicePixelRatio={2}
        culledNodePaths={new Set()}
        previewResourceScheduler={createImmediateScheduler()}
      >
        {input.children}
      </CanvasVideoPreviewProvider>
    );
  };
  await act(async () => {
    render(input.nodes);
  });
  return {
    rerender: async (nodes) => {
      await act(async () => {
        render(nodes);
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
    cancel: () => undefined,
    setInteractionState: () => undefined,
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
      fileUrl: `http://127.0.0.1:17321/api/projects/p/files/raw/${projectRelativePath}?v=${revision}`,
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
