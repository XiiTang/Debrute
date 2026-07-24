import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanvasTextPreviewImageHandoff,
  type CanvasTextPreviewPresentation
} from './CanvasTextPreviewImageHandoff';
import type { CanvasTextPreviewSource } from './CanvasTextPreviewRuntime';

describe('CanvasTextPreviewImageHandoff', { tags: ['canvas-text'] }, () => {
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

  it('keeps the visible width mounted and promotes the same pending DOM image', async () => {
    const visible = source(320);
    const pending = source(640);
    const onPendingReady = vi.fn();
    const first = await renderHandoff(root, { visible }, { onPendingReady });

    await renderHandoff(root, { visible, pending }, { onPendingReady });
    const visibleElement = imageFor(container, 'visible');
    const pendingElement = imageFor(container, 'pending');

    expect(visibleElement).toBe(first);
    expect(visibleElement?.src).toContain('w=320');
    expect(pendingElement?.src).toContain('w=640');
    const decode = vi.fn(async () => undefined);
    Object.defineProperty(pendingElement, 'decode', { configurable: true, value: decode });

    await act(async () => pendingElement?.dispatchEvent(new Event('load')));

    expect(decode).toHaveBeenCalledTimes(1);
    expect(onPendingReady).toHaveBeenCalledWith(pending);
    await renderHandoff(root, { visible: pending }, { onPendingReady });

    expect(imageFor(container, 'visible')).toBe(pendingElement);
    expect(imageFor(container, 'pending')).toBeNull();
    expect(first?.isConnected).toBe(false);
  });

  it('ignores a stale pending decode after a newer width replaces its DOM element', async () => {
    const visible = source(320);
    const stale = source(480);
    const current = source(640);
    const staleDecode = deferred<void>();
    const onPendingReady = vi.fn();

    await renderHandoff(root, { visible, pending: stale }, { onPendingReady });
    const staleElement = imageFor(container, 'pending');
    Object.defineProperty(staleElement, 'decode', {
      configurable: true,
      value: () => staleDecode.promise
    });
    await act(async () => staleElement?.dispatchEvent(new Event('load')));

    await renderHandoff(root, { visible, pending: current }, { onPendingReady });
    await act(async () => staleDecode.resolve(undefined));

    expect(staleElement?.isConnected).toBe(false);
    expect(onPendingReady).not.toHaveBeenCalledWith(stale);
  });

  it('reports an error from the promoted visible DOM image', async () => {
    const pending = source(640);
    const onPendingReady = vi.fn();
    const onVisibleFailure = vi.fn();

    await renderHandoff(root, { pending }, { onPendingReady, onVisibleFailure });
    const pendingElement = imageFor(container, 'pending');
    Object.defineProperty(pendingElement, 'decode', {
      configurable: true,
      value: async () => undefined
    });
    await act(async () => pendingElement?.dispatchEvent(new Event('load')));
    await renderHandoff(root, { visible: pending }, { onPendingReady, onVisibleFailure });
    await act(async () => pendingElement?.dispatchEvent(new Event('error')));

    expect(onVisibleFailure).toHaveBeenCalledWith(pending, expect.any(Event), 'load');
  });

  it('reports a pending image decode failure separately from a load failure', async () => {
    const pending = source(640);
    const decodeFailure = new Error('decode failed');
    const onPendingFailure = vi.fn();

    await act(async () => {
      root.render(
        <CanvasTextPreviewImageHandoff
          presentation={{ pending }}
          onPendingReady={() => undefined}
          onPendingFailure={onPendingFailure}
          onVisibleFailure={() => undefined}
          onVisibleCommitted={() => undefined}
        />
      );
    });
    const pendingElement = imageFor(container, 'pending');
    Object.defineProperty(pendingElement, 'decode', {
      configurable: true,
      value: async () => Promise.reject(decodeFailure)
    });

    await act(async () => pendingElement?.dispatchEvent(new Event('load')));

    expect(onPendingFailure).toHaveBeenCalledWith(pending, decodeFailure, 'decode');
  });

  it('reports one visible commit only after a rendering opportunity', async () => {
    const visible = source(320);
    const firstCommit = vi.fn();
    const secondCommit = vi.fn();
    const animationFrames: FrameRequestCallback[] = [];
    const restoreAnimationFrame = installAnimationFrameQueue(animationFrames);

    try {
      await renderHandoff(root, { visible }, {
        onPendingReady: () => undefined,
        onVisibleCommitted: firstCommit
      });
      await renderHandoff(root, { visible }, {
        onPendingReady: () => undefined,
        onVisibleCommitted: secondCommit
      });

      expect(firstCommit).not.toHaveBeenCalled();
      expect(secondCommit).not.toHaveBeenCalled();

      await act(async () => animationFrames.shift()?.(0));

      expect(firstCommit).not.toHaveBeenCalled();

      await act(async () => animationFrames.shift()?.(16));

      expect(firstCommit).not.toHaveBeenCalled();
      expect(secondCommit).toHaveBeenCalledTimes(1);
    } finally {
      restoreAnimationFrame();
    }
  });

  it('promotes a loaded pending image after the StrictMode effect probe', async () => {
    const pending = source(320);
    const onPendingReady = vi.fn();

    await act(async () => {
      root.render(
        <React.StrictMode>
          <CanvasTextPreviewImageHandoff
            presentation={{ pending }}
            onPendingReady={onPendingReady}
            onPendingFailure={() => undefined}
            onVisibleFailure={() => undefined}
            onVisibleCommitted={() => undefined}
          />
        </React.StrictMode>
      );
    });
    const pendingElement = imageFor(container, 'pending');
    Object.defineProperty(pendingElement, 'decode', {
      configurable: true,
      value: async () => undefined
    });

    await act(async () => pendingElement?.dispatchEvent(new Event('load')));

    expect(onPendingReady).toHaveBeenCalledWith(pending);
  });
});

async function renderHandoff(
  root: Root,
  presentation: CanvasTextPreviewPresentation,
  callbacks: {
    onPendingReady: (source: CanvasTextPreviewSource) => void;
    onVisibleFailure?: ((source: CanvasTextPreviewSource, error: unknown) => void) | undefined;
    onVisibleCommitted?: ((source: CanvasTextPreviewSource) => void) | undefined;
  }
): Promise<HTMLImageElement | null> {
  await act(async () => {
    root.render(
      <CanvasTextPreviewImageHandoff
        presentation={presentation}
        onPendingReady={callbacks.onPendingReady}
        onPendingFailure={() => undefined}
        onVisibleFailure={callbacks.onVisibleFailure ?? (() => undefined)}
        onVisibleCommitted={callbacks.onVisibleCommitted ?? (() => undefined)}
      />
    );
  });
  return imageFor(document.body, 'visible');
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function source(previewWidth: number): CanvasTextPreviewSource {
  const fingerprint = 'sha256:current';
  return {
    projectRelativePath: 'notes/readme.md',
    sourceKey: `canvas-1\u001fnotes/readme.md\u001f${fingerprint}\u001f${previewWidth}`,
    src: `/api/projects/p/canvas-text-preview?canvasId=canvas-1&path=notes%2Freadme.md&fingerprint=${fingerprint}&w=${previewWidth}`,
    previewWidth,
    fingerprint
  };
}

function imageFor(container: ParentNode, layer: 'visible' | 'pending'): HTMLImageElement | null {
  return container.querySelector<HTMLImageElement>(`img[data-canvas-text-preview-layer="${layer}"]`);
}

function installAnimationFrameQueue(callbacks: FrameRequestCallback[]): () => void {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  let nextId = 1;
  const queued = new Map<number, FrameRequestCallback>();
  window.requestAnimationFrame = (callback) => {
    const id = nextId++;
    queued.set(id, callback);
    callbacks.push((timestamp) => {
      if (queued.delete(id)) {
        callback(timestamp);
      }
    });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    queued.delete(id);
  };
  return () => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  };
}
