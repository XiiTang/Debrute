import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { canvasImageNodeSourceInputForNode } from './CanvasImageNodeAsset';
import {
  CanvasImageNodeAssetProvider,
  useCanvasImageNodeAsset,
  type CanvasImageNodeAssetHookState
} from './CanvasImageNodeAssetContext';
import type {
  CanvasPreviewResourceRequest,
  CanvasPreviewResourceScheduler
} from './CanvasPreviewResourceScheduler';

describe('CanvasImageNodeAssetContext', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('publishes a decoded image handoff through the shared resource publication scheduler', async () => {
    const starts: CanvasPreviewResourceRequest[] = [];
    const publications: CanvasPreviewResourceRequest[] = [];
    const scheduler: CanvasPreviewResourceScheduler = {
      enqueue: (request) => starts.push(request),
      enqueuePublication: (request) => publications.push(request),
      cancel: () => undefined,
      setInteractionState: () => undefined,
      getInteractionState: () => ({ cameraState: 'idle', pointerInteractionActive: false }),
      subscribeInteraction: () => () => undefined,
      dispose: () => undefined
    };
    const observed: CanvasImageNodeAssetHookState[] = [];

    await act(async () => {
      root.render(
        <CanvasImageNodeAssetProvider value={{
          resourceZoom: 0.1,
          devicePixelRatio: 1,
          previewResourceScheduler: scheduler
        }}>
          <ImageAssetProbe node={imageNode()} onState={(state) => observed.push(state)} />
        </CanvasImageNodeAssetProvider>
      );
    });
    expect(starts).toHaveLength(1);
    await act(async () => starts[0]?.run());
    await waitFor(() => latest(observed)?.kind === 'image' && latestImage(observed)?.next !== undefined);
    const loadKey = latestImage(observed)?.next?.loadKey;

    await act(async () => latest(observed)?.resolveNext(loadKey!));

    expect(publications).toHaveLength(1);
    expect(latestImage(observed)?.visible).toBeUndefined();
    expect(publications[0]?.isCurrent()).toBe(true);

    await act(async () => publications[0]?.run());

    expect(latestImage(observed)?.visible?.loadKey).toBe(loadKey);
  });

  it('does not rerun image resource effects when only interaction state changes', async () => {
    const publications: CanvasPreviewResourceRequest[] = [];
    let interaction: ReturnType<CanvasPreviewResourceScheduler['getInteractionState']> = {
      cameraState: 'idle',
      pointerInteractionActive: false
    };
    let sourceStarts = 0;
    const scheduler: CanvasPreviewResourceScheduler = {
      enqueue: (request) => {
        sourceStarts += 1;
        request.run();
      },
      enqueuePublication: (request) => publications.push(request),
      cancel: () => undefined,
      setInteractionState: (next) => {
        interaction = next.cameraState === 'idle'
          ? { cameraState: 'idle', pointerInteractionActive: next.pointerInteractionActive }
          : { cameraState: 'moving', pointerInteractionActive: next.pointerInteractionActive };
      },
      getInteractionState: () => interaction,
      subscribeInteraction: () => () => undefined,
      dispose: () => undefined
    };
    const observed: CanvasImageNodeAssetHookState[] = [];
    const node = imageNode();
    const context = {
      resourceZoom: 0.1,
      devicePixelRatio: 1,
      previewResourceScheduler: scheduler
    };
    const render = () => (
      <CanvasImageNodeAssetProvider value={context}>
        <ImageAssetProbe node={node} onState={(state) => observed.push(state)} />
      </CanvasImageNodeAssetProvider>
    );

    await act(async () => root.render(render()));
    await waitFor(() => latestImage(observed)?.next !== undefined);
    const loadKey = latestImage(observed)?.next?.loadKey;
    await act(async () => latest(observed)?.resolveNext(loadKey!));
    const sourceStartsBeforeInteraction = sourceStarts;
    const publicationsBeforeInteraction = publications.length;

    scheduler.setInteractionState({ cameraState: 'moving', pointerInteractionActive: true });
    await act(async () => root.render(render()));

    expect(publications[0]?.isCurrent()).toBe(true);
    expect(latestImage(observed)?.next?.loadKey).toBe(loadKey);
    expect(sourceStarts).toBe(sourceStartsBeforeInteraction);
    expect(publications).toHaveLength(publicationsBeforeInteraction);
  });

  it('does not republish an image source when only node geometry changes', async () => {
    const harness = createLoadedImageAssetHarness(root);
    await harness.loadInitialImage();
    const unchangedBeforeGeometryChange = harness.counterCount('image-node-url-unchanged');

    await harness.render({
      node: {
        ...harness.node(),
        x: 120,
        y: 80,
        height: 1280,
        z: 4
      }
    });

    expect(harness.counterCount('image-node-url-unchanged')).toBe(unchangedBeforeGeometryChange);
  });

  it('does not republish an image source when resize stays in the same preview tier', async () => {
    const harness = createLoadedImageAssetHarness(root);
    await harness.loadInitialImage();
    expect(harness.image()?.visible?.previewWidth).toBe(300);
    const unchangedBeforeResize = harness.counterCount('image-node-url-unchanged');

    await harness.render({
      node: {
        ...harness.node(),
        width: 2500,
        height: 1250
      }
    });

    expect(harness.image()?.visible?.previewWidth).toBe(300);
    expect(harness.counterCount('image-node-url-unchanged')).toBe(unchangedBeforeResize);
  });

  it('does not republish an image source when settled zoom stays in the same preview tier', async () => {
    const harness = createLoadedImageAssetHarness(root);
    await harness.loadInitialImage();
    expect(harness.image()?.visible?.previewWidth).toBe(300);
    const unchangedBeforeZoom = harness.counterCount('image-node-url-unchanged');

    await harness.render({ resourceZoom: 0.11 });

    expect(harness.image()?.visible?.previewWidth).toBe(300);
    expect(harness.counterCount('image-node-url-unchanged')).toBe(unchangedBeforeZoom);
  });

  it('does not republish an unchanged source when the decoded image becomes loaded', async () => {
    const harness = createLoadedImageAssetHarness(root);

    await harness.loadInitialImage();

    expect(harness.counterCount('image-node-url-unchanged')).toBe(0);
  });

  it('queues exactly one replacement when resize crosses a preview tier', async () => {
    const harness = createLoadedImageAssetHarness(root);
    await harness.loadInitialImage();

    await harness.render({
      node: {
        ...harness.node(),
        width: 3600,
        height: 1800
      }
    });

    expect(harness.sourceRequests).toHaveLength(1);
    expect(harness.sourceRequests[0]).toMatchObject({ targetWidth: 425 });
    await act(async () => harness.sourceRequests[0]?.run());
    expect(harness.image()?.next?.previewWidth).toBe(425);
  });

  it('queues a replacement when the same path and revision move to another Project URL', async () => {
    const harness = createLoadedImageAssetHarness(root);
    await harness.loadInitialImage();
    const node = harness.node();
    if (node.availability.state !== 'available') {
      throw new Error('Expected an available image fixture.');
    }

    await harness.render({
      node: {
        ...node,
        availability: {
          ...node.availability,
          fileUrl: '/api/projects/project-2/files/raw/flow/cover.png?v=rev-a'
        }
      }
    });

    expect(harness.sourceRequests).toHaveLength(1);
    await act(async () => harness.sourceRequests[0]?.run());
    expect(harness.image()?.next?.src).toContain('/api/projects/project-2/canvas-image-preview?');
  });
});

function createLoadedImageAssetHarness(root: Root) {
  const sourceRequests: CanvasPreviewResourceRequest[] = [];
  const publications: CanvasPreviewResourceRequest[] = [];
  const counters: string[] = [];
  const observed: CanvasImageNodeAssetHookState[] = [];
  const scheduler: CanvasPreviewResourceScheduler = {
    enqueue: (request) => sourceRequests.push(request),
    enqueuePublication: (request) => publications.push(request),
    cancel: () => undefined,
    setInteractionState: () => undefined,
    getInteractionState: () => ({ cameraState: 'idle', pointerInteractionActive: false }),
    subscribeInteraction: () => () => undefined,
    dispose: () => undefined
  };
  const perfMonitor = {
    recordCounter: (event: { name: string }) => counters.push(event.name)
  };
  let currentNode = imageNode();
  let currentResourceZoom = 0.1;

  const render = async (next?: {
    node?: ProjectedCanvasNode | undefined;
    resourceZoom?: number | undefined;
  }): Promise<void> => {
    currentNode = next?.node ?? currentNode;
    currentResourceZoom = next?.resourceZoom ?? currentResourceZoom;
    await act(async () => {
      root.render(
        <CanvasImageNodeAssetProvider value={{
          resourceZoom: currentResourceZoom,
          devicePixelRatio: 1,
          perfMonitor,
          previewResourceScheduler: scheduler
        }}>
          <ImageAssetProbe node={currentNode} onState={(state) => observed.push(state)} />
        </CanvasImageNodeAssetProvider>
      );
    });
  };

  return {
    sourceRequests,
    node: () => currentNode,
    image: () => latestImage(observed),
    counterCount: (name: string) => counters.filter((counter) => counter === name).length,
    render,
    loadInitialImage: async (): Promise<void> => {
      await render();
      expect(sourceRequests).toHaveLength(1);
      await act(async () => sourceRequests.shift()?.run());
      await waitFor(() => latestImage(observed)?.next !== undefined);
      const loadKey = latestImage(observed)?.next?.loadKey;
      await act(async () => latest(observed)?.resolveNext(loadKey!));
      await act(async () => publications[0]?.run());
      await waitFor(() => latestImage(observed)?.visible?.loadKey === loadKey);
    }
  };
}

function ImageAssetProbe({
  node,
  onState
}: {
  node: ProjectedCanvasNode;
  onState: (state: CanvasImageNodeAssetHookState) => void;
}): React.ReactElement {
  const state = useCanvasImageNodeAsset({
    source: canvasImageNodeSourceInputForNode(node)
  });
  useEffect(() => {
    onState(state);
  }, [onState, state]);
  return <div />;
}

function imageNode(): ProjectedCanvasNode {
  return {
    projectRelativePath: 'flow/cover.png',
    nodeKind: 'file',
    mediaKind: 'image',
    x: 0,
    y: 0,
    width: 2400,
    height: 1200,
    z: 0,
    availability: {
      state: 'available',
      revision: 'rev-a',
      size: 1000,
      mimeType: 'image/png',
      fileUrl: '/api/projects/project-1/files/raw/flow/cover.png?v=rev-a',
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: 2400
    }
  };
}

function latest<T>(items: T[]): T | undefined {
  return items.at(-1);
}

function latestImage(items: CanvasImageNodeAssetHookState[]): Extract<CanvasImageNodeAssetHookState, { kind: 'image' }> | undefined {
  const state = latest(items);
  return state?.kind === 'image' ? state : undefined;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await act(async () => Promise.resolve());
  }
  throw new Error('Timed out waiting for image asset state.');
}
