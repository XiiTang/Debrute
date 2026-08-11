import { describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  canvasPreviewContinuityKey,
  canvasPreviewTargetIdentityFromDigest
} from '@debrute/canvas-core';
import type { ProjectedCanvasNode } from './CanvasScene';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { I18nProvider } from '../i18n/index';
import { CanvasNodeContent } from './CanvasNodeContent';
import { CanvasRasterPreviewEnvironmentProvider } from './CanvasRasterPreviewPresentation';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';

const editorModuleFailure = vi.hoisted(() => new Error('editor chunk unavailable'));

vi.mock('./CanvasTextEditor', () => {
  throw editorModuleFailure;
});

vi.mock('./CanvasTextRenderProfileContext', async () => {
  const { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } = await import('./CanvasTextRenderProfile.test-support');
  return {
    useCanvasTextRenderProfile: () => DEFAULT_CANVAS_TEXT_RENDER_PROFILE,
    CanvasTextRenderProfileGate: ({ children }: { children: React.ReactNode }) => <>{children}</>
  };
});

vi.mock('./CanvasTextPreviewRuntime', () => ({
  useCanvasTextPreviewRuntime: () => ({
    retryPreview: () => undefined
  })
}));

const previewResourceScheduler: CanvasPreviewResourceScheduler = {
  enqueue: (request) => request.run(),
  enqueuePublication: (request) => request.run(),
  cancel: () => undefined,
  setInteractionState: () => undefined,
  getInteractionState: () => ({ cameraState: 'idle', pointerInteractionActive: false }),
  subscribeInteraction: () => () => undefined,
  dispose: () => undefined
};

describe('CanvasNodeContent editor feature loading', { tags: ['canvas-text'] }, () => {
  it('keeps the preview visible under an explicit editor chunk failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onContentError = vi.fn();
    const decodeDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: vi.fn(async () => undefined)
    });
    const renderNode = async (contentInteractionActive: boolean) => {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasRasterPreviewEnvironmentProvider value={{
              resourceZoomSource: {
                getSnapshot: () => 1,
                subscribe: () => () => undefined
              },
              devicePixelRatio: 1,
              previewResourceScheduler
            }}>
              <CanvasNodeContent
                node={textNode()}
                contentInteractionActive={contentInteractionActive}
                actions={actionsFixture()}
                textBuffer={textBuffer()}
                textPreviewRequest={textPreviewRequest()}
                onContentError={onContentError}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={() => undefined}
              />
            </CanvasRasterPreviewEnvironmentProvider>
          </I18nProvider>
        );
      });
    };

    try {
      await renderNode(false);
      await act(async () => container.querySelector<HTMLImageElement>(
        '[data-canvas-raster-preview-layer="pending"]'
      )?.dispatchEvent(new Event('load')));
      await act(async () => undefined);
      await renderNode(true);

      await waitFor(() => container.querySelector('.canvas-content-error') !== null);
      const overlay = container.querySelector('.canvas-content-error');
      expect(overlay?.textContent).toContain('Text Error');
      expect(overlay?.textContent).toContain('Click to retry');
      expect(overlay?.querySelector('button')).toBeNull();
      expect(overlay?.querySelector('span')?.textContent).not.toBe('');
      expect(container.querySelector('.canvas-raster-preview-layers')?.getAttribute(
        'data-canvas-raster-preview-hidden'
      )).toBe('false');
      expect(container.querySelector('[data-canvas-text-editor="true"]')).toBeNull();
      expect(onContentError).toHaveBeenCalledWith('flow/readme.md');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      consoleError.mockRestore();
      if (decodeDescriptor) {
        Object.defineProperty(HTMLImageElement.prototype, 'decode', decodeDescriptor);
      } else {
        Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
      }
    }
  });
});

function textNode(): ProjectedCanvasNode {
  return {
    projectRelativePath: 'flow/readme.md',
    displayName: 'readme.md',
    nodeKind: 'file',
    mediaKind: 'text',
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    z: 0,
    availability: {
      state: 'available',
      size: 64,
      mimeType: 'text/markdown',
      fileUrl: '/api/workbench/bindings/p/files/raw/flow/readme.md?v=rev-a',
      revision: 'rev-a'
    }
  };
}

function textBuffer(): TextFileBuffer {
  return {
    projectRelativePath: 'flow/readme.md',
    content: '# Notes',
    language: 'markdown',
    wordWrap: false,
    dirty: false,
    saving: false,
    baseRevision: 'rev-a',
    externalChange: false
  };
}

function textPreviewRequest() {
  const targetIdentity = canvasPreviewTargetIdentityFromDigest('fp');
  return {
    continuityKey: canvasPreviewContinuityKey({
      mediaKind: 'text',
      bindingId: 'p',
      projectRelativePath: 'flow/readme.md',
      continuityIdentity: targetIdentity
    }),
    variantTarget: {
      mediaKind: 'text' as const,
      bindingId: 'p',
      projectRelativePath: 'flow/readme.md',
      targetIdentity,
      sourceWidth: 700,
      srcForWidth: () => '/api/workbench/bindings/p/canvas-text-preview?path=flow%2Freadme.md'
    }
  };
}

function actionsFixture(): WorkbenchActions {
  return {
    ensureTextFileBuffer: async () => undefined,
    saveTextFileBuffer: async () => undefined,
    discardTextFileBuffer: async () => undefined,
    openTextEditorWindow: () => undefined,
    updateTextFileBuffer: () => undefined,
    toggleTextFileWordWrap: () => undefined
  } as unknown as WorkbenchActions;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  throw new Error('Timed out waiting for editor load failure.');
}
