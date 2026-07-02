// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(html).not.toContain('class="db-canvas-node-placeholder"');
  });
});

describe('CanvasNodeContent text chrome', () => {
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

    expect(html).toContain('<strong>archive</strong>');
    expect(html).toContain('db-canvas-node-generic');
    expect(html).not.toContain('<span>archive</span>');
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
    expect(html).toContain('<span>archive</span>');
  });

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

  it('renders inactive available text nodes as preview images', () => {
    const html = renderStaticWithI18n(
      <CanvasNodeContent
        node={textNode('flow/readme.md', 'rev-a')}
        selected={false}
        culled={false}
        actions={actionsFixture()}
        textBuffer={textBuffer('flow/readme.md', 'rev-a')}
        textPreview={{
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

    expect(html).toContain('class="canvas-text-preview-image"');
    expect(html).toContain('data-preview-width="700"');
    expect(html).not.toContain('data-canvas-text-editor="true"');
    expect(html).not.toContain('data-editor-engine="codemirror"');
  });

  it('uses the first inactive text preview click as the mounted editor caret request', async () => {
    const restoreActEnvironment = installReactActEnvironment();
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
      restoreActEnvironment();
    }
  });

  it('keeps the loaded text preview mounted while a same-fingerprint next variant loads', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const frameCallbacks: FrameRequestCallback[] = [];
    const restoreAnimationFrame = installAnimationFrameQueue(frameCallbacks);
    const preloadImages = installTextPreviewImagePreload();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const firstPreview = textPreviewSource(320);
    const nextPreview = textPreviewSource(640);

    try {
      await renderTextPreviewNode(root, firstPreview);

      expect(textPreviewImage(container)?.getAttribute('src')).toBe(firstPreview.src);
      expect(textPreviewImage(container)?.getAttribute('data-preview-width')).toBe('320');

      await renderTextPreviewNode(root, nextPreview);

      expect(textPreviewImage(container)?.getAttribute('src')).toBe(firstPreview.src);
      expect(preloadImages).toHaveLength(1);
      expect(preloadImages[0]?.src).toBe(nextPreview.src);

      await act(async () => {
        preloadImages[0]?.emit('load', nextPreview.previewWidth);
        await Promise.resolve();
      });

      expect(textPreviewImage(container)?.getAttribute('src')).toBe(firstPreview.src);
      expect(frameCallbacks).toHaveLength(1);

      await act(async () => {
        frameCallbacks.shift()?.(16);
      });

      expect(textPreviewImage(container)?.getAttribute('src')).toBe(firstPreview.src);
      expect(frameCallbacks).toHaveLength(1);

      await act(async () => {
        frameCallbacks.shift()?.(32);
      });

      expect(textPreviewImage(container)?.getAttribute('src')).toBe(nextPreview.src);
      expect(textPreviewImage(container)?.getAttribute('data-preview-width')).toBe('640');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
      restoreActEnvironment();
    }
  });

  it('renders a text preview variant error when the first preview image fails to load', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const firstPreview = textPreviewSource(320);

    try {
      await renderTextPreviewNode(root, firstPreview);

      await act(async () => {
        textPreviewImage(container)?.dispatchEvent(new Event('error'));
      });

      expect(container.textContent).toContain('Unable to load text preview variant for flow/readme.md.');
      expect(container.textContent).toContain('Text Preview Error');
      expect(textPreviewImage(container)).toBeNull();
      expect(container.querySelector('.canvas-text-preview-empty')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreActEnvironment();
    }
  });

  it('renders a text preview variant error when the next preview variant fails to preload', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const preloadImages = installTextPreviewImagePreload();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const firstPreview = textPreviewSource(320);
    const nextPreview = textPreviewSource(640);

    try {
      await renderTextPreviewNode(root, firstPreview);
      await renderTextPreviewNode(root, nextPreview);

      expect(preloadImages).toHaveLength(1);

      await act(async () => {
        preloadImages[0]?.emit('error');
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Unable to load text preview variant for flow/readme.md.');
      expect(container.textContent).toContain('Text Preview Error');
      expect(textPreviewImage(container)).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreActEnvironment();
    }
  });

  it('keeps the just-blurred text editor visible until the exact preview image loads', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const frameCallbacks: FrameRequestCallback[] = [];
    const restoreAnimationFrame = installAnimationFrameQueue(frameCallbacks);
    const preloadImages = installTextPreviewImagePreload();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const firstPreview = textPreviewSource(320, 'sha256:old-scroll');
    const exactPreview = textPreviewSource(640, 'sha256:new-scroll');

    try {
      await renderTextPreviewNode(root, firstPreview);

      expect(textPreviewImage(container)?.getAttribute('src')).toBe(firstPreview.src);

      await renderTextPreviewNode(root, undefined, { selected: true });

      expect(container.querySelector('[data-canvas-text-editor="true"]')).not.toBeNull();
      expect(textPreviewImage(container)).toBeNull();

      await renderTextPreviewNode(root, undefined);

      expect(container.querySelector('[data-canvas-text-editor="true"]')).not.toBeNull();
      expect(textPreviewImage(container)).toBeNull();
      expect(container.querySelector('.canvas-text-preview-empty')).toBeNull();

      await renderTextPreviewNode(root, exactPreview);

      expect(container.querySelector('[data-canvas-text-editor="true"]')).not.toBeNull();
      expect(textPreviewImage(container)).toBeNull();
      expect(preloadImages).toHaveLength(1);
      expect(preloadImages[0]?.src).toBe(exactPreview.src);

      await act(async () => {
        preloadImages[0]?.emit('load', exactPreview.previewWidth);
        await Promise.resolve();
      });
      await act(async () => {
        flushAnimationFrames(frameCallbacks);
      });
      await act(async () => {
        flushAnimationFrames(frameCallbacks);
      });
      await act(async () => {
        flushAnimationFrames(frameCallbacks);
      });

      expect(container.querySelector('[data-canvas-text-editor="true"]')).toBeNull();
      expect(textPreviewImage(container)?.getAttribute('src')).toBe(exactPreview.src);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
      restoreActEnvironment();
    }
  });

  it('keeps the just-blurred text editor visible and reports an error when exact preview image loading fails', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const preloadImages = installTextPreviewImagePreload();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const exactPreview = textPreviewSource(640, 'sha256:new-scroll');

    try {
      await renderTextPreviewNode(root, undefined, { selected: true });

      expect(container.querySelector('[data-canvas-text-editor="true"]')).not.toBeNull();

      await renderTextPreviewNode(root, exactPreview);

      expect(container.querySelector('[data-canvas-text-editor="true"]')).not.toBeNull();
      expect(textPreviewImage(container)).toBeNull();
      expect(preloadImages).toHaveLength(1);

      await act(async () => {
        preloadImages[0]?.emit('error');
        await Promise.resolve();
      });

      expect(container.querySelector('[data-canvas-text-editor="true"]')).not.toBeNull();
      expect(container.textContent).toContain('Unable to load text preview variant for flow/readme.md.');
      expect(textPreviewImage(container)).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreActEnvironment();
    }
  });

  it('renders text preview generation errors instead of an empty preview body', () => {
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

  it('renders selected text nodes as live CodeMirror editors instead of preview images', () => {
    const html = renderStaticWithI18n(
      <CanvasNodeContent
        node={textNode('flow/readme.md', 'rev-a')}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={textBuffer('flow/readme.md', 'rev-a')}
        textPreview={{
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
    expect(html).not.toContain('canvas-text-preview-image');
  });

  it('opens the selected text editor at the persisted text viewport position', async () => {
    const restoreActEnvironment = installReactActEnvironment();
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
      restoreActEnvironment();
    }
  });

  it('commits the selected text editor scroll position when the editor blurs and unmounts without duplicates', async () => {
    const restoreActEnvironment = installReactActEnvironment();
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
      restoreActEnvironment();
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

describe('CanvasNodeContent text buffer ensure keys', () => {
  it('returns one stable key for an available text node revision', () => {
    expect(canvasTextBufferEnsureKey(textNode('flow/readme.md', 'rev-a'), undefined)).toBe('flow/readme.md\u001frev-a');
  });

  it('skips ensure when the current buffer already matches the node revision', () => {
    expect(canvasTextBufferEnsureKey(textNode('flow/readme.md', 'rev-a'), textBuffer('flow/readme.md', 'rev-a'))).toBeUndefined();
  });

  it('requests ensure again when the node revision changes', () => {
    expect(canvasTextBufferEnsureKey(textNode('flow/readme.md', 'rev-b'), textBuffer('flow/readme.md', 'rev-a'))).toBe('flow/readme.md\u001frev-b');
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

function textBuffer(path: string, revision: string): TextFileBuffer {
  return {
    projectRelativePath: path,
    content: '# Notes',
    language: 'markdown',
    wordWrap: false,
    dirty: false,
    saving: false,
    diskRevision: revision,
    lastSavedRevision: revision,
    externalChange: false
  };
}

async function renderTextPreviewNode(
  root: Root,
  textPreview: CanvasTextPreviewSource | undefined,
  options?: { selected?: boolean | undefined }
): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider locale="en">
        <CanvasNodeContent
          node={textNode('flow/readme.md', 'rev-a')}
          selected={options?.selected ?? false}
          culled={false}
          actions={actionsFixture()}
          textBuffer={textBuffer('flow/readme.md', 'rev-a')}
          textPreview={textPreview}
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
}

function textPreviewSource(previewWidth: number, fingerprint = 'sha256:preview'): CanvasTextPreviewSource & { fingerprint: string } {
  return {
    src: `/api/projects/p/canvas-text-preview?canvasId=canvas-1&path=flow%2Freadme.md&fingerprint=${fingerprint}&w=${previewWidth}`,
    previewWidth,
    fingerprint
  };
}

function textPreviewImage(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('img.canvas-text-preview-image');
}

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

function installTextPreviewImagePreload(): FakeTextPreviewImage[] {
  const images: FakeTextPreviewImage[] = [];
  class FakeImage extends FakeTextPreviewImage {
    constructor() {
      super();
      images.push(this);
    }
  }
  vi.stubGlobal('Image', FakeImage);
  return images;
}

class FakeTextPreviewImage {
  complete = false;
  naturalWidth = 0;
  decoding: HTMLImageElement['decoding'] = 'auto';
  src = '';
  readonly decode = vi.fn(async () => undefined);
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const current = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'load' | 'error', naturalWidth = 1): void {
    this.complete = true;
    this.naturalWidth = naturalWidth;
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
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
