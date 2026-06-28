// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toBlob } from 'html-to-image';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import type { CanvasPreviewResourceRequest, CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import { CanvasTextPreviewProvider, useCanvasTextPreviewRuntime } from './CanvasTextPreviewRuntime';

const textEditorMockLayout = vi.hoisted(() => ({
  gutterTop: 10,
  lineTop: 14
}));

vi.mock('html-to-image', () => ({
  toBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' }))
}));

vi.mock('./CanvasTextEditor', async () => {
  const ReactModule = await import('react');

  function setRect(element: HTMLElement | null, top: number): void {
    if (!element) {
      return;
    }
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: top,
        top,
        left: 0,
        right: 24,
        bottom: top + 16.8,
        width: 24,
        height: 16.8,
        toJSON: () => ({})
      })
    });
  }

  return {
    CanvasTextEditor: ({ onLayoutReady }: { onLayoutReady?: (() => void) | undefined }) => {
      ReactModule.useEffect(() => {
        onLayoutReady?.();
      }, [onLayoutReady]);

      return ReactModule.createElement(
        'div',
        null,
        ReactModule.createElement(
          'div',
          { className: 'cm-lineNumbers' },
          ReactModule.createElement('div', {
            className: 'cm-gutterElement',
            ref: (element: HTMLElement | null) => setRect(element, textEditorMockLayout.gutterTop)
          })
        ),
        ReactModule.createElement(
          'div',
          { className: 'cm-content' },
          ReactModule.createElement('div', {
            className: 'cm-line',
            ref: (element: HTMLElement | null) => setRect(element, textEditorMockLayout.lineTop)
          })
        )
      );
    }
  };
});

describe('CanvasTextPreviewCaptureFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    textEditorMockLayout.gutterTop = 10;
    textEditorMockLayout.lineTop = 14;
  });

  it('does not save a text preview source when capture layout validation fails', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const restoreClientSize = installElementClientSize();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = textNode('notes/misaligned.md');
    const errors: Array<string | undefined> = [];
    const saveCanvasTextPreviewSource = vi.fn(async () => descriptorFor(node.projectRelativePath));

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
            imageResourceZoom={0.11}
            devicePixelRatio={2}
            culledNodePaths={new Set()}
            previewResourceScheduler={createImmediateScheduler()}
          >
            <RegisteredTextBody node={node} />
            <TextPreviewErrorProbe node={node} onError={(error) => errors.push(error)} />
          </CanvasTextPreviewProvider>
        );
      });

      const error = await waitForTextPreviewError(errors);

      expect(error).toContain('CodeMirror layout did not settle');
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

  it('cancels an active source capture when camera movement begins before capture completes', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const restoreClientSize = installElementClientSize();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = textNode('notes/cancelled.md');
    const saveCanvasTextPreviewSource = vi.fn(async () => descriptorFor(node.projectRelativePath));
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
            imageResourceZoom={0.11}
            devicePixelRatio={2}
            culledNodePaths={new Set()}
            previewResourceScheduler={createImmediateScheduler()}
          >
            <RegisteredTextBody node={node} />
          </CanvasTextPreviewProvider>
        );
      });
    };

    try {
      await render('idle');
      await waitForMockCall(toBlobMock);

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
    readCanvasTextPreviewDescriptors: async () => ({ descriptors: {} }),
    reconcileCanvasTextPreviews: async () => ({ descriptors: {} }),
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

function descriptorFor(projectRelativePath: string) {
  return {
    fingerprint: `sha256:${projectRelativePath}`,
    sourceWidth: 1280,
    sourceHeight: 640,
    contentCssWidth: 320,
    contentCssHeight: 160,
    scrollTop: 0,
    scrollLeft: 0,
    variants: [320, 640, 1280]
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
