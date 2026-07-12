import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CanvasTextEditor } from './CanvasTextEditor';
import { canvasTextEditorApplyFocusRequest } from './CanvasTextEditorRuntime';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CanvasTextEditor', { tags: ['canvas-text'] }, () => {
  it('renders the final CodeMirror editor root marker', () => {
    const html = renderToStaticMarkup(
      <CanvasTextEditor
        value="# Notes"
        language="markdown"
        wordWrap={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onToggleWordWrap={() => undefined}
      />
    );

    expect(html).toContain('data-canvas-text-editor="true"');
    expect(html).toContain('data-editor-engine="codemirror"');
    expect(html).toContain('canvas-text-editor');
  });

  it('marks the live editor as edit mode', () => {
    const html = renderToStaticMarkup(
      <CanvasTextEditor
        value="# Notes"
        language="markdown"
        wordWrap={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onToggleWordWrap={() => undefined}
      />
    );

    expect(html).toContain('data-editor-mode="edit"');
  });

  it('accepts visible state without changing the editor mode marker', () => {
    const html = renderToStaticMarkup(
      <CanvasTextEditor
        value="# Notes"
        language="markdown"
        wordWrap={false}
        visible={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onToggleWordWrap={() => undefined}
      />
    );

    expect(html).toContain('data-editor-mode="edit"');
    expect(html).not.toContain(`data-editor-mode="${'pre'}${'view'}"`);
  });

  it('uses shared text surface CSS variables', () => {
    const html = renderToStaticMarkup(
      <CanvasTextEditor
        value="# Notes"
        language="markdown"
        wordWrap={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onToggleWordWrap={() => undefined}
      />
    );

    expect(html).toContain('--canvas-text-editor-line-height:16.8px');
    expect(html).toContain('--canvas-text-editor-line-padding-inline:8px');
  });

  it('exposes the word wrap state for styling and diagnostics', () => {
    const html = renderToStaticMarkup(
      <CanvasTextEditor
        value="# Notes"
        language="markdown"
        wordWrap
        onChange={() => undefined}
        onSave={() => undefined}
        onToggleWordWrap={() => undefined}
      />
    );

    expect(html).toContain('data-word-wrap="on"');
  });

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
        root.render(
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
        );
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

    canvasTextEditorApplyFocusRequest({
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
        root.render(
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
        );
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
        root.render(
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
        );
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
        root.render(
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
        );
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
        root.render(
          <CanvasTextEditor
            value="# Notes"
            language="markdown"
            wordWrap={false}
            onChange={() => undefined}
            onSave={() => undefined}
            onToggleWordWrap={() => undefined}
            onScrollPositionCommit={onScrollPositionCommit}
          />
        );
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
        root.render(<Harness active />);
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
        root.render(<Harness active={false} />);
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
