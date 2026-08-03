import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CanvasTextEditor } from './CanvasTextEditor';
import * as CanvasTextEditorRuntime from './CanvasTextEditorRuntime.js';
import { CanvasTextRenderProfileGate } from './CanvasTextRenderProfileContext.js';
import { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } from './CanvasTextRenderProfile.test-support.js';

const environmentMock = vi.hoisted(() => ({
  prepareInteractive: vi.fn(async () => undefined)
}));

vi.mock('./font-subset/CanvasTextProjectFontEnvironment.js', () => ({
  useCanvasTextProjectFontEnvironment: () => environmentMock
}));

const TEST_CANVAS_TEXT_RENDER_PROFILE = DEFAULT_CANVAS_TEXT_RENDER_PROFILE;

afterEach(() => {
  vi.restoreAllMocks();
  environmentMock.prepareInteractive.mockClear();
});

describe('CanvasTextEditor', { tags: ['canvas-text'] }, () => {
  it('applies a focus request after the first-click focus sequence', async () => {
    const frameCallbacks: Array<FrameRequestCallback | undefined> = [];
    const restoreAnimationFrame = installAnimationFrameQueue(frameCallbacks);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(4);
    vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({
      left: 140,
      right: 140,
      top: 88,
      bottom: 104
    });
    vi.spyOn(EditorView.prototype, 'defaultLineHeight', 'get').mockReturnValue(18);

    try {
      await act(async () => {
        root.render(withRenderProfile(
          <CanvasTextEditor
            value="# Notes"
            language="markdown"
            wordWrap={false}
            visible={false}
            focusRequest={{ requestId: 1, clientX: 140, clientY: 96 }}
            onChange={() => undefined}
            onSave={() => undefined}
            onToggleWordWrap={() => undefined}
          />
        ));
      });

      const content = container.querySelector('.cm-content');
      expect(document.activeElement).not.toBe(content);
      expect(container.querySelector('.canvas-text-editor')?.getAttribute('data-pointer-focus')).toBe('false');

      await act(async () => {
        flushAnimationFrames(frameCallbacks);
      });

      expect(document.activeElement).toBe(content);
      expect(container.querySelector('.canvas-text-editor')?.getAttribute('data-pointer-focus')).toBe('true');
      expect(container.querySelector('.cm-cursorLayer')).not.toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
    }
  });

  it('applies pointer focus selection without requesting editor scrolling', () => {
    const state = EditorState.create({ doc: 'abcdef' });
    const focus = vi.fn();
    const dispatch = vi.fn();

    CanvasTextEditorRuntime.canvasTextEditorApplyFocusRequest({
      state,
      documentTop: 0,
      defaultLineHeight: 18,
      focus,
      dispatch,
      posAtCoords: () => 4,
      coordsAtPos: () => ({ top: 88, bottom: 104 }),
      lineBlockAtHeight: () => ({ from: 0, to: 6, top: 0, height: 18 })
    }, { requestId: 1, clientX: 140, clientY: 96 });

    expect(focus).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const transaction = dispatch.mock.calls[0]?.[0];
    expect(transaction?.selection?.main.head).toBe(4);
    expect(transaction?.scrollIntoView).toBe(false);
  });

  it('leaves edit focus immediately when the editor enters preview handoff', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(withRenderProfile(
          <CanvasTextEditor
            value="# Notes"
            language="markdown"
            wordWrap={false}
            onChange={() => undefined}
            onSave={() => undefined}
            onToggleWordWrap={() => undefined}
          />
        ));
      });

      const editorHost = container.querySelector<HTMLElement>('.canvas-text-editor');
      const content = container.querySelector<HTMLElement>('.cm-content');
      expect(editorHost).not.toBeNull();
      expect(content).not.toBeNull();
      await act(async () => {
        editorHost?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        content?.focus();
      });
      expect(editorHost?.dataset.pointerFocus).toBe('true');
      expect(document.activeElement).toBe(content);

      await act(async () => {
        root.render(withRenderProfile(
          <CanvasTextEditor
            value="# Notes"
            language="markdown"
            wordWrap={false}
            readOnly
            onChange={() => undefined}
            onSave={() => undefined}
            onToggleWordWrap={() => undefined}
          />
        ));
      });

      expect(editorHost?.dataset.editorMode).toBe('handoff');
      expect(editorHost?.dataset.pointerFocus).toBe('false');
      expect(document.activeElement).not.toBe(content);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('restores the initial scroll after the first layout frame before pointer focus settles', async () => {
    const frameCallbacks: Array<FrameRequestCallback | undefined> = [];
    const restoreAnimationFrame = installAnimationFrameQueue(frameCallbacks);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(4);
    vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({
      left: 140,
      right: 140,
      top: 88,
      bottom: 104
    });
    vi.spyOn(EditorView.prototype, 'defaultLineHeight', 'get').mockReturnValue(18);

    try {
      await act(async () => {
        root.render(withRenderProfile(
          <CanvasTextEditor
            value="# Notes"
            language="markdown"
            wordWrap={false}
            visible={false}
            initialScrollTop={72}
            initialScrollLeft={9}
            focusRequest={{ requestId: 1, clientX: 140, clientY: 96 }}
            onChange={() => undefined}
            onSave={() => undefined}
            onToggleWordWrap={() => undefined}
          />
        ));
      });

      const scroller = container.querySelector<HTMLElement>('.cm-scroller');
      expect(scroller).not.toBeNull();
      if (!scroller) {
        throw new Error('Expected CodeMirror scroller.');
      }
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;

      await act(async () => {
        flushAnimationFrames(frameCallbacks);
      });

      expect(scroller.scrollTop).toBe(72);
      expect(scroller.scrollLeft).toBe(9);
      expect(document.activeElement).toBe(container.querySelector('.cm-content'));
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
    }
  });

  it('reports an asynchronous initial viewport layout failure', async () => {
    const frameCallbacks: Array<FrameRequestCallback | undefined> = [];
    const restoreAnimationFrame = installAnimationFrameQueue(frameCallbacks);
    const failure = new Error('initial viewport frame failed');
    let applyCount = 0;
    vi.spyOn(CanvasTextEditorRuntime, 'canvasTextEditorApplyInitialScroll').mockImplementation(() => {
      applyCount += 1;
      if (applyCount === 2) {
        throw failure;
      }
    });
    const onLayoutFailure = vi.fn();
    const onLayoutReady = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(withRenderProfile(
          <CanvasTextEditor
            value="# Notes"
            language="markdown"
            wordWrap={false}
            visible
            published={false}
            initialScrollTop={72}
            initialScrollLeft={9}
            onChange={() => undefined}
            onSave={() => undefined}
            onToggleWordWrap={() => undefined}
            onLayoutReady={onLayoutReady}
            onLayoutFailure={onLayoutFailure}
          />
        ));
      });

      expect(onLayoutFailure).not.toHaveBeenCalled();

      await act(async () => {
        flushAnimationFrames(frameCallbacks);
      });

      expect(onLayoutFailure).toHaveBeenCalledOnce();
      expect(onLayoutFailure).toHaveBeenCalledWith(failure);
      expect(onLayoutReady).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      restoreAnimationFrame();
    }
  });

  it('applies a focus request once after StrictMode remounts the editor view', async () => {
    const frameCallbacks: Array<FrameRequestCallback | undefined> = [];
    const restoreAnimationFrame = installAnimationFrameQueue(frameCallbacks);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const focus = vi.spyOn(EditorView.prototype, 'focus').mockImplementation(() => undefined);
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(4);
    vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({
      left: 140,
      right: 140,
      top: 88,
      bottom: 104
    });
    vi.spyOn(EditorView.prototype, 'defaultLineHeight', 'get').mockReturnValue(18);

    try {
      await act(async () => {
        root.render(withRenderProfile(
          <React.StrictMode>
            <CanvasTextEditor
              value="# Notes"
              language="markdown"
              wordWrap={false}
              visible={false}
              focusRequest={{ requestId: 1, clientX: 140, clientY: 96 }}
              onChange={() => undefined}
              onSave={() => undefined}
              onToggleWordWrap={() => undefined}
            />
          </React.StrictMode>
        ));
      });

      expect(focus).not.toHaveBeenCalled();

      await act(async () => {
        flushAnimationFrames(frameCallbacks);
      });

      expect(focus).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
    }
  });

  it('commits the current CodeMirror scroll position', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onScrollPositionCommit = vi.fn();
    let unmounted = false;

    try {
      await act(async () => {
        root.render(withRenderProfile(
          <CanvasTextEditor
            value="# Notes"
            language="markdown"
            wordWrap={false}
            initialScrollTop={12}
            initialScrollLeft={3}
            onChange={() => undefined}
            onSave={() => undefined}
            onToggleWordWrap={() => undefined}
            onScrollPositionCommit={onScrollPositionCommit}
          />
        ));
      });

      const scroller = container.querySelector<HTMLElement>('.cm-scroller');
      expect(scroller).not.toBeNull();
      if (!scroller) {
        throw new Error('Expected CodeMirror scroller.');
      }
      expect(scroller.scrollTop).toBe(12);
      expect(scroller.scrollLeft).toBe(3);

      scroller.scrollTop = 72;
      scroller.scrollLeft = 9;

      await act(async () => {
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        container.querySelector<HTMLElement>('.canvas-text-editor')?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });

      expect(onScrollPositionCommit).toHaveBeenLastCalledWith({ scrollTop: 72, scrollLeft: 9 });

      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      await act(async () => {
        root.unmount();
      });
      unmounted = true;

      expect(onScrollPositionCommit).toHaveBeenCalledTimes(1);
      expect(onScrollPositionCommit).toHaveBeenLastCalledWith({ scrollTop: 72, scrollLeft: 9 });
    } finally {
      if (!unmounted) {
        await act(async () => {
          root.unmount();
        });
      }
      container.remove();
    }
  });

  it('commits the last observed user-visible scroll when the DOM resets before focusout', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onScrollPositionCommit = vi.fn();

    try {
      await act(async () => {
        root.render(withRenderProfile(
          <CanvasTextEditor
            value="# Notes"
            language="markdown"
            wordWrap={false}
            onChange={() => undefined}
            onSave={() => undefined}
            onToggleWordWrap={() => undefined}
            onScrollPositionCommit={onScrollPositionCommit}
          />
        ));
      });

      const scroller = container.querySelector<HTMLElement>('.cm-scroller');
      expect(scroller).not.toBeNull();
      if (!scroller) {
        throw new Error('Expected CodeMirror scroller.');
      }

      scroller.scrollTop = 72;
      scroller.scrollLeft = 9;
      await act(async () => {
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      });

      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      await act(async () => {
        container.querySelector<HTMLElement>('.canvas-text-editor')?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });

      expect(onScrollPositionCommit).toHaveBeenCalledTimes(1);
      expect(onScrollPositionCommit).toHaveBeenLastCalledWith({ scrollTop: 72, scrollLeft: 9 });
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('commits scroll before the preview handoff layout runs', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const events: string[] = [];
    const onScrollPositionCommit = vi.fn((position: { scrollTop: number; scrollLeft: number }) => {
      events.push(`commit:${position.scrollTop}:${position.scrollLeft}`);
    });

    function PreviewProbe(): React.ReactElement {
      React.useLayoutEffect(() => {
        events.push(`preview:${onScrollPositionCommit.mock.calls.length}`);
      }, []);
      return <div className="canvas-text-preview-empty" />;
    }

    function Harness({ active }: { active: boolean }): React.ReactElement {
      return active
        ? (
            <CanvasTextEditor
              value="# Notes"
              language="markdown"
              wordWrap={false}
              onChange={() => undefined}
              onSave={() => undefined}
              onToggleWordWrap={() => undefined}
              onScrollPositionCommit={onScrollPositionCommit}
            />
          )
        : <PreviewProbe />;
    }

    try {
      await act(async () => {
        root.render(withRenderProfile(<Harness active />));
      });

      const scroller = container.querySelector<HTMLElement>('.cm-scroller');
      expect(scroller).not.toBeNull();
      if (!scroller) {
        throw new Error('Expected CodeMirror scroller.');
      }
      scroller.scrollTop = 72;
      scroller.scrollLeft = 9;
      await act(async () => {
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      });

      await act(async () => {
        root.render(withRenderProfile(<Harness active={false} />));
      });

      expect(events).toEqual([
        'commit:72:9',
        'preview:1'
      ]);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});

function withRenderProfile(children: React.ReactNode): React.ReactElement {
  return (
    <CanvasTextRenderProfileGate profile={TEST_CANVAS_TEXT_RENDER_PROFILE} pending={null}>
      {children}
    </CanvasTextRenderProfileGate>
  );
}

function installAnimationFrameQueue(frameCallbacks: Array<FrameRequestCallback | undefined>): () => void {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback): number => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (handle: number) => {
      frameCallbacks[handle - 1] = undefined;
    }
  });
  return () => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalRequestAnimationFrame
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalCancelAnimationFrame
    });
  };
}

function flushAnimationFrames(frameCallbacks: Array<FrameRequestCallback | undefined>): void {
  const callbacks = frameCallbacks.splice(0);
  callbacks.forEach((callback) => callback?.(0));
}
