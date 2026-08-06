import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  canvasPreviewContinuityKey,
  canvasPreviewTargetIdentityFromDigest
} from '@debrute/canvas-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanvasRasterPreviewEnvironmentProvider,
  useCanvasRasterPreviewPresentation,
  type CanvasRasterPreviewRequest
} from './CanvasRasterPreviewPresentation';
import type {
  CanvasPreviewResourceRequest,
  CanvasPreviewResourceScheduler
} from './CanvasPreviewResourceScheduler';

describe('CanvasRasterPreviewPresentation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let decodeDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    decodeDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: vi.fn(async () => undefined)
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    restoreProperty(HTMLImageElement.prototype, 'decode', decodeDescriptor);
  });

  it('keeps the visible variant until a decoded pending DOM image is published', async () => {
    const scheduler = createManualScheduler();
    const continuityKey = canvasPreviewContinuityKey({
      mediaKind: 'image',
      bindingId: 'project-a',
      projectRelativePath: 'flow/cover.png',
      continuityIdentity: 'sha256:source-a'
    });
    const targetIdentity = canvasPreviewTargetIdentityFromDigest('sha256:source-a');
    const request: CanvasRasterPreviewRequest = {
      continuityKey,
      variantTarget: {
        mediaKind: 'image',
        bindingId: 'project-a',
        projectRelativePath: 'flow/cover.png',
        targetIdentity,
        sourceWidth: 640,
        srcForWidth: (width) => `/preview/cover.png?w=${width}`
      }
    };

    await renderHarness(root, scheduler.value, request, 320);
    await act(async () => scheduler.runStart());
    const firstPending = imageFor(container, 'pending');
    expect(firstPending?.src).toContain('w=320');
    await act(async () => firstPending?.dispatchEvent(new Event('load')));
    await act(async () => undefined);

    const firstVisible = imageFor(container, 'visible');
    expect(firstVisible).toBe(firstPending);
    expect(firstVisible?.src).toContain('w=320');

    await renderHarness(root, scheduler.value, request, 640);
    expect(imageFor(container, 'visible')).toBe(firstVisible);
    expect(imageFor(container, 'pending')).toBeNull();

    await act(async () => scheduler.runStart());
    const secondPending = imageFor(container, 'pending');
    expect(secondPending?.src).toContain('w=640');
    expect(imageFor(container, 'visible')).toBe(firstVisible);
    const decode = vi.fn(async () => undefined);
    Object.defineProperty(secondPending, 'decode', { configurable: true, value: decode });

    await act(async () => secondPending?.dispatchEvent(new Event('load')));
    await act(async () => undefined);

    expect(decode).toHaveBeenCalledTimes(1);
    expect(imageFor(container, 'visible')).toBe(firstVisible);
    expect(imageFor(container, 'pending')).toBe(secondPending);
    expect(scheduler.publications).toHaveLength(1);

    await act(async () => scheduler.runPublication());

    expect(imageFor(container, 'visible')).toBe(secondPending);
    expect(imageFor(container, 'pending')).toBeNull();
    expect(firstVisible?.isConnected).toBe(false);
  });

  it('rejects a stale decode as soon as preview continuity changes', async () => {
    const scheduler = createManualScheduler();
    const firstRequest = previewRequest('sha256:first');
    const secondRequest = previewRequest('sha256:second');
    const decode = deferred<void>();

    await renderHarness(root, scheduler.value, firstRequest, 320);
    await act(async () => scheduler.runStart());
    const stalePending = imageFor(container, 'pending');
    Object.defineProperty(stalePending, 'decode', {
      configurable: true,
      value: () => decode.promise
    });
    await act(async () => stalePending?.dispatchEvent(new Event('load')));

    await renderHarness(root, scheduler.value, {
      continuityKey: secondRequest.continuityKey
    }, 320);
    decode.resolve(undefined);
    await act(async () => undefined);

    expect(stalePending?.isConnected).toBe(false);
    expect(imageFor(container, 'visible')).toBeNull();
    expect(imageFor(container, 'pending')).toBeNull();
  });

  it('mounts only the latest scheduled width when zoom changes repeatedly', async () => {
    const scheduler = createManualScheduler();
    const request = previewRequest('sha256:latest');
    await renderHarness(root, scheduler.value, request, 320);
    await act(async () => scheduler.runStart());
    await settlePending(container);

    await renderHarness(root, scheduler.value, request, 400);
    const staleStart = scheduler.starts[0];
    await renderHarness(root, scheduler.value, request, 640);
    expect(scheduler.starts).toHaveLength(1);
    expect(scheduler.starts[0]).not.toBe(staleStart);

    await act(async () => staleStart?.run());
    expect(imageFor(container, 'pending')).toBeNull();

    await act(async () => scheduler.starts.shift()?.run());
    expect(imageFor(container, 'pending')?.src).toContain('w=640');
    expect(imageFor(container, 'visible')?.src).toContain('w=320');
  });

  it('retains the visible width after a pending load failure and retries the same target', async () => {
    const scheduler = createManualScheduler();
    const request = previewRequest('sha256:retry');
    await renderHarness(root, scheduler.value, request, 320);
    await act(async () => scheduler.runStart());
    const firstVisible = await settlePending(container);

    await renderHarness(root, scheduler.value, request, 640);
    await act(async () => scheduler.runStart());
    const failedPending = imageFor(container, 'pending');
    await act(async () => failedPending?.dispatchEvent(new Event('error')));

    expect(imageFor(container, 'visible')).toBe(firstVisible);
    expect(container.firstElementChild?.getAttribute('data-failure-stage')).toBe('load');

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="retry"]')?.click());
    await act(async () => scheduler.runStart());
    const retryPending = imageFor(container, 'pending');
    expect(retryPending).not.toBe(failedPending);
    expect(retryPending?.src).toContain('w=640');
    await act(async () => retryPending?.dispatchEvent(new Event('load')));
    await act(async () => undefined);
    await act(async () => scheduler.runPublication());

    expect(imageFor(container, 'visible')).toBe(retryPending);
    expect(container.firstElementChild?.getAttribute('data-failure-stage')).toBe('');
  });

  it('adopts a cached complete DOM image through decode without waiting for a load event', async () => {
    const completeDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
    const naturalWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');
    Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 640 });
    try {
      const scheduler = createManualScheduler();
      await renderHarness(root, scheduler.value, previewRequest('sha256:cached'), 320);
      await act(async () => scheduler.runStart());
      await act(async () => undefined);

      expect(imageFor(container, 'visible')?.src).toContain('w=320');
      expect(imageFor(container, 'pending')).toBeNull();
    } finally {
      restoreProperty(HTMLImageElement.prototype, 'complete', completeDescriptor);
      restoreProperty(HTMLImageElement.prototype, 'naturalWidth', naturalWidthDescriptor);
    }
  });

  it('confirms the promoted DOM commit in StrictMode without animation-frame delays', async () => {
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame');
    const scheduler = createManualScheduler();
    await renderHarness(root, scheduler.value, previewRequest('sha256:strict'), 320, {
      strict: true,
      trackDomCommit: true
    });
    await act(async () => scheduler.runStart());
    await settlePending(container);

    const host = container.firstElementChild;
    expect(host?.getAttribute('data-visible-source-key')).not.toBe('');
    expect(host?.getAttribute('data-committed-source-key')).toBe(
      host?.getAttribute('data-visible-source-key')
    );
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});

function Harness({
  request,
  displayWidth,
  trackDomCommit = false
}: {
  request: CanvasRasterPreviewRequest;
  displayWidth: number;
  trackDomCommit?: boolean;
}): React.ReactElement {
  const presentation = useCanvasRasterPreviewPresentation({
    request,
    nodeDisplayWidth: displayWidth,
    fit: 'fill',
    trackDomCommit
  });
  return (
    <div
      data-status={presentation.status}
      data-visible-source-key={presentation.visibleSourceKey ?? ''}
      data-committed-source-key={presentation.committedSourceKey ?? ''}
      data-failure-stage={presentation.failure?.stage ?? ''}
    >
      {presentation.layers}
      <button type="button" data-testid="retry" onClick={presentation.retry}>Retry</button>
    </div>
  );
}

async function renderHarness(
  root: Root,
  scheduler: CanvasPreviewResourceScheduler,
  request: CanvasRasterPreviewRequest,
  displayWidth: number,
  options: { trackDomCommit?: boolean; strict?: boolean } = {}
): Promise<void> {
  const harness = (
    <Harness
      request={request}
      displayWidth={displayWidth}
      {...(options.trackDomCommit === undefined ? {} : { trackDomCommit: options.trackDomCommit })}
    />
  );
  await act(async () => {
    root.render(
      <CanvasRasterPreviewEnvironmentProvider value={{
        resourceZoom: 1,
        devicePixelRatio: 1,
        previewResourceScheduler: scheduler
      }}>
        {options.strict ? <React.StrictMode>{harness}</React.StrictMode> : harness}
      </CanvasRasterPreviewEnvironmentProvider>
    );
  });
}

function imageFor(container: ParentNode, layer: 'visible' | 'pending'): HTMLImageElement | null {
  return container.querySelector(`[data-canvas-raster-preview-layer="${layer}"]`);
}

async function settlePending(container: ParentNode): Promise<HTMLImageElement> {
  const pending = imageFor(container, 'pending');
  if (!pending) {
    throw new Error('Expected a pending Canvas raster preview image.');
  }
  await act(async () => pending.dispatchEvent(new Event('load')));
  await act(async () => undefined);
  return pending;
}

function previewRequest(identity: string): CanvasRasterPreviewRequest {
  const continuityKey = canvasPreviewContinuityKey({
    mediaKind: 'image',
    bindingId: 'project-a',
    projectRelativePath: 'flow/cover.png',
    continuityIdentity: identity
  });
  const targetIdentity = canvasPreviewTargetIdentityFromDigest(identity);
  return {
    continuityKey,
    variantTarget: {
      mediaKind: 'image',
      bindingId: 'project-a',
      projectRelativePath: 'flow/cover.png',
      targetIdentity,
      sourceWidth: 640,
      srcForWidth: (width) => `/preview/cover.png?identity=${identity}&w=${width}`
    }
  };
}

function createManualScheduler(): {
  value: CanvasPreviewResourceScheduler;
  starts: CanvasPreviewResourceRequest[];
  publications: CanvasPreviewResourceRequest[];
  runStart(): void;
  runPublication(): void;
} {
  const starts: CanvasPreviewResourceRequest[] = [];
  const publications: CanvasPreviewResourceRequest[] = [];
  return {
    starts,
    publications,
    value: {
      enqueue: (request) => coalesceRequest(starts, request),
      enqueuePublication: (request) => coalesceRequest(publications, request),
      cancel: () => undefined,
      setInteractionState: () => undefined,
      getInteractionState: () => ({ cameraState: 'idle', pointerInteractionActive: false }),
      subscribeInteraction: () => () => undefined,
      dispose: () => undefined
    },
    runStart() {
      starts.shift()?.run();
    },
    runPublication() {
      publications.shift()?.run();
    }
  };
}

function coalesceRequest(
  queue: CanvasPreviewResourceRequest[],
  request: CanvasPreviewResourceRequest
): void {
  const existingIndex = queue.findIndex((candidate) => (
    candidate.kind === request.kind && candidate.nodeId === request.nodeId
  ));
  if (existingIndex === -1) {
    queue.push(request);
  } else {
    queue[existingIndex] = request;
  }
}

function restoreProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
  } else {
    Reflect.deleteProperty(target, property);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
