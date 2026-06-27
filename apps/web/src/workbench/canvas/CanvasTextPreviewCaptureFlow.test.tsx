// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { CanvasTextPreviewProvider, useCanvasTextPreviewRuntime } from './CanvasTextPreviewRuntime';

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
            ref: (element: HTMLElement | null) => setRect(element, 10)
          })
        ),
        ReactModule.createElement(
          'div',
          { className: 'cm-content' },
          ReactModule.createElement('div', {
            className: 'cm-line',
            ref: (element: HTMLElement | null) => setRect(element, 14)
          })
        )
      );
    }
  };
});

describe('CanvasTextPreviewCaptureFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
            devicePixelRatio={2}
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
