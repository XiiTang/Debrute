import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  canvasPreviewContinuityKey,
  canvasPreviewTargetIdentityFromDigest
} from '@debrute/canvas-core';
import type { ProjectedCanvasNode } from './CanvasScene';
import { EditorView } from '@codemirror/view';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import {
  CanvasNodeContent as CanvasNodeContentImplementation,
  canvasTextBufferEnsureKey,
  type CanvasNodeContentProps
} from './CanvasNodeContent';
import { CanvasTextPreviewProvider } from './CanvasTextPreviewRuntime';
import { CanvasVideoPreviewProvider } from './CanvasVideoPreviewRuntime';
import {
  CanvasRasterPreviewEnvironmentProvider,
  type CanvasRasterPreviewRequest
} from './CanvasRasterPreviewPresentation';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import type { CanvasPreviewOrderSource } from './CanvasRenderLifecycle';
import * as CanvasTextEditorRuntime from './CanvasTextEditorRuntime';
import * as TextEditorLanguages from './textEditorCodeMirrorLanguages';
import { I18nProvider } from '../i18n';

vi.mock('./CanvasTextRenderProfileContext', async () => {
  const { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } = await import('./CanvasTextRenderProfile.test-support');
  return {
    useCanvasTextRenderProfile: () => DEFAULT_CANVAS_TEXT_RENDER_PROFILE,
    CanvasTextRenderProfileGate: ({ children }: { children: React.ReactNode }) => <>{children}</>
  };
});

vi.mock('./font-subset/CanvasTextProjectFontEnvironment', () => ({
  useCanvasTextProjectFontEnvironment: () => ({
    previewSession: {
      prepareCoverage: async () => {
        const preparedFont = { resourceIdentity: 'test', embeddedFaces: [] };
        return { activate: () => preparedFont, discard: () => undefined };
      },
      dispose: () => undefined
    },
    setPreviewMetricsObserver: () => undefined
  })
}));

vi.mock('./CanvasTextPreviewStyleKey', () => ({
  canvasTextPreviewStyleSnapshotForDocument: () => ({ color: '#fff' }),
  canvasTextPreviewStyleKey: async () => 'sha256:style'
}));

const previewResourceInteraction = { cameraState: 'idle' as const, pointerInteractionActive: false };
const previewResourceScheduler: CanvasPreviewResourceScheduler = {
  enqueue: (request) => request.run(),
  enqueuePublication: (request) => request.run(),
  cancel: () => undefined,
  setInteractionState: () => undefined,
  getInteractionState: () => previewResourceInteraction,
  subscribeInteraction: () => () => undefined,
  dispose: () => undefined
};

const previewOrderSnapshot = { x: 0, y: 0, width: 1000, height: 1000 };
const previewOrder: CanvasPreviewOrderSource = {
  getPreviewOrderSnapshot: () => previewOrderSnapshot,
  subscribePreviewOrder: () => () => undefined
};
const sourceNodeReader = {
  getNode: () => undefined,
  getResolvedSource: () => undefined,
  getSourceVersion: () => 0,
  subscribeSources: () => () => undefined
};

function CanvasNodeContent(
  props: Omit<CanvasNodeContentProps, 'inlineTextPresentationRequested' | 'onContentError'> & {
    inlineTextPresentationRequested?: boolean | undefined;
    onContentError?: CanvasNodeContentProps['onContentError'] | undefined;
  }
): React.ReactElement {
  return (
    <CanvasNodeContentImplementation
      {...props}
      inlineTextPresentationRequested={
        props.inlineTextPresentationRequested ?? props.contentInteractionActive
      }
      onContentError={props.onContentError ?? (() => undefined)}
    />
  );
}

function TestProviders({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <I18nProvider locale="en">
      <CanvasRasterPreviewEnvironmentProvider value={{
        resourceZoomSource: {
          getSnapshot: () => 1,
          subscribe: () => () => undefined
        },
        devicePixelRatio: 1,
        previewResourceScheduler
      }}>
        <CanvasVideoPreviewProvider
          nodes={[]}
          sourceResolutionRuntime={sourceNodeReader}
          activeVideoPaths={new Set()}
          actions={actionsFixture()}
          previewOrder={previewOrder}
          previewResourceScheduler={previewResourceScheduler}
        >
          <CanvasTextPreviewProvider
            nodes={[]}
            sourceResolutionRuntime={sourceNodeReader}
            textFileBuffers={{}}
            actions={actionsFixture()}
            previewOrder={previewOrder}
            styleDependencyKey="test"
            previewResourceScheduler={previewResourceScheduler}
          >
            {children}
          </CanvasTextPreviewProvider>
        </CanvasVideoPreviewProvider>
      </CanvasRasterPreviewEnvironmentProvider>
    </I18nProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderStaticWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <TestProviders>
      {element}
    </TestProviders>
  );
}

describe('CanvasNodeContent', () => {
  it('renders the project root directory with a non-empty label', () => {
    const html = renderStaticWithI18n(
      <CanvasNodeContent
        node={directoryNode('', 'disclosed')}
        contentInteractionActive
        actions={actionsFixture()}
        textBuffer={undefined}
        onVideoPlayerMounted={() => undefined}
        onVideoPlayingChange={() => undefined}
        onRegisterVideoTarget={() => undefined}
        onUpdateVideoPlaybackTime={() => undefined}
        onUpdateTextViewport={() => undefined}
      />
    );

    expect(html).toContain('ecommerce');
    expect(html).toContain('data-debrute-icon="folder-open"');
  });

  it('renders a generic node label once in the normal state', () => {
    const html = renderStaticWithI18n(
      <CanvasNodeContent
        node={directoryNode('references/archive', 'collapsed')}
        contentInteractionActive
        actions={actionsFixture()}
        textBuffer={undefined}
        onVideoPlayerMounted={() => undefined}
        onVideoPlayingChange={() => undefined}
        onRegisterVideoTarget={() => undefined}
        onUpdateVideoPlaybackTime={() => undefined}
        onUpdateTextViewport={() => undefined}
      />
    );

    expect(html).toContain('<strong class="db-canvas-node-generic__label">archive</strong>');
    expect(html).toContain('db-canvas-node-generic');
    expect(html).not.toContain('db-canvas-node-generic--wrap');
    expect(html).not.toContain('<span>archive</span>');
    expect(html).toContain('data-debrute-icon="folder"');
    expect(html).not.toContain('data-debrute-icon="folder-open"');
  });

  it('renders a disclosed empty directory with the open folder glyph', () => {
    const html = renderStaticWithI18n(
      <CanvasNodeContent
        node={directoryNode('empty', 'disclosed')}
        contentInteractionActive
        actions={actionsFixture()}
        textBuffer={undefined}
        onVideoPlayerMounted={() => undefined}
        onVideoPlayingChange={() => undefined}
        onRegisterVideoTarget={() => undefined}
        onUpdateVideoPlaybackTime={() => undefined}
        onUpdateTextViewport={() => undefined}
      />
    );

    expect(html).toContain('data-debrute-icon="folder-open"');
  });

  it('marks manually taller generic nodes for bounded label wrapping', () => {
    const html = renderStaticWithI18n(
      <CanvasNodeContent
        node={{
          ...directoryNode('references/very-long-directory-name-that-needs-wrapping', 'collapsed'),
          width: 2200,
          height: 1000,
          layoutMode: 'manual'
        }}
        contentInteractionActive
        actions={actionsFixture()}
        textBuffer={undefined}
        onVideoPlayerMounted={() => undefined}
        onVideoPlayingChange={() => undefined}
        onRegisterVideoTarget={() => undefined}
        onUpdateVideoPlaybackTime={() => undefined}
        onUpdateTextViewport={() => undefined}
      />
    );

    expect(html).toContain('db-canvas-node-generic db-canvas-node-generic--wrap');
    expect(html).toContain('<strong class="db-canvas-node-generic__label">very-long-directory-name-that-needs-wrapping</strong>');
  });

  it('keeps the generic node label as error context when unavailable', () => {
    const html = renderStaticWithI18n(
      <CanvasNodeContent
        node={unavailableDirectoryNode('references/archive', 'Unable to read references/archive.')}
        contentInteractionActive
        actions={actionsFixture()}
        textBuffer={undefined}
        onVideoPlayerMounted={() => undefined}
        onVideoPlayingChange={() => undefined}
        onRegisterVideoTarget={() => undefined}
        onUpdateVideoPlaybackTime={() => undefined}
        onUpdateTextViewport={() => undefined}
      />
    );

    expect(html).toContain('<strong>Missing File</strong>');
    expect(html).toContain('db-canvas-node-generic db-canvas-node-generic--problem');
    expect(html).toContain('<span>Unable to read references/archive.</span>');
    expect(html).toContain('<span class="db-canvas-node-generic__label">archive</span>');
  });

  describe('Canvas text editor chrome', { tags: ['canvas-text'] }, () => {
    it('loads available text nodes as live CodeMirror editors on demand', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(
            <TestProviders>
              <CanvasNodeContent
                node={textNode('flow/readme.md', 'rev-a')}
                contentInteractionActive
                actions={actionsFixture()}
                textBuffer={textBuffer('flow/readme.md', 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={() => undefined}
              />
            </TestProviders>
          );
        });
        const editor = await waitForElement(container, '.canvas-text-editor');
        expect(container.querySelector('.db-canvas-node-titlebar')).not.toBeNull();
        expect(container.querySelector('.canvas-text-body')?.getAttribute('data-canvas-local-wheel')).toBe('focus');
        expect(container.querySelector('[title="Open large editor"]')).not.toBeNull();
        expect(editor.getAttribute('data-editor-engine')).toBe('codemirror');
        expect(editor.getAttribute('data-editor-mode')).toBe('edit');
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });
  });

  describe('Canvas video title chrome', { tags: ['canvas-video'] }, () => {
    it('marks the video title bar as the stable Node Manipulation Region', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(
            <TestProviders>
              <CanvasNodeContent
                node={videoNode('media/clip.mp4', 'rev-a')}
                contentInteractionActive={false}
                actions={actionsFixture()}
                textBuffer={undefined}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={() => undefined}
              />
            </TestProviders>
          );
        });

        const titleBar = container.querySelector<HTMLElement>('.db-canvas-node-titlebar');
        expect(titleBar).not.toBeNull();
        expect(titleBar?.getAttribute('data-canvas-node-zone')).toBe('manipulation');
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      }
    });
  });

  describe('Canvas text preview and editor lifecycle', { tags: ['canvas-text'] }, () => {
    beforeAll(() => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const view = new EditorView({ parent: host });
      const decodeDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
      Object.defineProperty(HTMLImageElement.prototype, 'decode', {
        configurable: true,
        value: vi.fn(async () => undefined)
      });

      return () => {
        view.destroy();
        host.remove();
        if (decodeDescriptor) {
          Object.defineProperty(HTMLImageElement.prototype, 'decode', decodeDescriptor);
        } else {
          Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
        }
      };
    });

    it('uses the committed pointerup activation coordinates as the mounted editor caret request', async () => {
      const frameCallbacks: FrameRequestCallback[] = [];
      const restoreAnimationFrame = installAnimationFrameQueue(frameCallbacks);
      const posAtCoords = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(3);
      vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({
        left: 144,
        right: 144,
        top: 88,
        bottom: 104
      });
      vi.spyOn(EditorView.prototype, 'defaultLineHeight', 'get').mockReturnValue(18);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const onContentHandoffConsumed = vi.fn();
      const renderNode = async (contentInteractionActive: boolean, handoffRequest?: CanvasNodeContentProps['contentHandoffRequest']) => {
        await act(async () => {
          root.render(
            <TestProviders>
              <CanvasNodeContent
                node={textNode('flow/readme.md', 'rev-a')}
                contentInteractionActive={contentInteractionActive}
                actions={actionsFixture()}
                textBuffer={textBuffer('flow/readme.md', 'rev-a')}
                textPreviewRequest={textPreviewRequest()}
                contentHandoffRequest={handoffRequest}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onContentHandoffConsumed={onContentHandoffConsumed}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={() => undefined}
              />
            </TestProviders>
          );
        });
      };

      try {
        await renderNode(false);

        expect(container.querySelector('.canvas-text-body')?.getAttribute('data-canvas-node-zone')).toBe('content');
        expect(posAtCoords).not.toHaveBeenCalled();

        await renderNode(true, {
          requestId: 11,
          projectRelativePath: 'flow/readme.md',
          kind: 'text-caret',
          clientX: 144,
          clientY: 96
        });
        await waitForElement(container, '.canvas-text-editor');

        await act(async () => {
          flushAnimationFrames(frameCallbacks);
        });

        expect(posAtCoords).toHaveBeenCalledWith({ x: 144, y: 96 });
        expect(onContentHandoffConsumed).toHaveBeenCalledOnce();
        expect(onContentHandoffConsumed).toHaveBeenCalledWith(11);
        await renderNode(true, {
          requestId: 11,
          projectRelativePath: 'flow/readme.md',
          kind: 'text-caret',
          clientX: 144,
          clientY: 96
        });
        expect(onContentHandoffConsumed).toHaveBeenCalledOnce();
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
        restoreAnimationFrame();
      }
    });

    it('keeps the preview visible until the content-active editor layout is ready', async () => {
      const frameCallbacks: FrameRequestCallback[] = [];
      const restoreAnimationFrame = installAnimationFrameQueue(frameCallbacks);
      const ensureVisibleSyntaxReady = vi.spyOn(
        CanvasTextEditorRuntime,
        'canvasTextEditorEnsureVisibleSyntaxReady'
      ).mockReturnValue(false);
      const posAtCoords = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(3);
      vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({
        left: 144,
        right: 144,
        top: 88,
        bottom: 104
      });
      vi.spyOn(EditorView.prototype, 'defaultLineHeight', 'get').mockReturnValue(18);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const preview = textPreviewRequest();
      const renderNode = (
        contentInteractionActive: boolean,
        contentHandoffRequest?: CanvasNodeContentProps['contentHandoffRequest']
      ) => renderTextPreviewNode(root, preview, { contentInteractionActive, contentHandoffRequest });

      try {
        await renderNode(false);
        await renderNode(true, {
          requestId: 12,
          projectRelativePath: 'flow/readme.md',
          kind: 'text-caret',
          clientX: 144,
          clientY: 96
        });
        const preparingEditor = await waitForElement<HTMLElement>(container, '.canvas-text-editor');

        expect(container.querySelector('.canvas-raster-preview-layers')?.getAttribute(
          'data-canvas-raster-preview-hidden'
        )).toBe('false');
        expect(preparingEditor.getAttribute('data-editor-published')).toBe('false');
        expect(preparingEditor.hasAttribute('inert')).toBe(true);
        expect(posAtCoords).not.toHaveBeenCalled();

        await act(async () => {
          container.querySelector<HTMLElement>('.canvas-text-body')?.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 180,
            clientY: 120
          }));
        });
        expect(posAtCoords).not.toHaveBeenCalled();

        ensureVisibleSyntaxReady.mockReturnValue(true);
        await act(async () => {
          flushAnimationFrames(frameCallbacks);
        });

        expect(container.querySelector('.canvas-raster-preview-layers')?.getAttribute(
          'data-canvas-raster-preview-hidden'
        )).toBe('true');
        expect(preparingEditor.getAttribute('data-editor-published')).toBe('true');
        expect(preparingEditor.hasAttribute('inert')).toBe(false);
        expect(posAtCoords).toHaveBeenCalledWith({ x: 144, y: 96 });
        await act(async () => {
          flushAnimationFrames(frameCallbacks);
        });
      } finally {
        await act(async () => root.unmount());
        container.remove();
        restoreAnimationFrame();
      }
    });

    it('retires a sole-selected read-only editor only after its current preview is ready', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const preview = textPreviewRequest();

      try {
        await renderTextPreviewNode(root, preview);
        await renderTextPreviewNode(root, preview, {
          inlineTextPresentationRequested: true
        });
        const readEditor = await waitForElement<HTMLElement>(container, '[data-editor-mode="read"]');
        await vi.waitFor(() => expect(readEditor.getAttribute('data-editor-published')).toBe('true'));
        expect(container.querySelector('.canvas-raster-preview-layers')?.getAttribute(
          'data-canvas-raster-preview-hidden'
        )).toBe('true');

        await renderTextPreviewNode(root, preview, {
          inlineTextPresentationRequested: false
        });
        await vi.waitFor(() => expect(container.querySelector('.canvas-text-editor')).toBeNull());
        expect(container.querySelector('.canvas-raster-preview-layers')?.getAttribute(
          'data-canvas-raster-preview-hidden'
        )).toBe('false');
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });

    it('discards an unpublished editor when content interaction ends before layout is ready', async () => {
      const frameCallbacks: FrameRequestCallback[] = [];
      const restoreAnimationFrame = installAnimationFrameQueue(frameCallbacks);
      const ensureVisibleSyntaxReady = vi.spyOn(
        CanvasTextEditorRuntime,
        'canvasTextEditorEnsureVisibleSyntaxReady'
      ).mockReturnValue(false);
      const posAtCoords = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(3);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const preview = textPreviewRequest();
      const renderNode = (contentInteractionActive: boolean) => renderTextPreviewNode(root, preview, { contentInteractionActive });

      try {
        await renderNode(false);
        await act(async () => {
          container.querySelector<HTMLElement>('.canvas-text-body')?.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 144,
            clientY: 96
          }));
        });
        await renderNode(true);
        await waitForElement(container, '.canvas-text-editor');

        await renderNode(false);

        expect(container.querySelector('.canvas-text-editor')).toBeNull();
        expect(container.querySelector('.canvas-raster-preview-layers')?.getAttribute(
          'data-canvas-raster-preview-hidden'
        )).toBe('false');

        ensureVisibleSyntaxReady.mockReturnValue(true);
        await act(async () => {
          flushAnimationFrames(frameCallbacks);
        });

        expect(container.querySelector('.canvas-text-editor')).toBeNull();
        expect(container.querySelector('.canvas-raster-preview-layers')?.getAttribute(
          'data-canvas-raster-preview-hidden'
        )).toBe('false');
        expect(posAtCoords).not.toHaveBeenCalled();

        await renderNode(true);
        await waitForElement(container, '.canvas-text-editor');
        await act(async () => {
          flushAnimationFrames(frameCallbacks);
        });

        expect(posAtCoords).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        container.remove();
        restoreAnimationFrame();
      }
    });

    it('keeps the preview visible under an explicit editor activation failure', async () => {
      const failure = new Error('language chunk unavailable');
      vi.spyOn(
        TextEditorLanguages,
        'loadCodeMirrorLanguageExtensionForProjectTextLanguage'
      ).mockRejectedValue(failure);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const preview = textPreviewRequest();

      try {
        await expectEditorActivationFailure(root, container, preview, failure.message);
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });

    it('keeps the preview visible when initial editor layout throws', async () => {
      const failure = new Error('editor viewport layout failed');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const destroyEditor = vi.spyOn(EditorView.prototype, 'destroy');
      vi.spyOn(
        CanvasTextEditorRuntime,
        'canvasTextEditorApplyInitialScroll'
      ).mockImplementation(() => {
        throw failure;
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const preview = textPreviewRequest();

      try {
        await expectEditorActivationFailure(root, container, preview, failure.message);
        expect(destroyEditor).toHaveBeenCalledOnce();
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });

    it('keeps the preview visible when visible syntax preparation throws', async () => {
      const failure = new Error('visible syntax preparation failed');
      vi.spyOn(
        CanvasTextEditorRuntime,
        'canvasTextEditorEnsureVisibleSyntaxReady'
      ).mockImplementation(() => {
        throw failure;
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const preview = textPreviewRequest();

      try {
        await expectEditorActivationFailure(root, container, preview, failure.message);
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });

    it('unmounts the retained editor when the current preview handoff fails', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      try {
        await renderTextPreviewNode(root, undefined, { contentInteractionActive: true });
        expect(container.querySelector('.cm-editor')).not.toBeNull();

        await renderTextPreviewNode(root, undefined, {
          contentInteractionActive: false,
          textPreviewError: 'Canvas text preview raster failed.'
        });

        expect(container.querySelector('.cm-editor')).toBeNull();
        expect(container.textContent).toContain('Canvas text preview raster failed.');
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      }
    });

    it('renders text preview render errors instead of an empty preview body', () => {
      const html = renderStaticWithI18n(
        <CanvasNodeContent
          node={textNode('flow/readme.md', 'rev-a')}
          contentInteractionActive={false}
          actions={actionsFixture()}
          textBuffer={textBuffer('flow/readme.md', 'rev-a')}
          textPreviewError="Canvas text preview source capture did not produce a PNG blob."
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={() => undefined}
        />
      );

      expect(html).toContain('Canvas text preview source capture did not produce a PNG blob.');
      expect(html).toContain('Text Preview Error');
      expect(html).not.toContain('canvas-text-preview-empty');
      expect(html).not.toContain('data-canvas-text-editor="true"');
    });

    it('opens the content-active text editor at the persisted text viewport position', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const node: ProjectedCanvasNode = {
        ...textNode('flow/readme.md', 'rev-a'),
        textViewport: { scrollTop: 72, scrollLeft: 9 }
      };

      try {
        await act(async () => {
          root.render(
            <TestProviders>
              <CanvasNodeContent
                node={node}
                contentInteractionActive
                actions={actionsFixture()}
                textBuffer={textBuffer(node.projectRelativePath, 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={() => undefined}
              />
            </TestProviders>
          );
        });

        const scroller = container.querySelector<HTMLElement>('.cm-scroller');
        expect(scroller?.scrollTop).toBe(72);
        expect(scroller?.scrollLeft).toBe(9);
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      }
    });

    it('commits the content-active text editor scroll position when the editor blurs and unmounts without duplicates', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const node = textNode('flow/readme.md', 'rev-a');
      const onUpdateTextViewport = vi.fn();

      try {
        await act(async () => {
          root.render(
            <TestProviders>
              <CanvasNodeContent
                node={node}
                contentInteractionActive
                actions={actionsFixture()}
                textBuffer={textBuffer(node.projectRelativePath, 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={onUpdateTextViewport}
              />
            </TestProviders>
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
          container.querySelector<HTMLElement>('.canvas-text-editor')?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        });

        expect(onUpdateTextViewport).toHaveBeenLastCalledWith(node.projectRelativePath, { scrollTop: 72, scrollLeft: 9 });
        expect(onUpdateTextViewport).toHaveBeenCalledTimes(1);

        await act(async () => {
          root.render(
            <TestProviders>
              <CanvasNodeContent
                node={node}
                contentInteractionActive={false}
                actions={actionsFixture()}
                textBuffer={textBuffer(node.projectRelativePath, 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={onUpdateTextViewport}
              />
            </TestProviders>
          );
        });

        expect(onUpdateTextViewport).toHaveBeenCalledTimes(1);

        const persistedNode: ProjectedCanvasNode = {
          ...node,
          textViewport: { scrollTop: 72, scrollLeft: 9 }
        };

        await act(async () => {
          root.render(
            <TestProviders>
              <CanvasNodeContent
                node={persistedNode}
                contentInteractionActive
                actions={actionsFixture()}
                textBuffer={textBuffer(node.projectRelativePath, 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={onUpdateTextViewport}
              />
            </TestProviders>
          );
        });

        const remountedScroller = container.querySelector<HTMLElement>('.cm-scroller');
        expect(remountedScroller).not.toBeNull();
        if (!remountedScroller) {
          throw new Error('Expected remounted CodeMirror scroller.');
        }

        remountedScroller.scrollTop = 84;
        remountedScroller.scrollLeft = 11;
        await act(async () => {
          container.querySelector<HTMLElement>('.canvas-text-editor')?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
          remountedScroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          container.querySelector<HTMLElement>('.canvas-text-editor')?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        });
        await act(async () => {
          root.render(
            <TestProviders>
              <CanvasNodeContent
                node={persistedNode}
                contentInteractionActive={false}
                actions={actionsFixture()}
                textBuffer={textBuffer(node.projectRelativePath, 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={onUpdateTextViewport}
              />
            </TestProviders>
          );
        });

        expect(onUpdateTextViewport).toHaveBeenLastCalledWith(node.projectRelativePath, { scrollTop: 84, scrollLeft: 11 });
        expect(onUpdateTextViewport).toHaveBeenCalledTimes(2);
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      }
    });

    it('commits the content-active text editor scroll position when content interaction ends before preview handoff', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const node = textNode('flow/readme.md', 'rev-a');
      const onUpdateTextViewport = vi.fn();
      const renderNode = async (contentInteractionActive: boolean) => {
        await act(async () => {
          root.render(
            <TestProviders>
              <CanvasNodeContent
                node={node}
                contentInteractionActive={contentInteractionActive}
                actions={actionsFixture()}
                textBuffer={textBuffer(node.projectRelativePath, 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={onUpdateTextViewport}
              />
            </TestProviders>
          );
        });
      };

      try {
        await renderNode(true);

        const scroller = container.querySelector<HTMLElement>('.cm-scroller');
        expect(scroller).not.toBeNull();
        if (!scroller) {
          throw new Error('Expected CodeMirror scroller.');
        }

        scroller.scrollTop = 96;
        scroller.scrollLeft = 12;
        await act(async () => {
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        });

        await renderNode(false);

        expect(onUpdateTextViewport).toHaveBeenLastCalledWith(node.projectRelativePath, { scrollTop: 96, scrollLeft: 12 });
        expect(onUpdateTextViewport).toHaveBeenCalledTimes(1);
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      }
    });

    it('keeps text bodies focus-gated for Canvas wheel routing', () => {
      const html = renderStaticWithI18n(
        <CanvasNodeContent
          node={textNode('flow/readme.md', 'rev-a')}
          contentInteractionActive={false}
          actions={actionsFixture()}
          textBuffer={textBuffer('flow/readme.md', 'rev-a')}
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={() => undefined}
        />
      );

      expect(html).toContain('class="canvas-text-body"');
      expect(html).toContain('data-canvas-local-wheel="focus"');
    });
  });

  it('keeps the Audio Content and Manipulation Regions structurally stable across activation', () => {
    const audioNode = {
      ...imageNode('audio/theme.mp3', 'rev-a'),
      mediaKind: 'audio' as const,
      availability: {
        state: 'available' as const,
        revision: 'rev-a',
        size: 10_000,
        mimeType: 'audio/mpeg',
        fileUrl: '/api/workbench/bindings/p/files/raw/audio/theme.mp3?v=rev-a'
      }
    };
    const inactiveHtml = renderStaticWithI18n(
      <CanvasNodeContent
        node={audioNode}
        contentInteractionActive={false}
        actions={actionsFixture()}
        textBuffer={undefined}
        onVideoPlayerMounted={() => undefined}
        onVideoPlayingChange={() => undefined}
        onRegisterVideoTarget={() => undefined}
        onUpdateVideoPlaybackTime={() => undefined}
        onUpdateTextViewport={() => undefined}
      />
    );
    const activeHtml = renderStaticWithI18n(
      <CanvasNodeContent
        node={audioNode}
        contentInteractionActive
        actions={actionsFixture()}
        textBuffer={undefined}
        onVideoPlayerMounted={() => undefined}
        onVideoPlayingChange={() => undefined}
        onRegisterVideoTarget={() => undefined}
        onUpdateVideoPlaybackTime={() => undefined}
        onUpdateTextViewport={() => undefined}
      />
    );

    expect(inactiveHtml).toContain('data-canvas-node-zone="content"');
    expect(inactiveHtml).toContain('data-canvas-node-zone="manipulation"');
    expect(inactiveHtml).not.toContain('inert=""');
    expect(activeHtml).toContain('data-canvas-node-zone="content"');
    expect(activeHtml).toContain('data-canvas-node-zone="manipulation"');
    expect(activeHtml).not.toContain('inert=""');
  });

  describe('Canvas text status', { tags: ['canvas-text'] }, () => {
    it('renders external text changes with the shared info status tone only', () => {
      const html = renderStaticWithI18n(
        <CanvasNodeContent
          node={textNode('flow/readme.md', 'rev-a')}
          contentInteractionActive
          actions={actionsFixture()}
          textBuffer={{ ...textBuffer('flow/readme.md', 'rev-a'), externalChange: true }}
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={() => undefined}
        />
      );

      expect(html).toContain('External change');
      expect(html).toContain('db-status-pill--info');
      expect(html).not.toMatch(/\b(?:dirty|external|saved|saving|loading|error)\b(?=[^"]*"[^>]*>External change)/);
    });

    it('does not render the default saved text state as a status pill', () => {
      const html = renderStaticWithI18n(
        <CanvasNodeContent
          node={textNode('flow/readme.md', 'rev-a')}
          contentInteractionActive
          actions={actionsFixture()}
          textBuffer={textBuffer('flow/readme.md', 'rev-a')}
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={() => undefined}
        />
      );

      expect(html).not.toContain('Saved');
    });
  });
});

describe('CanvasNodeContent text buffer ensure keys', { tags: ['canvas-text'] }, () => {
  it('returns the path only while an available text node has no buffer', () => {
    expect(canvasTextBufferEnsureKey(
      textNode('flow/readme.md', 'rev-a'),
      undefined,
      true
    )).toBe('flow/readme.md');
  });

  it('requests text content only for a live inline presentation', () => {
    const node = textNode('flow/readme.md', 'rev-a');
    expect(canvasTextBufferEnsureKey(node, undefined, false)).toBeUndefined();
    expect(canvasTextBufferEnsureKey(node, undefined, true)).toBe('flow/readme.md');
  });

  it('skips ensure whenever the current text buffer is already loaded', () => {
    expect(canvasTextBufferEnsureKey(textNode('flow/readme.md', 'rev-a'), textBuffer('flow/readme.md', 'rev-a'), true)).toBeUndefined();
    expect(canvasTextBufferEnsureKey(textNode('flow/readme.md', 'rev-b'), textBuffer('flow/readme.md', 'rev-a'), true)).toBeUndefined();
  });

  it('loads an editor buffer when the text node becomes the sole-selected presentation', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const ensureTextFileBuffer = vi.fn(async () => undefined);
    const renderNode = (input: {
      contentInteractionActive: boolean;
      inlineTextPresentationRequested: boolean;
    }) => (
      <TestProviders>
        <CanvasNodeContent
          node={textNode('flow/readme.md', 'rev-a')}
          contentInteractionActive={input.contentInteractionActive}
          inlineTextPresentationRequested={input.inlineTextPresentationRequested}
          actions={actionsFixture({ ensureTextFileBuffer })}
          textBuffer={undefined}
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={() => undefined}
        />
      </TestProviders>
    );
    try {
      await act(async () => root.render(renderNode({
        contentInteractionActive: false,
        inlineTextPresentationRequested: false
      })));
      expect(ensureTextFileBuffer).not.toHaveBeenCalled();

      await act(async () => root.render(renderNode({
        contentInteractionActive: true,
        inlineTextPresentationRequested: false
      })));
      expect(ensureTextFileBuffer).not.toHaveBeenCalled();

      await act(async () => root.render(renderNode({
        contentInteractionActive: false,
        inlineTextPresentationRequested: true
      })));
      expect(ensureTextFileBuffer).toHaveBeenCalledOnce();
      expect(ensureTextFileBuffer).toHaveBeenCalledWith('flow/readme.md');

      await act(async () => root.render(renderNode({
        contentInteractionActive: true,
        inlineTextPresentationRequested: true
      })));
      expect(ensureTextFileBuffer).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

function textNode(path: string, revision: string): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    displayName: path.split('/').at(-1)!,
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
      fileUrl: `/api/workbench/bindings/p/files/raw/${path}?v=${revision}`,
      revision
    }
  };
}

function videoNode(path: string, revision: string): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    displayName: path.split('/').at(-1)!,
    nodeKind: 'file',
    mediaKind: 'video',
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    z: 0,
    availability: {
      state: 'available',
      size: 10_000,
      mimeType: 'video/mp4',
      fileUrl: `/api/workbench/bindings/p/files/raw/${path}?v=${revision}`,
      revision
    },
    videoMetadata: {
      width: 640,
      height: 360,
      durationSeconds: 12
    }
  };
}

function textBuffer(path: string, revision: string): TextFileBuffer {
  return {
    projectRelativePath: path,
    content: '# Notes',
    language: 'markdown',
    wordWrap: false,
    dirty: false,
    saving: false,
    baseRevision: revision,
    externalChange: false
  };
}

async function renderTextPreviewNode(
  root: Root,
  textPreviewRequest: CanvasRasterPreviewRequest | undefined,
  options?: {
    contentInteractionActive?: boolean | undefined;
    inlineTextPresentationRequested?: boolean | undefined;
    textPreviewError?: string | undefined;
    contentHandoffRequest?: CanvasNodeContentProps['contentHandoffRequest'] | undefined;
    node?: ProjectedCanvasNode | undefined;
    onContentError?: CanvasNodeContentProps['onContentError'] | undefined;
    onUpdateTextViewport?: CanvasNodeContentProps['onUpdateTextViewport'] | undefined;
  }
): Promise<void> {
  const contentInteractionActive = options?.contentInteractionActive ?? false;
  const inlineTextPresentationRequested = options?.inlineTextPresentationRequested
    ?? contentInteractionActive;
  await act(async () => {
    root.render(
      <TestProviders>
        <CanvasNodeContent
          node={options?.node ?? textNode('flow/readme.md', 'rev-a')}
          contentInteractionActive={contentInteractionActive}
          inlineTextPresentationRequested={inlineTextPresentationRequested}
          actions={actionsFixture()}
          textBuffer={textBuffer('flow/readme.md', 'rev-a')}
          textPreviewRequest={textPreviewRequest}
          textPreviewError={options?.textPreviewError}
          contentHandoffRequest={options?.contentHandoffRequest}
          onContentError={options?.onContentError}
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={options?.onUpdateTextViewport ?? (() => undefined)}
        />
      </TestProviders>
    );
  });
  const pending = document.querySelector<HTMLImageElement>(
    'img[data-canvas-raster-preview-layer="pending"]'
  );
  if (pending) {
    await act(async () => pending.dispatchEvent(new Event('load')));
    await act(async () => undefined);
  }
}

async function expectEditorActivationFailure(
  root: Root,
  container: HTMLElement,
  preview: CanvasRasterPreviewRequest,
  message: string
): Promise<void> {
  await renderTextPreviewNode(root, preview, { contentInteractionActive: false });
  await renderTextPreviewNode(root, preview, { contentInteractionActive: true });
  const overlay = await waitForElement<HTMLElement>(container, '.canvas-content-error');

  expect(overlay.textContent).toContain(message);
  expect(overlay.textContent).toContain('Click to retry');
  expect(overlay.querySelector('button')).toBeNull();
  expect(container.querySelector('.canvas-raster-preview-layers')?.getAttribute(
    'data-canvas-raster-preview-hidden'
  )).toBe('false');
  expect(container.querySelector('[data-canvas-text-editor="true"]')).toBeNull();
}

function textPreviewRequest(
  targetIdentityDigest = 'sha256:preview'
): CanvasRasterPreviewRequest {
  const targetIdentity = canvasPreviewTargetIdentityFromDigest(targetIdentityDigest);
  return {
    continuityKey: canvasPreviewContinuityKey({
      mediaKind: 'text',
      bindingId: 'p',
      projectRelativePath: 'flow/readme.md',
      continuityIdentity: targetIdentity
    }),
    variantTarget: {
      mediaKind: 'text',
      bindingId: 'p',
      projectRelativePath: 'flow/readme.md',
      targetIdentity,
      sourceWidth: 700,
      srcForWidth: (width) => `/api/workbench/bindings/p/canvas-text-preview?path=flow%2Freadme.md&targetIdentity=${targetIdentity}&w=${width}`
    }
  };
}

function installAnimationFrameQueue(frameCallbacks: FrameRequestCallback[]): () => void {
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
    value: () => undefined
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

function flushAnimationFrames(frameCallbacks: FrameRequestCallback[]): void {
  const callbacks = frameCallbacks.splice(0);
  callbacks.forEach((callback) => callback(0));
}

async function waitForElement<T extends Element>(
  container: ParentNode,
  selector: string
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const element = container.querySelector<T>(selector);
    if (element) {
      return element;
    }
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  throw new Error(`Expected ${selector}.`);
}

function actionsFixture(overrides: Partial<WorkbenchActions> = {}): WorkbenchActions {
  return {
    ensureTextFileBuffer: async () => undefined,
    saveTextFileBuffer: async () => undefined,
    discardTextFileBuffer: async () => undefined,
    openTextEditorWindow: () => undefined,
    updateTextFileBuffer: () => undefined,
    toggleTextFileWordWrap: () => undefined,
    ...overrides
  } as unknown as WorkbenchActions;
}

function imageNode(path: string, revision: string): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    displayName: path.split('/').at(-1)!,
    nodeKind: 'file',
    mediaKind: 'image',
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    z: 0,
    availability: {
      state: 'available',
      revision,
      size: 10_000,
      mimeType: 'image/png',
      fileUrl: `/api/workbench/bindings/p/files/raw/${path}?v=${revision}`,
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: 1600
    }
  };
}

function directoryNode(
  path: string,
  folderDisclosure: 'collapsed' | 'disclosed'
): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    displayName: path ? path.split('/').at(-1)! : 'ecommerce',
    nodeKind: 'directory',
    folderDisclosure,
    x: 0,
    y: 0,
    width: 240,
    height: 96,
    z: 0,
    availability: { state: 'directory' }
  };
}

function unavailableDirectoryNode(path: string, message: string): ProjectedCanvasNode {
  return {
    ...directoryNode(path, 'collapsed'),
    availability: {
      state: 'missing',
      message
    }
  };
}
