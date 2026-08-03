import React, { act } from 'react';
import { canvasPreviewTargetIdentityFromDigest } from '@debrute/canvas-core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanvasTextPreviewCaptureLane,
  isCanvasTextPreviewCaptureLayoutReady
} from './CanvasTextPreviewCaptureLane';
import { CanvasTextPreviewFailure } from './CanvasTextPreviewFailure';
import type {
  CanvasTextPreviewCaptureTarget,
  CanvasTextPreviewCaptureResult
} from './CanvasTextPreviewCapture';
import { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } from './CanvasTextRenderProfile.test-support.js';

const TEST_RENDER_PROFILE = DEFAULT_CANVAS_TEXT_RENDER_PROFILE;
const TEST_PREPARED_FONT = {
  resourceIdentity: TEST_RENDER_PROFILE.font.identity,
  embeddedFaces: [{ family: 'test', weight: '400', css: '@font-face{}' }]
};

const mocks = vi.hoisted(() => ({
  captureSource: vi.fn()
}));

vi.mock('./CanvasTextPreviewCapture', async (importOriginal) => ({
  ...await importOriginal<typeof import('./CanvasTextPreviewCapture')>(),
  captureCanvasTextPreviewSource: mocks.captureSource
}));

vi.mock('./CanvasTextEditor', async () => {
  const ReactModule = await import('react');
  return {
    CanvasTextEditor: ({ onLayoutReady }: { onLayoutReady?: (() => void) | undefined }) => {
      ReactModule.useEffect(() => {
        onLayoutReady?.();
      }, [onLayoutReady]);
      return ReactModule.createElement(
        'div',
        { className: 'cm-editor' },
        ReactModule.createElement(
          'div',
          { className: 'cm-scroller' },
          ReactModule.createElement(
            'div',
            { className: 'cm-gutters' },
            ReactModule.createElement(
              'div',
              { className: 'cm-gutter cm-lineNumbers' },
              ReactModule.createElement('div', { className: 'cm-gutterElement' }, '1')
            )
          ),
          ReactModule.createElement(
            'div',
            { className: 'cm-content' },
            ReactModule.createElement('div', { className: 'cm-line' }, 'content')
          )
        )
      );
    }
  };
});

describe('CanvasTextPreviewCaptureLane', { tags: ['canvas-text'] }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: ReturnType<typeof installAnimationFrameQueue>;
  let restoreGeometry: () => void;
  let layoutAligned: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureSource.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    frames = installAnimationFrameQueue();
    layoutAligned = true;
    restoreGeometry = installCaptureGeometry(() => layoutAligned);
    mocks.captureSource.mockResolvedValue(rasterResult());
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    frames.restore();
    restoreGeometry();
  });

  it('checks readiness before starting one DOM capture job', async () => {
    const onRasterized = vi.fn();
    await renderLane({ root, target: targetFixture(), onRasterized });

    expect(mocks.captureSource).not.toHaveBeenCalled();
    await frames.runNext();
    expect(mocks.captureSource).not.toHaveBeenCalled();
    await frames.runNext();

    expect(mocks.captureSource).toHaveBeenCalledTimes(1);
    expect(mocks.captureSource).toHaveBeenCalledWith(expect.objectContaining({
      captureRoot: expect.any(HTMLElement),
      target: expect.objectContaining({ projectRelativePath: 'notes/a.md' }),
      signal: expect.any(AbortSignal),
      isInteractionActive: expect.any(Function)
    }));
    expect(onRasterized).toHaveBeenCalledTimes(1);
  });

  it('keeps the only capture editor mounted until DOM rasterization completes', async () => {
    const raster = deferred<CanvasTextPreviewCaptureResult>();
    mocks.captureSource.mockReturnValue(raster.promise);
    const onRasterized = vi.fn();
    await renderLane({ root, target: targetFixture(), onRasterized });
    await frames.runNext();
    await frames.runNext();

    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(onRasterized).not.toHaveBeenCalled();
    await act(async () => {
      raster.resolve(rasterResult());
      await raster.promise;
    });
    expect(onRasterized).toHaveBeenCalledTimes(1);
  });

  it('does not start DOM capture while Canvas interaction is active', async () => {
    const target = targetFixture();
    const interactionSource = createInteractionSource(true);
    await renderLane({ root, target, interactionSource, onRasterized: () => undefined });
    expect(frames.pending()).toBe(0);

    await act(async () => interactionSource.setActive(false));
    await frames.runNext();
    await frames.runNext();
    expect(mocks.captureSource).toHaveBeenCalledTimes(1);
  });

  it('aborts a replaced target and ignores its stale completion', async () => {
    const firstRaster = deferred<CanvasTextPreviewCaptureResult>();
    mocks.captureSource.mockReturnValueOnce(firstRaster.promise).mockResolvedValueOnce(rasterResult());
    const onRasterized = vi.fn();
    const first = targetFixture('notes/a.md');
    await renderLane({ root, target: first, onRasterized });
    await frames.runNext();
    await frames.runNext();
    const firstSignal = mocks.captureSource.mock.calls[0]?.[0].signal as AbortSignal;

    await renderLane({
      root,
      target: targetFixture('notes/b.md'),
      onRasterized
    });
    expect(firstSignal.aborted).toBe(true);
    await frames.runNext();
    expect(mocks.captureSource).toHaveBeenCalledTimes(1);
    await act(async () => {
      firstRaster.resolve(rasterResult());
      await firstRaster.promise;
    });
    expect(onRasterized).not.toHaveBeenCalledWith(first, expect.anything());
    await frames.runNext();
    expect(mocks.captureSource).toHaveBeenCalledTimes(2);
    expect(mocks.captureSource).toHaveBeenLastCalledWith(expect.objectContaining({
      target: expect.objectContaining({ projectRelativePath: 'notes/b.md' })
    }));
  });

  it('reports the typed DOM capture failure for the current target', async () => {
    mocks.captureSource.mockRejectedValue(new CanvasTextPreviewFailure(
      'raster_failed',
      failureFields(),
      'Canvas text preview raster failed.'
    ));
    const onFailure = vi.fn();
    await renderLane({
      root,
      target: targetFixture(),
      onRasterized: () => undefined,
      onFailure
    });
    await frames.runNext();
    await frames.runNext();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ projectRelativePath: 'notes/a.md' }),
      expect.objectContaining({ stage: 'raster_failed' })
    );
  });

  it('requires visible aligned CodeMirror line and gutter geometry', () => {
    const captureRoot = document.createElement('div');
    captureRoot.innerHTML = [
      '<div class="cm-scroller">',
      '<div class="cm-gutter cm-lineNumbers"><div class="cm-gutterElement">1</div></div>',
      '<div class="cm-content"><div class="cm-line">content</div></div>',
      '</div>'
    ].join('');
    const scroller = captureRoot.querySelector<HTMLElement>('.cm-scroller')!;
    const line = captureRoot.querySelector<HTMLElement>('.cm-line')!;
    const gutter = captureRoot.querySelector<HTMLElement>('.cm-gutterElement')!;
    setClientSize(scroller, 320, 160);
    setRect(scroller, rect(0, 0, 320, 160));
    setRect(line, rect(40, 10, 80, 20));
    setRect(gutter, rect(0, 10, 40, 20));

    expect(isCanvasTextPreviewCaptureLayoutReady(captureRoot)).toBe(true);
    setRect(gutter, rect(0, 14, 40, 20));
    expect(isCanvasTextPreviewCaptureLayoutReady(captureRoot)).toBe(false);
  });

  it('fails an invalid ready layout instead of blocking later lane work forever', async () => {
    layoutAligned = false;
    const onFailure = vi.fn();
    await renderLane({
      root,
      target: targetFixture(),
      onRasterized: () => undefined,
      onFailure
    });

    for (let frame = 0; frame < 30; frame += 1) {
      await frames.runNext();
    }
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ projectRelativePath: 'notes/a.md' }),
      expect.objectContaining({ stage: 'capture_not_ready' })
    );
  });
});

async function renderLane(input: {
  root: Root;
  target: CanvasTextPreviewCaptureTarget;
  interactionSource?: React.ComponentProps<typeof CanvasTextPreviewCaptureLane>['interactionSource'];
  onRasterized: React.ComponentProps<typeof CanvasTextPreviewCaptureLane>['onRasterized'];
  onFailure?: React.ComponentProps<typeof CanvasTextPreviewCaptureLane>['onFailure'];
}): Promise<void> {
  await act(async () => {
    input.root.render(
      <CanvasTextPreviewCaptureLane
        target={input.target}
        renderProfile={TEST_RENDER_PROFILE}
        preparedFont={TEST_PREPARED_FONT}
        interactionSource={input.interactionSource ?? createInteractionSource(false)}
        onRasterized={input.onRasterized}
        onFailure={input.onFailure ?? (() => undefined)}
      />
    );
  });
}

function createInteractionSource(initiallyActive: boolean): React.ComponentProps<
  typeof CanvasTextPreviewCaptureLane
>['interactionSource'] & { setActive(active: boolean): void } {
  let state = {
    cameraState: initiallyActive ? 'moving' as const : 'idle' as const,
    pointerInteractionActive: false
  };
  const listeners = new Set<Parameters<React.ComponentProps<
    typeof CanvasTextPreviewCaptureLane
  >['interactionSource']['subscribeInteraction']>[0]>();
  return {
    getInteractionState: () => state,
    subscribeInteraction: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setActive(active) {
      state = {
        cameraState: active ? 'moving' : 'idle',
        pointerInteractionActive: false
      };
      for (const listener of listeners) {
        listener(state);
      }
    }
  };
}

function targetFixture(projectRelativePath = 'notes/a.md'): CanvasTextPreviewCaptureTarget {
  return {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    projectRelativePath,
    content: 'content',
    contentDigest: 'sha256:content',
    estimatedBytes: 7,
    language: 'markdown',
    wordWrap: true,
    contentCssWidth: 320,
    contentCssHeight: 160,
    scrollTop: 0,
    scrollLeft: 0,
    styleKey: 'sha256:style',
    sourcePixelWidth: 1280,
    sourcePixelHeight: 640,
    sourceScale: 4,
    targetIdentity: canvasPreviewTargetIdentityFromDigest(`sha256:${projectRelativePath}`)
  };
}

function rasterResult(): CanvasTextPreviewCaptureResult {
  return {
    sourcePng: new Blob(['png'], { type: 'image/png' }),
    cssWidth: 320,
    cssHeight: 160,
    sourcePixelWidth: 1280,
    sourcePixelHeight: 640,
    snapshotDurationMs: 1,
    rasterDurationMs: 2,
    captureDurationMs: 3,
    snapshotBytes: 100,
    snapshotElementCount: 8,
    maxSynchronousSliceMs: 1
  };
}

function failureFields() {
  return {
    canvasId: 'canvas-1',
    projectRelativePath: 'notes/a.md',
    targetIdentity: canvasPreviewTargetIdentityFromDigest('sha256:notes/a.md')
  };
}

function installCaptureGeometry(layoutAligned: () => boolean): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList.contains('cm-scroller')) {
      setClientSize(this, 320, 160);
      return rect(0, 0, 320, 160);
    }
    if (this.classList.contains('cm-line')) {
      return rect(40, 10, 80, 20);
    }
    if (this.classList.contains('cm-gutterElement')) {
      return rect(0, layoutAligned() ? 10 : 14, 40, 20);
    }
    if (this.classList.contains('canvas-text-preview-capture-target')) {
      setClientSize(this, 320, 160);
      return rect(0, 0, 320, 160);
    }
    return original.call(this);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

function installAnimationFrameQueue() {
  const previousRequest = window.requestAnimationFrame;
  const previousCancel = window.cancelAnimationFrame;
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  window.requestAnimationFrame = (callback) => {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  };
  window.cancelAnimationFrame = (handle) => {
    callbacks.delete(handle);
  };
  return {
    pending: () => callbacks.size,
    async runNext() {
      const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!entry) {
        throw new Error('Expected an animation frame.');
      }
      callbacks.delete(entry[0]);
      await act(async () => {
        entry[1](performance.now());
        await Promise.resolve();
      });
    },
    restore() {
      window.requestAnimationFrame = previousRequest;
      window.cancelAnimationFrame = previousCancel;
    }
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function setClientSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height }
  });
}

function setRect(element: HTMLElement, value: DOMRect): void {
  element.getBoundingClientRect = () => value;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
}
