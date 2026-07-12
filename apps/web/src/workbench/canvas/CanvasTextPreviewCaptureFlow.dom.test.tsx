import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanvasTextPreviewCaptureLane,
  isCanvasTextPreviewCaptureLayoutReady
} from './CanvasTextPreviewCaptureLane';
import { CanvasTextPreviewFailure } from './CanvasTextPreviewFailure';
import type {
  CanvasTextPreviewRasterResult,
  CanvasTextPreviewTarget
} from './CanvasTextPreviewCapture';
import type {
  CanvasTextPreviewSnapshot,
  CanvasTextPreviewSnapshotBuild
} from './CanvasTextPreviewSnapshot';

const mocks = vi.hoisted(() => ({
  createSnapshotBuild: vi.fn(),
  captureSource: vi.fn()
}));

vi.mock('./CanvasTextPreviewSnapshot', () => ({
  createCanvasTextPreviewSnapshotBuild: mocks.createSnapshotBuild
}));

vi.mock('./CanvasTextPreviewCapture', () => ({
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
        ReactModule.createElement('button', {
          'data-layout-ready': 'true',
          onClick: onLayoutReady
        }),
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
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    frames = installAnimationFrameQueue();
    layoutAligned = true;
    restoreGeometry = installCaptureGeometry(() => layoutAligned);
    mocks.createSnapshotBuild.mockReturnValue(completedSnapshotBuild());
    mocks.captureSource.mockResolvedValue({
      sourcePng: new Blob(['png'], { type: 'image/png' }),
      snapshotWidth: 320,
      snapshotHeight: 160,
      snapshotBytes: 256,
      rasterDurationMs: 2
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    frames.restore();
    restoreGeometry();
  });

  it('starts readiness, snapshot, and raster on separate eligible frames', async () => {
    const stages: string[] = [];
    const onRasterized = vi.fn();

    await renderLane({
      root,
      target: targetFixture(),
      interactionActive: false,
      onStage: (event) => stages.push(event.stage),
      onRasterized
    });

    expect(stages).toEqual([]);
    await frames.runNext();
    expect(stages).toEqual(['capture-ready']);
    await frames.runNext();
    expect(stages).toEqual(['capture-ready', 'snapshot-built']);
    expect(mocks.captureSource).not.toHaveBeenCalled();
    await frames.runNext();
    expect(stages).toEqual(['capture-ready', 'snapshot-built', 'raster-completed']);
    expect(onRasterized).toHaveBeenCalledTimes(1);
  });

  it('keeps the capture editor mounted until asynchronous raster work completes', async () => {
    const raster = deferred<CanvasTextPreviewRasterResult>();
    mocks.captureSource.mockReturnValue(raster.promise);
    const onRasterized = vi.fn();

    await renderLane({
      root,
      target: targetFixture(),
      interactionActive: false,
      onStage: () => undefined,
      onRasterized
    });
    await frames.runNext();
    await frames.runNext();
    await frames.runNext();

    expect(onRasterized).not.toHaveBeenCalled();
    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(mocks.captureSource).toHaveBeenCalledTimes(1);
    await act(async () => {
      raster.resolve({
        sourcePng: new Blob(['png'], { type: 'image/png' }),
        snapshotWidth: 320,
        snapshotHeight: 160,
        snapshotBytes: 256,
        rasterDurationMs: 2
      });
      await raster.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRasterized).toHaveBeenCalledTimes(1);
  });

  it('pauses an incremental snapshot at its cursor during interaction', async () => {
    const snapshot = snapshotFixture();
    const runSlice = vi.fn()
      .mockReturnValueOnce({ done: false })
      .mockReturnValueOnce({ done: true, snapshot });
    mocks.createSnapshotBuild.mockReturnValue({ runSlice, dispose: vi.fn() });
    const props = {
      root,
      target: targetFixture(),
      onStage: () => undefined,
      onRasterized: () => undefined
    };

    await renderLane({ ...props, interactionActive: false });
    await frames.runNext();
    await frames.runNext();
    expect(runSlice).toHaveBeenCalledTimes(1);
    expect(frames.pending()).toBe(1);

    await renderLane({ ...props, interactionActive: true });
    expect(frames.pending()).toBe(0);
    expect(mocks.createSnapshotBuild).toHaveBeenCalledTimes(1);

    await renderLane({ ...props, interactionActive: false });
    await frames.runNext();
    expect(runSlice).toHaveBeenCalledTimes(2);
    expect(mocks.createSnapshotBuild).toHaveBeenCalledTimes(1);
  });

  it('reports a typed target failure and disposes its snapshot', async () => {
    const build = completedSnapshotBuild();
    mocks.createSnapshotBuild.mockReturnValue(build);
    mocks.captureSource.mockRejectedValue(new CanvasTextPreviewFailure(
      'raster_failed',
      failureFields(),
      'Canvas text preview raster failed.'
    ));
    const onFailure = vi.fn();

    await renderLane({
      root,
      target: targetFixture(),
      interactionActive: false,
      onStage: () => undefined,
      onRasterized: () => undefined,
      onFailure
    });
    await frames.runNext();
    await frames.runNext();
    await frames.runNext();

    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ projectRelativePath: 'notes/a.md' }),
      expect.objectContaining({ stage: 'raster_failed' })
    );
    expect(build.dispose).toHaveBeenCalledTimes(1);
  });

  it('requires visible aligned CodeMirror line and gutter geometry', () => {
    const captureRoot = document.createElement('div');
    captureRoot.innerHTML = [
      '<div class="cm-scroller">',
      '<div class="cm-gutter cm-lineNumbers"><div class="cm-gutterElement">1</div></div>',
      '<div class="cm-content"><div class="cm-line">content</div></div>',
      '</div>'
    ].join('');
    const scroller = captureRoot.querySelector<HTMLElement>('.cm-scroller');
    const line = captureRoot.querySelector<HTMLElement>('.cm-line');
    const gutter = captureRoot.querySelector<HTMLElement>('.cm-gutterElement');
    expect(scroller && line && gutter).toBeTruthy();
    if (!scroller || !line || !gutter) {
      throw new Error('Expected CodeMirror fixture.');
    }
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
      interactionActive: false,
      onStage: () => undefined,
      onRasterized: () => undefined,
      onFailure
    });

    for (let frame = 0; frame < 30; frame += 1) {
      await frames.runNext();
    }

    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ projectRelativePath: 'notes/a.md' }),
      expect.objectContaining({ stage: 'snapshot_not_ready' })
    );
  });
});

async function renderLane(input: {
  root: Root;
  target: CanvasTextPreviewTarget;
  interactionActive: boolean;
  onStage: React.ComponentProps<typeof CanvasTextPreviewCaptureLane>['onStage'];
  onRasterized: React.ComponentProps<typeof CanvasTextPreviewCaptureLane>['onRasterized'];
  onFailure?: React.ComponentProps<typeof CanvasTextPreviewCaptureLane>['onFailure'];
}): Promise<void> {
  await act(async () => {
    input.root.render(
      <CanvasTextPreviewCaptureLane
        target={input.target}
        interactionActive={input.interactionActive}
        onStage={input.onStage}
        onRasterized={input.onRasterized}
        onFailure={input.onFailure ?? (() => undefined)}
      />
    );
  });
}

function targetFixture(): CanvasTextPreviewTarget {
  return {
    canvasId: 'canvas-1',
    projectRelativePath: 'notes/a.md',
    content: 'content',
    language: 'markdown',
    wordWrap: true,
    contentCssWidth: 320,
    contentCssHeight: 160,
    scrollTop: 0,
    scrollLeft: 0,
    styleKey: 'sha256:style',
    fingerprint: 'sha256:target'
  };
}

function failureFields() {
  return {
    canvasId: 'canvas-1',
    projectRelativePath: 'notes/a.md',
    fingerprint: 'sha256:target'
  };
}

function snapshotFixture(): CanvasTextPreviewSnapshot {
  const root = document.createElement('div');
  root.dataset.canvasTextPreviewSnapshot = 'true';
  root.style.width = '320px';
  root.style.height = '160px';
  root.style.overflow = 'hidden';
  return { root, width: 320, height: 160, serializedBytes: 256 };
}

function completedSnapshotBuild(): CanvasTextPreviewSnapshotBuild & { dispose: ReturnType<typeof vi.fn> } {
  const snapshot = snapshotFixture();
  return {
    runSlice: vi.fn(() => ({ done: true as const, snapshot })),
    dispose: vi.fn(() => snapshot.root.remove())
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

function setClientSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height }
  });
}

function setRect(element: Element, value: DOMRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => value
  });
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({})
  } as DOMRect;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
