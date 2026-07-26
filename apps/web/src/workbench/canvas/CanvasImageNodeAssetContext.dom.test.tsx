import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
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
    const publications: CanvasPreviewResourceRequest[] = [];
    const scheduler: CanvasPreviewResourceScheduler = {
      enqueue: () => undefined,
      enqueuePublication: (request) => publications.push(request),
      cancel: () => undefined,
      setInteractionState: () => undefined,
      getInteractionState: () => ({ cameraState: 'idle', dragActive: false }),
      notifyVisibilityChanged: () => undefined,
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
    await waitFor(() => latest(observed)?.kind === 'image' && latestImage(observed)?.next !== undefined);
    const loadKey = latestImage(observed)?.next?.loadKey;

    await act(async () => latest(observed)?.resolveNext(loadKey!));

    expect(publications).toHaveLength(1);
    expect(latestImage(observed)?.visible).toBeUndefined();
    expect(publications[0]?.isCurrent()).toBe(true);
    expect(publications[0]?.isCulled()).toBe(false);

    await act(async () => publications[0]?.run());

    expect(latestImage(observed)?.visible?.loadKey).toBe(loadKey);
  });

  it('does not rerun image resource effects when only interaction state changes', async () => {
    const publications: CanvasPreviewResourceRequest[] = [];
    let interaction: ReturnType<CanvasPreviewResourceScheduler['getInteractionState']> = {
      cameraState: 'idle',
      dragActive: false
    };
    let sourceStarts = 0;
    const scheduler: CanvasPreviewResourceScheduler = {
      enqueue: () => { sourceStarts += 1; },
      enqueuePublication: (request) => publications.push(request),
      cancel: () => undefined,
      setInteractionState: (next) => {
        interaction = next.cameraState === 'idle'
          ? { cameraState: 'idle', dragActive: next.dragActive }
          : { cameraState: 'moving', dragActive: next.dragActive };
      },
      getInteractionState: () => interaction,
      notifyVisibilityChanged: () => undefined,
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

    scheduler.setInteractionState({ cameraState: 'moving', dragActive: true });
    await act(async () => root.render(render()));

    expect(publications[0]?.isCurrent()).toBe(true);
    expect(latestImage(observed)?.next?.loadKey).toBe(loadKey);
    expect(sourceStarts).toBe(sourceStartsBeforeInteraction);
    expect(publications).toHaveLength(publicationsBeforeInteraction);
  });
});

function ImageAssetProbe({
  node,
  onState
}: {
  node: ProjectedCanvasNode;
  onState: (state: CanvasImageNodeAssetHookState) => void;
}): React.ReactElement {
  const state = useCanvasImageNodeAsset({ node, culled: false });
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
