// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorView } from '@codemirror/view';
import { CanvasTextEditor } from './CanvasTextEditor';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CanvasTextEditor', () => {
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
    const restoreActEnvironment = installReactActEnvironment();
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
      restoreActEnvironment();
    }
  });

  it('applies a focus request once after StrictMode remounts the editor view', async () => {
    const restoreActEnvironment = installReactActEnvironment();
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
      restoreActEnvironment();
    }
  });
});

function installReactActEnvironment(): () => void {
  const globalWithActFlag = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globalWithActFlag.IS_REACT_ACT_ENVIRONMENT;
  globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = true;
  return () => {
    if (previous === undefined) {
      delete globalWithActFlag.IS_REACT_ACT_ENVIRONMENT;
      return;
    }
    globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = previous;
  };
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
