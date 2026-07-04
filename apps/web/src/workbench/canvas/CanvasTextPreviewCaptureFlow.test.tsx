// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBlob } from 'html-to-image';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import type { CanvasPreviewResourceRequest, CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import { CanvasTextPreviewProvider, useCanvasTextPreviewRuntime } from './CanvasTextPreviewRuntime';

const textEditorMockLayout = vi.hoisted(() => ({
  scrollerTop: 0,
  gutterTop: 10,
  lineTop: 14
}));

vi.mock('html-to-image', () => ({
  toBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' }))
}));

vi.mock('./CanvasTextEditor', async () => {
  const ReactModule = await import('react');

  function setRect(element: HTMLElement | null, top: () => number): void {
    if (!element) {
      return;
    }
    const hiddenRect = {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({})
    };
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        if (isDisplayHidden(element)) {
          return hiddenRect;
        }
        const visibleTop = top();
        return {
          x: 0,
          y: visibleTop,
          top: visibleTop,
          left: 0,
          right: 24,
          bottom: visibleTop + 16.8,
          width: 24,
          height: 16.8,
          toJSON: () => ({})
        };
      }
    });
  }

  function isDisplayHidden(element: HTMLElement): boolean {
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      if (current.style.display === 'none') {
        return true;
      }
    }
    return false;
  }

  return {
    CanvasTextEditor: ({
      initialScrollTop,
      initialScrollLeft,
      onLayoutReady
    }: {
      initialScrollTop?: number | undefined;
      initialScrollLeft?: number | undefined;
      onLayoutReady?: (() => void) | undefined;
    }) => {
      ReactModule.useEffect(() => {
        onLayoutReady?.();
      }, [onLayoutReady]);

      return ReactModule.createElement(
        'div',
        null,
        ReactModule.createElement(
          'div',
          {
            className: 'cm-scroller',
            ref: (element: HTMLElement | null) => {
              if (!element) {
                return;
              }
              element.scrollTop = initialScrollTop ?? 0;
              element.scrollLeft = initialScrollLeft ?? 0;
              setRect(element, () => textEditorMockLayout.scrollerTop);
            }
          },
          ReactModule.createElement(
            'div',
            { className: 'cm-gutter cm-lineNumbers' },
            ReactModule.createElement('div', {
              className: 'cm-gutterElement',
              ref: (element: HTMLElement | null) => setRect(element, () => textEditorMockLayout.gutterTop)
            })
          ),
          ReactModule.createElement(
            'div',
            { className: 'cm-content' },
            ReactModule.createElement('div', {
              className: 'cm-line',
              ref: (element: HTMLElement | null) => setRect(element, () => textEditorMockLayout.lineTop)
            })
          )
        )
      );
    }
  };
});

describe('CanvasTextPreviewCaptureFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    textEditorMockLayout.scrollerTop = 0;
    textEditorMockLayout.gutterTop = 10;
    textEditorMockLayout.lineTop = 14;
    installTextPreviewStyleVariables();
  });

  afterEach(() => {
    clearTextPreviewStyleVariables();
  });

  it('waits for CodeMirror capture layout before saving the first source', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const restoreClientSize = installElementClientSize();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = textNode('notes/misaligned.md');
    const saveCanvasTextPreviewSource = vi.fn<WorkbenchActions['saveCanvasTextPreviewSource']>(
      async (input) => textPreviewSourceSaveResult(input)
    );

    try {
      await act(async () => {
        root.render(
          <CanvasTextPreviewProvider
            canvasId="canvas-1"
            nodes={[node]}
            selectedProjectRelativePaths={[]}
            textFileBuffers={{
              [node.projectRelativePath]: textBuffer(node.projectRelativePath, 'content')
            }}
            actions={textPreviewActionsFixture(saveCanvasTextPreviewSource)}
            cameraState="idle"
            dragState={undefined}
            resourceZoom={0.11}
            devicePixelRatio={2}
            culledNodePaths={new Set()}
            previewResourceScheduler={createImmediateScheduler()}
            styleDependencyKey="dark"
          >
            <RegisteredTextBody node={node} />
          </CanvasTextPreviewProvider>
        );
      });

      await flushReactWork();
      await flushReactWork();

      expect(saveCanvasTextPreviewSource).not.toHaveBeenCalled();

      textEditorMockLayout.lineTop = 10;
      await waitForMockCall(saveCanvasTextPreviewSource);

      expect(saveCanvasTextPreviewSource).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreClientSize();
      restoreAnimationFrame();
      restoreActEnvironment();
    }
  });

  it('cancels an active source capture when camera movement begins before capture completes', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const restoreClientSize = installElementClientSize();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = textNode('notes/cancelled.md');
    const saveCanvasTextPreviewSource = vi.fn<WorkbenchActions['saveCanvasTextPreviewSource']>(
      async (input) => textPreviewSourceSaveResult(input)
    );
    const toBlobMock = vi.mocked(toBlob);
    let resolveBlob: ((blob: Blob) => void) | undefined;
    const pendingBlob = new Promise<Blob>((resolve) => {
      resolveBlob = resolve;
    });
    textEditorMockLayout.gutterTop = 14;
    textEditorMockLayout.lineTop = 14;
    toBlobMock.mockImplementationOnce(async () => pendingBlob);

    const render = async (cameraState: 'idle' | 'moving') => {
      await act(async () => {
        root.render(
          <CanvasTextPreviewProvider
            canvasId="canvas-1"
            nodes={[node]}
            selectedProjectRelativePaths={[]}
            textFileBuffers={{
              [node.projectRelativePath]: textBuffer(node.projectRelativePath, 'content')
            }}
            actions={textPreviewActionsFixture(saveCanvasTextPreviewSource)}
            cameraState={cameraState}
            dragState={undefined}
            resourceZoom={0.11}
            devicePixelRatio={2}
            culledNodePaths={new Set()}
            previewResourceScheduler={createImmediateScheduler()}
            styleDependencyKey="dark"
          >
            <RegisteredTextBody node={node} />
          </CanvasTextPreviewProvider>
        );
      });
    };

    try {
      await render('idle');
      await waitForMockCall(toBlobMock);
      expect(container.querySelector('.canvas-text-preview-capture-layer')).toBeNull();
      expect(document.body.querySelector('.canvas-text-preview-capture-layer')).not.toBeNull();

      await render('moving');
      await act(async () => {
        resolveBlob?.(new Blob(['png'], { type: 'image/png' }));
        await Promise.resolve();
      });
      await flushReactWork();

      expect(saveCanvasTextPreviewSource).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreClientSize();
      restoreAnimationFrame();
      restoreActEnvironment();
    }
  });

  it('captures text preview sources after materializing the visible viewport', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const restoreClientSize = installElementClientSize();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node: ProjectedCanvasNode = {
      ...textNode('notes/scrolled.md'),
      textViewport: { scrollTop: 72, scrollLeft: 9 }
    };
    const saveCanvasTextPreviewSource = vi.fn<WorkbenchActions['saveCanvasTextPreviewSource']>(
      async (input) => textPreviewSourceSaveResult(input)
    );
    const toBlobMock = vi.mocked(toBlob);
    textEditorMockLayout.gutterTop = 14;
    textEditorMockLayout.lineTop = 14;

    try {
      await act(async () => {
        root.render(
          <CanvasTextPreviewProvider
            canvasId="canvas-1"
            nodes={[node]}
            selectedProjectRelativePaths={[]}
            textFileBuffers={{
              [node.projectRelativePath]: textBuffer(node.projectRelativePath, 'content')
            }}
            actions={textPreviewActionsFixture(saveCanvasTextPreviewSource)}
            cameraState="idle"
            dragState={undefined}
            resourceZoom={0.11}
            devicePixelRatio={2}
            culledNodePaths={new Set()}
            previewResourceScheduler={createImmediateScheduler()}
            styleDependencyKey="dark"
          >
            <RegisteredTextBody node={node} />
          </CanvasTextPreviewProvider>
        );
      });

      await waitForMockCall(toBlobMock);

      const [capturedElement] = toBlobMock.mock.calls[0] ?? [];
      expect(capturedElement).toBeInstanceOf(HTMLElement);
      const element = capturedElement as HTMLElement;
      const scroller = element.querySelector<HTMLElement>('.cm-scroller');
      expect(scroller?.style.overflow).toBe('hidden');
      expect(scroller?.scrollTop).toBe(0);
      expect(scroller?.scrollLeft).toBe(0);
      expect(element.querySelector<HTMLElement>('.cm-content')?.style.display).toBe('none');
      expect(element.querySelector<HTMLElement>('.cm-gutter')?.style.display).toBe('none');
      expect(element.querySelector<HTMLElement>('.canvas-text-preview-static-viewport .cm-line')).not.toBeNull();
      expect(element.querySelector<HTMLElement>('.canvas-text-preview-static-viewport .cm-gutterElement')).not.toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreClientSize();
      restoreAnimationFrame();
      restoreActEnvironment();
    }
  });
});

function RegisteredTextBody({ node }: { node: ProjectedCanvasNode }): React.ReactElement {
  const { registerTextBody } = useCanvasTextPreviewRuntime();

  React.useEffect(() => {
    const element = document.createElement('div');
    element.style.width = '320px';
    element.style.height = '160px';
    registerTextBody(node.projectRelativePath, element);
    return () => registerTextBody(node.projectRelativePath, null);
  }, [node.projectRelativePath, registerTextBody]);

  return <div />;
}

function TextPreviewErrorProbe({
  node,
  onError
}: {
  node: ProjectedCanvasNode;
  onError: (error: string | undefined) => void;
}): React.ReactElement {
  const { previewErrorForNode } = useCanvasTextPreviewRuntime();

  React.useEffect(() => {
    onError(previewErrorForNode({ node }));
  });

  return <div />;
}

function textNode(projectRelativePath: string): ProjectedCanvasNode {
  return {
    projectRelativePath,
    nodeKind: 'file',
    mediaKind: 'text',
    x: 0,
    y: 0,
    width: 3200,
    height: 1600,
    z: 0,
    availability: {
      state: 'available',
      size: 32,
      mimeType: 'text/markdown',
      fileUrl: `http://127.0.0.1:17321/api/projects/p/files/raw/${projectRelativePath}`,
      revision: 'rev-a'
    }
  };
}

function textBuffer(projectRelativePath: string, content: string): TextFileBuffer {
  return {
    projectRelativePath,
    content,
    language: 'markdown',
    wordWrap: true,
    dirty: false,
    saving: false,
    diskRevision: 'rev-a',
    externalChange: false
  };
}

function textPreviewActionsFixture(
  saveCanvasTextPreviewSource: WorkbenchActions['saveCanvasTextPreviewSource']
): WorkbenchActions {
  return {
    readCanvasTextPreviewSources: async (input: Parameters<WorkbenchActions['readCanvasTextPreviewSources']>[0]) => ({
      sources: Object.fromEntries(input.sources.map((source) => [
        source.projectRelativePath,
        {
          ...source,
          available: false
        }
      ]))
    }),
    saveCanvasTextPreviewSource
  } as unknown as WorkbenchActions;
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

function installTextPreviewStyleVariables(): void {
  document.documentElement.style.setProperty('--db-text', '#ffffff');
  document.documentElement.style.setProperty('--db-text-muted', 'rgb(255 255 255 / 72%)');
}

function clearTextPreviewStyleVariables(): void {
  document.documentElement.style.removeProperty('--db-text');
  document.documentElement.style.removeProperty('--db-text-muted');
}

function textPreviewSourceSaveResult(
  input: Parameters<WorkbenchActions['saveCanvasTextPreviewSource']>[0]
): Awaited<ReturnType<WorkbenchActions['saveCanvasTextPreviewSource']>> {
  return {
    ok: true,
    source: {
      projectRelativePath: input.projectRelativePath,
      fingerprint: input.fingerprint,
      available: true
    }
  };
}

async function waitForTextPreviewError(errors: Array<string | undefined>): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const error = [...errors].reverse().find((item): item is string => typeof item === 'string');
    if (error) {
      return error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error('Expected text preview error.');
}

async function waitForMockCall(mock: { mock: { calls: unknown[] } }): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (mock.mock.calls.length > 0) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error('Expected mock to be called.');
}

async function flushReactWork(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function installReactActEnvironment(): () => void {
  const globalWithActFlag = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globalWithActFlag.IS_REACT_ACT_ENVIRONMENT;
  globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = true;
  return () => {
    if (previous === undefined) {
      delete globalWithActFlag.IS_REACT_ACT_ENVIRONMENT;
    } else {
      globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  };
}

function installAnimationFrame(): () => void {
  const previousRequestAnimationFrame = window.requestAnimationFrame;
  const previousCancelAnimationFrame = window.cancelAnimationFrame;
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
  return () => {
    window.requestAnimationFrame = previousRequestAnimationFrame;
    window.cancelAnimationFrame = previousCancelAnimationFrame;
  };
}

function installElementClientSize(): () => void {
  const previousClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const previousClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      const width = Number.parseFloat((this as HTMLElement).style.width);
      return Number.isFinite(width) && width > 0 ? width : 320;
    }
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      const height = Number.parseFloat((this as HTMLElement).style.height);
      return Number.isFinite(height) && height > 0 ? height : 160;
    }
  });
  return () => {
    if (previousClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', previousClientWidth);
    } else {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
    if (previousClientHeight) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', previousClientHeight);
    } else {
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  };
}
