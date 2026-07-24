import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { EditorView } from '@codemirror/view';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import {
  CanvasImageNodePreview,
  CanvasNodeContent,
  canvasTextBufferEnsureKey,
  type CanvasNodeContentProps
} from './CanvasNodeContent';
import type { CanvasImageNodeAssetHookState } from './CanvasImageNodeAssetContext';
import {
  type CanvasTextPreviewSource
} from './CanvasTextPreviewRuntime';
import { I18nProvider } from '../i18n';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderStaticWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      {element}
    </I18nProvider>
  );
}

// @ts-expect-error CanvasNodeContent requires the video target registry dependency.
const canvasNodeContentPropsWithoutVideoRegistry: CanvasNodeContentProps = {
  node: directoryNode('type-check'),
  selected: false,
  culled: false,
  actions: actionsFixture(),
  textBuffer: undefined,
  onSelectNode: () => undefined,
  onTitlePointerDown: () => undefined,
  onTitlePointerMove: () => undefined,
  onTitlePointerUp: () => undefined
};
void canvasNodeContentPropsWithoutVideoRegistry;

describe('CanvasImageNodePreview', () => {
  it('keeps the visible image mounted while the next image preloads off-DOM', () => {
    const html = renderImagePreview({
      kind: 'image',
      visible: { src: '/preview/low.jpg', loadKey: 'low', previewWidth: 256 },
      next: { src: '/preview/high.jpg', loadKey: 'high', previewWidth: 1024 },
      retry: () => undefined,
      resolveNext: () => undefined,
      rejectNext: () => undefined
    });

    expect(html).toContain('src="/preview/low.jpg"');
    expect(html).toContain('data-canvas-image-layer="visible"');
    expect(html).toContain('data-preview-width="256"');
    expect(html).not.toContain('src="/preview/high.jpg"');
    expect(html).not.toContain('data-canvas-image-layer="next"');
  });

  it('renders only the visible layer when pan-back state already has the same loaded URL', () => {
    const html = renderImagePreview({
      kind: 'image',
      visible: { src: '/preview/loaded.jpg', loadKey: 'loaded', previewWidth: 512 },
      retry: () => undefined,
      resolveNext: () => undefined,
      rejectNext: () => undefined
    });

    expect(html).toContain('src="/preview/loaded.jpg"');
    expect(html).toContain('data-canvas-image-layer="visible"');
    expect(html).not.toContain('data-canvas-image-layer="next"');
    expect(html).not.toContain('class="canvas-node-image-reserved"');
    expect(html).not.toContain('class="db-canvas-node-placeholder"');
  });

  it('reserves the first pending image slot without flashing a placeholder', () => {
    const html = renderImagePreview({
      kind: 'image',
      next: { src: '/preview/first.jpg', loadKey: 'first', previewWidth: 512 },
      retry: () => undefined,
      resolveNext: () => undefined,
      rejectNext: () => undefined
    });

    expect(html).toContain('class="canvas-node-image-reserved"');
    expect(html).not.toContain('src="/preview/first.jpg"');
    expect(html).not.toContain('data-canvas-image-layer="next"');
    expect(html).not.toContain('data-canvas-image-layer="visible"');
    expect(html).not.toContain('class="db-canvas-node-placeholder"');
  });

  it('keeps visible image markup when next load error exists', () => {
    const html = renderImagePreview({
      kind: 'image',
      visible: { src: '/preview/low.jpg', loadKey: 'low', previewWidth: 256 },
      error: { loadKey: 'high', message: 'Unable to load flow/cover.png.' },
      retry: () => undefined,
      resolveNext: () => undefined,
      rejectNext: () => undefined
    });

    expect(html).toContain('src="/preview/low.jpg"');
    expect(html).toContain('Unable to load flow/cover.png.');
    expect(html).toContain('db-button');
    expect(html).toContain('canvas-node-error-presentation');
    expect(html).not.toContain('class="db-canvas-node-placeholder"');
  });
});

describe('CanvasNodeContent', () => {
  it('renders the project root directory with a non-empty label', () => {
    const html = renderStaticWithI18n(
      <CanvasNodeContent
        node={directoryNode('')}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={undefined}
        onVideoPlayerMounted={() => undefined}
        onVideoPlayingChange={() => undefined}
        onRegisterVideoTarget={() => undefined}
        onUpdateVideoPlaybackTime={() => undefined}
        onUpdateTextViewport={() => undefined}
        onSelectNode={() => undefined}
        onTitlePointerDown={() => undefined}
        onTitlePointerMove={() => undefined}
        onTitlePointerUp={() => undefined}
      />
    );

    expect(html).toContain('Project Root');
  });

  it('renders a generic node label once in the normal state', () => {
    const html = renderStaticWithI18n(
      <CanvasNodeContent
        node={directoryNode('references/archive')}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={undefined}
        onVideoPlayerMounted={() => undefined}
        onVideoPlayingChange={() => undefined}
        onRegisterVideoTarget={() => undefined}
        onUpdateVideoPlaybackTime={() => undefined}
        onUpdateTextViewport={() => undefined}
        onSelectNode={() => undefined}
        onTitlePointerDown={() => undefined}
        onTitlePointerMove={() => undefined}
        onTitlePointerUp={() => undefined}
      />
    );

    expect(html).toContain('<strong class="db-canvas-node-generic__label">archive</strong>');
    expect(html).toContain('db-canvas-node-generic');
    expect(html).not.toContain('db-canvas-node-generic--wrap');
    expect(html).not.toContain('<span>archive</span>');
  });

  it('marks manually taller generic nodes for bounded label wrapping', () => {
    const html = renderStaticWithI18n(
      <CanvasNodeContent
        node={{
          ...directoryNode('references/very-long-directory-name-that-needs-wrapping'),
          width: 2200,
          height: 1000,
          layoutMode: 'manual'
        }}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={undefined}
        onVideoPlayerMounted={() => undefined}
        onVideoPlayingChange={() => undefined}
        onRegisterVideoTarget={() => undefined}
        onUpdateVideoPlaybackTime={() => undefined}
        onUpdateTextViewport={() => undefined}
        onSelectNode={() => undefined}
        onTitlePointerDown={() => undefined}
        onTitlePointerMove={() => undefined}
        onTitlePointerUp={() => undefined}
      />
    );

    expect(html).toContain('db-canvas-node-generic db-canvas-node-generic--wrap');
    expect(html).toContain('<strong class="db-canvas-node-generic__label">very-long-directory-name-that-needs-wrapping</strong>');
  });

  it('keeps the generic node label as error context when unavailable', () => {
    const html = renderStaticWithI18n(
      <CanvasNodeContent
        node={unavailableDirectoryNode('references/archive', 'Unable to read references/archive.')}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={undefined}
        onVideoPlayerMounted={() => undefined}
        onVideoPlayingChange={() => undefined}
        onRegisterVideoTarget={() => undefined}
        onUpdateVideoPlaybackTime={() => undefined}
        onUpdateTextViewport={() => undefined}
        onSelectNode={() => undefined}
        onTitlePointerDown={() => undefined}
        onTitlePointerMove={() => undefined}
        onTitlePointerUp={() => undefined}
      />
    );

    expect(html).toContain('<strong>Missing File</strong>');
    expect(html).toContain('db-canvas-node-generic db-canvas-node-generic--problem');
    expect(html).toContain('<span>Unable to read references/archive.</span>');
    expect(html).toContain('<span class="db-canvas-node-generic__label">archive</span>');
  });

  describe('Canvas text editor chrome', { tags: ['canvas-text'] }, () => {
    it('renders available text nodes as live CodeMirror editors', () => {
      const html = renderStaticWithI18n(
        <CanvasNodeContent
          node={textNode('flow/readme.md', 'rev-a')}
          selected
          culled={false}
          actions={actionsFixture()}
          textBuffer={textBuffer('flow/readme.md', 'rev-a')}
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={() => undefined}
          onSelectNode={() => undefined}
          onTitlePointerDown={() => undefined}
          onTitlePointerMove={() => undefined}
          onTitlePointerUp={() => undefined}
        />
      );

      expect(html).toContain('db-canvas-node-titlebar');
      expect(html).toContain('data-canvas-local-wheel="focus"');
      expect(html).not.toContain('data-canvas-local-wheel="true"');
      expect(html).toContain('Open large editor');
      expect(html).toContain('data-editor-engine="codemirror"');
      expect(html).toContain('data-editor-mode="edit"');
      expect(html).not.toContain(`data-editor-mode="${'pre'}${'view'}"`);
    });
  });

  describe('Canvas video title chrome', { tags: ['canvas-video'] }, () => {
    it('routes video title bar pointer events through the shared Canvas node title handlers', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const onTitlePointerDown = vi.fn();

      try {
        await act(async () => {
          root.render(
            <I18nProvider locale="en">
              <CanvasNodeContent
                node={videoNode('media/clip.mp4', 'rev-a')}
                selected={false}
                culled={false}
                actions={actionsFixture()}
                textBuffer={undefined}
                videoPreview={{
                  src: 'http://127.0.0.1:17321/api/projects/p/canvas-video-preview/media%2Fclip.mp4.jpg',
                  previewWidth: 320
                }}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={() => undefined}
                onSelectNode={() => undefined}
                onTitlePointerDown={onTitlePointerDown}
                onTitlePointerMove={() => undefined}
                onTitlePointerUp={() => undefined}
              />
            </I18nProvider>
          );
        });

        const titleBar = container.querySelector<HTMLElement>('.db-canvas-node-titlebar');
        expect(titleBar).not.toBeNull();
        titleBar?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));

        expect(onTitlePointerDown).toHaveBeenCalledTimes(1);
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

      return () => {
        view.destroy();
        host.remove();
      };
    });

    it('renders inactive available text nodes as preview images', () => {
      const html = renderStaticWithI18n(
        <CanvasNodeContent
          node={textNode('flow/readme.md', 'rev-a')}
          selected={false}
          culled={false}
          actions={actionsFixture()}
          textBuffer={textBuffer('flow/readme.md', 'rev-a')}
          textPreview={{
            projectRelativePath: 'flow/readme.md',
            sourceKey: 'canvas-1\u001fflow/readme.md\u001ffp\u001f700',
            src: '/api/projects/p/canvas-text-preview?canvasId=canvas-1&path=flow%2Freadme.md&fingerprint=fp&w=700',
            previewWidth: 700,
            fingerprint: 'fp'
          }}
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={() => undefined}
          onSelectNode={() => undefined}
          onTitlePointerDown={() => undefined}
          onTitlePointerMove={() => undefined}
          onTitlePointerUp={() => undefined}
        />
      );

      expect(html).toContain('class="canvas-text-preview-image canvas-text-preview-image--visible"');
      expect(html).toContain('data-preview-width="700"');
      expect(html).not.toContain('data-canvas-text-editor="true"');
      expect(html).not.toContain('data-editor-engine="codemirror"');
    });

    it('uses the first inactive text preview click as the mounted editor caret request', async () => {
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
      const onSelectNode = vi.fn();
      const renderNode = async (selected: boolean) => {
        await act(async () => {
          root.render(
            <I18nProvider locale="en">
              <CanvasNodeContent
                node={textNode('flow/readme.md', 'rev-a')}
                selected={selected}
                culled={false}
                actions={actionsFixture()}
                textBuffer={textBuffer('flow/readme.md', 'rev-a')}
                textPreview={textPreviewSource(700)}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={() => undefined}
                onSelectNode={onSelectNode}
                onTitlePointerDown={() => undefined}
                onTitlePointerMove={() => undefined}
                onTitlePointerUp={() => undefined}
              />
            </I18nProvider>
          );
        });
      };

      try {
        await renderNode(false);

        await act(async () => {
          container.querySelector<HTMLElement>('.canvas-text-body')?.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: 144,
            clientY: 96
          }));
        });

        expect(onSelectNode).toHaveBeenCalledTimes(1);
        expect(posAtCoords).not.toHaveBeenCalled();

        await renderNode(true);

        await act(async () => {
          flushAnimationFrames(frameCallbacks);
        });

        expect(posAtCoords).toHaveBeenCalledWith({ x: 144, y: 96 });
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
        restoreAnimationFrame();
      }
    });

    it('removes the old fingerprint as soon as the current source is unresolved', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const firstPreview = textPreviewSource(320, 'sha256:old');

      try {
        await renderTextPreviewNode(root, firstPreview);

        expect(textPreviewImage(container)?.getAttribute('src')).toBe(firstPreview.src);

        await renderTextPreviewNode(root, undefined);

        expect(textPreviewImage(container)).toBeNull();
        expect(container.querySelector('.canvas-text-preview-empty')).not.toBeNull();
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      }
    });

    it('keeps the just-blurred editor visible until the exact current preview is visibly committed', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const exactPreview = textPreviewSource(640, 'sha256:new-scroll');

      try {
        await renderTextPreviewNode(root, undefined, { selected: true });

        expect(container.querySelector('[data-canvas-text-editor="true"]')).not.toBeNull();
        expect(textPreviewImage(container)).toBeNull();

        await renderTextPreviewNode(root, undefined);

        expect(container.querySelector('[data-canvas-text-editor="true"]')).not.toBeNull();
        expect(textPreviewImage(container)).toBeNull();
        expect(container.querySelector('.canvas-text-preview-empty')).not.toBeNull();

        await renderTextPreviewNode(root, exactPreview);

        expect(container.querySelector('[data-canvas-text-editor="true"]')).not.toBeNull();
        expect(textPreviewImage(container)?.getAttribute('src')).toBe(exactPreview.src);
        const editorHost = container.querySelector('[data-canvas-text-editor="true"]');
        const previewLayers = container.querySelector('.canvas-text-preview-layers');
        expect(Boolean((editorHost?.compareDocumentPosition(previewLayers!) ?? 0)
          & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

        await renderTextPreviewNode(root, exactPreview, {
          textPreviewCommittedSourceKey: exactPreview.sourceKey
        });

        expect(container.querySelector('[data-canvas-text-editor="true"]')).toBeNull();
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      }
    });

    it('reuses the exact committed preview image before another animation frame when editing ends unchanged', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const exactPreview = textPreviewSource(640, 'sha256:unchanged');
      const frameCallbacks: FrameRequestCallback[] = [];
      const restoreAnimationFrame = installAnimationFrameQueue(frameCallbacks);

      try {
        await renderTextPreviewNode(root, exactPreview, {
          selected: true,
          textPreviewCommittedSourceKey: exactPreview.sourceKey
        });

        const retainedImage = textPreviewImage(container);
        expect(retainedImage).not.toBeNull();
        expect(container.querySelector('.canvas-text-preview-layers')?.getAttribute(
          'data-canvas-text-preview-hidden'
        )).toBe('true');

        await renderTextPreviewNode(root, exactPreview, {
          textPreviewCommittedSourceKey: exactPreview.sourceKey
        });

        expect(textPreviewImage(container)).toBe(retainedImage);
        expect(container.querySelector('.canvas-text-preview-layers')?.getAttribute(
          'data-canvas-text-preview-hidden'
        )).toBe('false');
        expect(container.querySelector('[data-canvas-text-editor="true"]')).toBeNull();
        expect(frameCallbacks.length).toBeGreaterThan(0);
      } finally {
        await act(async () => root.unmount());
        container.remove();
        restoreAnimationFrame();
      }
    });

    it('does not replace the editor with a preview for the previous scroll viewport', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const previousPreview = textPreviewSource(640, 'sha256:previous-scroll');
      const currentPreview = textPreviewSource(640, 'sha256:current-scroll');
      const onUpdateTextViewport = vi.fn();

      try {
        await renderTextPreviewNode(root, previousPreview, {
          selected: true,
          onUpdateTextViewport
        });
        const editor = container.querySelector('.cm-editor');
        const scroller = container.querySelector<HTMLElement>('.cm-scroller');
        expect(editor).not.toBeNull();
        expect(scroller).not.toBeNull();
        if (!scroller) {
          throw new Error('Expected CodeMirror scroller.');
        }
        scroller.scrollTop = 96;
        scroller.scrollLeft = 12;
        await act(async () => {
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        });

        await renderTextPreviewNode(root, previousPreview, {
          selected: false,
          onUpdateTextViewport
        });

        expect(container.querySelector('.cm-editor')).toBe(editor);
        expect(onUpdateTextViewport).toHaveBeenLastCalledWith(
          'flow/readme.md',
          { scrollTop: 96, scrollLeft: 12 }
        );

        await renderTextPreviewNode(root, undefined, {
          selected: false,
          node: {
            ...textNode('flow/readme.md', 'rev-a'),
            textViewport: { scrollTop: 96, scrollLeft: 12 }
          },
          onUpdateTextViewport
        });
        expect(container.querySelector('.cm-editor')).toBe(editor);

        await renderTextPreviewNode(root, currentPreview, {
          selected: false,
          textPreviewCommittedSourceKey: currentPreview.sourceKey,
          node: {
            ...textNode('flow/readme.md', 'rev-a'),
            textViewport: { scrollTop: 96, scrollLeft: 12 }
          },
          onUpdateTextViewport
        });

        expect(container.querySelector('.cm-editor')).toBeNull();
        expect(textPreviewImage(container)?.src).toContain('sha256:current-scroll');
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      }
    });

    it('mounts the pending DOM preview while retaining the editor during handoff', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const pending = textPreviewSource(640, 'sha256:pending');

      try {
        await renderTextPreviewNode(root, undefined, { selected: true });
        const editor = container.querySelector('.cm-editor');
        expect(editor).not.toBeNull();

        await renderTextPreviewNode(root, undefined, { selected: false, pendingTextPreview: pending });

        expect(container.querySelector('.cm-editor')).toBe(editor);
        expect(container.querySelector<HTMLImageElement>(
          'img[data-canvas-text-preview-layer="pending"]'
        )?.getAttribute('src')).toBe(pending.src);

        await renderTextPreviewNode(root, undefined, { selected: true, pendingTextPreview: pending });

        expect(container.querySelector('.cm-editor')).toBe(editor);
        expect(container.querySelector('img[data-canvas-text-preview-layer="pending"]')).toBeNull();
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      }
    });

    it('unmounts the retained editor when the current preview handoff fails', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      try {
        await renderTextPreviewNode(root, undefined, { selected: true });
        expect(container.querySelector('.cm-editor')).not.toBeNull();

        await renderTextPreviewNode(root, undefined, {
          selected: false,
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
          selected={false}
          culled={false}
          actions={actionsFixture()}
          textBuffer={textBuffer('flow/readme.md', 'rev-a')}
          textPreviewError="Canvas text preview source capture did not produce a PNG blob."
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={() => undefined}
          onSelectNode={() => undefined}
          onTitlePointerDown={() => undefined}
          onTitlePointerMove={() => undefined}
          onTitlePointerUp={() => undefined}
        />
      );

      expect(html).toContain('Canvas text preview source capture did not produce a PNG blob.');
      expect(html).toContain('Text Preview Error');
      expect(html).not.toContain('canvas-text-preview-empty');
      expect(html).not.toContain('data-canvas-text-editor="true"');
    });

    it('renders selected text nodes as live editors while keeping their current preview hidden', () => {
      const html = renderStaticWithI18n(
        <CanvasNodeContent
          node={textNode('flow/readme.md', 'rev-a')}
          selected
          culled={false}
          actions={actionsFixture()}
          textBuffer={textBuffer('flow/readme.md', 'rev-a')}
          textPreview={{
            projectRelativePath: 'flow/readme.md',
            sourceKey: 'canvas-1\u001fflow/readme.md\u001ffp\u001f700',
            src: '/api/projects/p/canvas-text-preview?canvasId=canvas-1&path=flow%2Freadme.md&fingerprint=fp&w=700',
            previewWidth: 700,
            fingerprint: 'fp'
          }}
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={() => undefined}
          onSelectNode={() => undefined}
          onTitlePointerDown={() => undefined}
          onTitlePointerMove={() => undefined}
          onTitlePointerUp={() => undefined}
        />
      );

      expect(html).toContain('data-editor-engine="codemirror"');
      expect(html).toContain('canvas-text-preview-image');
      expect(html).toContain('data-canvas-text-preview-hidden="true"');
    });

    it('opens the selected text editor at the persisted text viewport position', async () => {
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
            <I18nProvider locale="en">
              <CanvasNodeContent
                node={node}
                selected
                culled={false}
                actions={actionsFixture()}
                textBuffer={textBuffer(node.projectRelativePath, 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={() => undefined}
                onSelectNode={() => undefined}
                onTitlePointerDown={() => undefined}
                onTitlePointerMove={() => undefined}
                onTitlePointerUp={() => undefined}
              />
            </I18nProvider>
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

    it('commits the selected text editor scroll position when the editor blurs and unmounts without duplicates', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const node = textNode('flow/readme.md', 'rev-a');
      const onUpdateTextViewport = vi.fn();

      try {
        await act(async () => {
          root.render(
            <I18nProvider locale="en">
              <CanvasNodeContent
                node={node}
                selected
                culled={false}
                actions={actionsFixture()}
                textBuffer={textBuffer(node.projectRelativePath, 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={onUpdateTextViewport}
                onSelectNode={() => undefined}
                onTitlePointerDown={() => undefined}
                onTitlePointerMove={() => undefined}
                onTitlePointerUp={() => undefined}
              />
            </I18nProvider>
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
            <I18nProvider locale="en">
              <CanvasNodeContent
                node={node}
                selected={false}
                culled={false}
                actions={actionsFixture()}
                textBuffer={textBuffer(node.projectRelativePath, 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={onUpdateTextViewport}
                onSelectNode={() => undefined}
                onTitlePointerDown={() => undefined}
                onTitlePointerMove={() => undefined}
                onTitlePointerUp={() => undefined}
              />
            </I18nProvider>
          );
        });

        expect(onUpdateTextViewport).toHaveBeenCalledTimes(1);

        const persistedNode: ProjectedCanvasNode = {
          ...node,
          textViewport: { scrollTop: 72, scrollLeft: 9 }
        };

        await act(async () => {
          root.render(
            <I18nProvider locale="en">
              <CanvasNodeContent
                node={persistedNode}
                selected
                culled={false}
                actions={actionsFixture()}
                textBuffer={textBuffer(node.projectRelativePath, 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={onUpdateTextViewport}
                onSelectNode={() => undefined}
                onTitlePointerDown={() => undefined}
                onTitlePointerMove={() => undefined}
                onTitlePointerUp={() => undefined}
              />
            </I18nProvider>
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
            <I18nProvider locale="en">
              <CanvasNodeContent
                node={persistedNode}
                selected={false}
                culled={false}
                actions={actionsFixture()}
                textBuffer={textBuffer(node.projectRelativePath, 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={onUpdateTextViewport}
                onSelectNode={() => undefined}
                onTitlePointerDown={() => undefined}
                onTitlePointerMove={() => undefined}
                onTitlePointerUp={() => undefined}
              />
            </I18nProvider>
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

    it('commits the selected text editor scroll position when selection ends before preview handoff', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const node = textNode('flow/readme.md', 'rev-a');
      const onUpdateTextViewport = vi.fn();
      const renderNode = async (selected: boolean) => {
        await act(async () => {
          root.render(
            <I18nProvider locale="en">
              <CanvasNodeContent
                node={node}
                selected={selected}
                culled={false}
                actions={actionsFixture()}
                textBuffer={textBuffer(node.projectRelativePath, 'rev-a')}
                onVideoPlayerMounted={() => undefined}
                onVideoPlayingChange={() => undefined}
                onRegisterVideoTarget={() => undefined}
                onUpdateVideoPlaybackTime={() => undefined}
                onUpdateTextViewport={onUpdateTextViewport}
                onSelectNode={() => undefined}
                onTitlePointerDown={() => undefined}
                onTitlePointerMove={() => undefined}
                onTitlePointerUp={() => undefined}
              />
            </I18nProvider>
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
          selected={false}
          culled={false}
          actions={actionsFixture()}
          textBuffer={textBuffer('flow/readme.md', 'rev-a')}
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={() => undefined}
          onSelectNode={() => undefined}
          onTitlePointerDown={() => undefined}
          onTitlePointerMove={() => undefined}
          onTitlePointerUp={() => undefined}
        />
      );

      expect(html).toContain('class="canvas-text-body"');
      expect(html).toContain('data-canvas-local-wheel="focus"');
    });
  });

  it('renders media captions through the shared Canvas node caption pattern', () => {
    const html = renderStaticWithI18n(
      <CanvasNodeContent
        node={{
          ...imageNode('audio/theme.mp3', 'rev-a'),
          mediaKind: 'audio',
          availability: {
            state: 'available',
            revision: 'rev-a',
            size: 10_000,
            mimeType: 'audio/mpeg',
            fileUrl: 'http://127.0.0.1:17321/api/projects/p/files/raw/audio/theme.mp3?v=rev-a'
          }
        }}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={undefined}
        onVideoPlayerMounted={() => undefined}
        onVideoPlayingChange={() => undefined}
        onRegisterVideoTarget={() => undefined}
        onUpdateVideoPlaybackTime={() => undefined}
        onUpdateTextViewport={() => undefined}
        onSelectNode={() => undefined}
        onTitlePointerDown={() => undefined}
        onTitlePointerMove={() => undefined}
        onTitlePointerUp={() => undefined}
      />
    );

    expect(html).toContain('db-canvas-node-caption');
  });

  describe('Canvas text status', { tags: ['canvas-text'] }, () => {
    it('renders external text changes with the shared info status tone only', () => {
      const html = renderStaticWithI18n(
        <CanvasNodeContent
          node={textNode('flow/readme.md', 'rev-a')}
          selected
          culled={false}
          actions={actionsFixture()}
          textBuffer={{ ...textBuffer('flow/readme.md', 'rev-a'), externalChange: true }}
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={() => undefined}
          onSelectNode={() => undefined}
          onTitlePointerDown={() => undefined}
          onTitlePointerMove={() => undefined}
          onTitlePointerUp={() => undefined}
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
          selected
          culled={false}
          actions={actionsFixture()}
          textBuffer={textBuffer('flow/readme.md', 'rev-a')}
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={() => undefined}
          onSelectNode={() => undefined}
          onTitlePointerDown={() => undefined}
          onTitlePointerMove={() => undefined}
          onTitlePointerUp={() => undefined}
        />
      );

      expect(html).not.toContain('Saved');
      expect(html).not.toContain('db-status-pill--success');
    });
  });
});

describe('CanvasNodeContent text buffer ensure keys', { tags: ['canvas-text'] }, () => {
  it('returns the path only while an available text node has no buffer', () => {
    expect(canvasTextBufferEnsureKey(textNode('flow/readme.md', 'rev-a'), undefined)).toBe('flow/readme.md');
  });

  it('skips ensure whenever the current text buffer is already loaded', () => {
    expect(canvasTextBufferEnsureKey(textNode('flow/readme.md', 'rev-a'), textBuffer('flow/readme.md', 'rev-a'))).toBeUndefined();
    expect(canvasTextBufferEnsureKey(textNode('flow/readme.md', 'rev-b'), textBuffer('flow/readme.md', 'rev-a'))).toBeUndefined();
  });
});

function textNode(path: string, revision: string): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
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
      fileUrl: `http://127.0.0.1:17321/api/projects/p/files/raw/${path}?v=${revision}`,
      revision
    }
  };
}

function videoNode(path: string, revision: string): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
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
      fileUrl: `http://127.0.0.1:17321/api/projects/p/files/raw/${path}?v=${revision}`,
      revision
    },
    videoPresentation: {
      kind: 'video',
      width: 640,
      height: 360,
      durationSeconds: 12,
      textTracks: []
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
  textPreview: CanvasTextPreviewSource | undefined,
  options?: {
    selected?: boolean | undefined;
    pendingTextPreview?: CanvasTextPreviewSource | undefined;
    textPreviewCommittedSourceKey?: string | undefined;
    textPreviewError?: string | undefined;
    node?: ProjectedCanvasNode | undefined;
    onUpdateTextViewport?: CanvasNodeContentProps['onUpdateTextViewport'] | undefined;
  }
): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider locale="en">
        <CanvasNodeContent
          node={options?.node ?? textNode('flow/readme.md', 'rev-a')}
          selected={options?.selected ?? false}
          culled={false}
          actions={actionsFixture()}
          textBuffer={textBuffer('flow/readme.md', 'rev-a')}
          textPreview={textPreview}
          pendingTextPreview={options?.pendingTextPreview}
          textPreviewCommittedSourceKey={options?.textPreviewCommittedSourceKey}
          textPreviewError={options?.textPreviewError}
          onVideoPlayerMounted={() => undefined}
          onVideoPlayingChange={() => undefined}
          onRegisterVideoTarget={() => undefined}
          onUpdateVideoPlaybackTime={() => undefined}
          onUpdateTextViewport={options?.onUpdateTextViewport ?? (() => undefined)}
          onSelectNode={() => undefined}
          onTitlePointerDown={() => undefined}
          onTitlePointerMove={() => undefined}
          onTitlePointerUp={() => undefined}
        />
      </I18nProvider>
    );
  });
}

function textPreviewSource(previewWidth: number, fingerprint = 'sha256:preview'): CanvasTextPreviewSource & { fingerprint: string } {
  return {
    projectRelativePath: 'flow/readme.md',
    sourceKey: `canvas-1\u001fflow/readme.md\u001f${fingerprint}\u001f${previewWidth}`,
    src: `/api/projects/p/canvas-text-preview?canvasId=canvas-1&path=flow%2Freadme.md&fingerprint=${fingerprint}&w=${previewWidth}`,
    previewWidth,
    fingerprint
  };
}

function textPreviewImage(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('img.canvas-text-preview-image');
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

function renderImagePreview(imageState: CanvasImageNodeAssetHookState): string {
  return renderStaticWithI18n(
    <CanvasImageNodePreview
      node={imageNode('flow/cover.png', 'rev-a')}
      imageState={imageState}
    />
  );
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

function imageNode(path: string, revision: string): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
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
      fileUrl: `http://127.0.0.1:17321/api/projects/p/files/raw/${path}?v=${revision}`,
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: 1600
    }
  };
}

function directoryNode(path: string): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    nodeKind: 'directory',
    x: 0,
    y: 0,
    width: 240,
    height: 96,
    z: 0,
    availability: {
      state: 'available',
      size: 0,
      mimeType: 'inode/directory',
      fileUrl: '',
      revision: 'rev-a'
    }
  };
}

function unavailableDirectoryNode(path: string, message: string): ProjectedCanvasNode {
  return {
    ...directoryNode(path),
    availability: {
      state: 'missing',
      message
    }
  };
}
