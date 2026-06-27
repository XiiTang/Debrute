// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import {
  CanvasImageNodePreview,
  CanvasNodeContent,
  canvasTextBufferEnsureKey
} from './CanvasNodeContent';
import type { CanvasImageNodeAssetHookState } from './CanvasImageNodeAssetContext';
import type { CanvasTextPreviewSource } from './CanvasTextPreviewRuntime';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    const html = renderToStaticMarkup(
      <CanvasNodeContent
        node={directoryNode('')}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={undefined}
        onSelectNode={() => undefined}
        onTitlePointerDown={() => undefined}
        onTitlePointerMove={() => undefined}
        onTitlePointerUp={() => undefined}
      />
    );

    expect(html).toContain('Project Root');
  });

  it('renders a generic node label once in the normal state', () => {
    const html = renderToStaticMarkup(
      <CanvasNodeContent
        node={directoryNode('references/archive')}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={undefined}
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
    const html = renderToStaticMarkup(
      <CanvasNodeContent
        node={unavailableDirectoryNode('references/archive', 'Unable to read references/archive.')}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={undefined}
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
    const html = renderToStaticMarkup(
      <CanvasNodeContent
        node={textNode('flow/readme.md', 'rev-a')}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={textBuffer('flow/readme.md', 'rev-a')}
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
    const html = renderToStaticMarkup(
      <CanvasNodeContent
        node={textNode('flow/readme.md', 'rev-a')}
        selected={false}
        culled={false}
        actions={actionsFixture()}
        textBuffer={textBuffer('flow/readme.md', 'rev-a')}
        textPreview={{
          src: '/api/projects/p/canvas-text-preview?canvasId=canvas-1&path=flow%2Freadme.md&fingerprint=fp&w=700',
          previewWidth: 700
        }}
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

  it('keeps the loaded text preview mounted while the preview source is unavailable and the next variant loads', async () => {
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

      await renderTextPreviewNode(root, undefined);

      expect(textPreviewImage(container)?.getAttribute('src')).toBe(firstPreview.src);
      expect(container.querySelector('.canvas-text-preview-empty')).toBeNull();

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

  it('keeps the loaded text preview visible when a selected text node loses focus before the next preview resolves', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const firstPreview = textPreviewSource(320);

    try {
      await renderTextPreviewNode(root, firstPreview);

      expect(textPreviewImage(container)?.getAttribute('src')).toBe(firstPreview.src);

      await renderTextPreviewNode(root, undefined, { selected: true });

      expect(container.querySelector('[data-canvas-text-editor="true"]')).not.toBeNull();
      expect(textPreviewImage(container)).toBeNull();

      await renderTextPreviewNode(root, undefined);

      expect(textPreviewImage(container)?.getAttribute('src')).toBe(firstPreview.src);
      expect(container.querySelector('.canvas-text-preview-empty')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreActEnvironment();
    }
  });

  it('renders text preview generation errors instead of an empty preview body', () => {
    const html = renderToStaticMarkup(
      <CanvasNodeContent
        node={textNode('flow/readme.md', 'rev-a')}
        selected={false}
        culled={false}
        actions={actionsFixture()}
        textBuffer={textBuffer('flow/readme.md', 'rev-a')}
        textPreviewError="Canvas text preview source capture did not produce a PNG blob."
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
    const html = renderToStaticMarkup(
      <CanvasNodeContent
        node={textNode('flow/readme.md', 'rev-a')}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={textBuffer('flow/readme.md', 'rev-a')}
        textPreview={{
          src: '/api/projects/p/canvas-text-preview?canvasId=canvas-1&path=flow%2Freadme.md&fingerprint=fp&w=700',
          previewWidth: 700
        }}
        onSelectNode={() => undefined}
        onTitlePointerDown={() => undefined}
        onTitlePointerMove={() => undefined}
        onTitlePointerUp={() => undefined}
      />
    );

    expect(html).toContain('data-editor-engine="codemirror"');
    expect(html).not.toContain('canvas-text-preview-image');
  });

  it('keeps text bodies focus-gated for Canvas wheel routing', () => {
    const html = renderToStaticMarkup(
      <CanvasNodeContent
        node={textNode('flow/readme.md', 'rev-a')}
        selected={false}
        culled={false}
        actions={actionsFixture()}
        textBuffer={textBuffer('flow/readme.md', 'rev-a')}
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
    const html = renderToStaticMarkup(
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
        onSelectNode={() => undefined}
        onTitlePointerDown={() => undefined}
        onTitlePointerMove={() => undefined}
        onTitlePointerUp={() => undefined}
      />
    );

    expect(html).toContain('db-canvas-node-caption');
  });

  it('renders external text changes with the shared info status tone only', () => {
    const html = renderToStaticMarkup(
      <CanvasNodeContent
        node={textNode('flow/readme.md', 'rev-a')}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={{ ...textBuffer('flow/readme.md', 'rev-a'), externalChange: true }}
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
    const html = renderToStaticMarkup(
      <CanvasNodeContent
        node={textNode('flow/readme.md', 'rev-a')}
        selected
        culled={false}
        actions={actionsFixture()}
        textBuffer={textBuffer('flow/readme.md', 'rev-a')}
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
      <CanvasNodeContent
        node={textNode('flow/readme.md', 'rev-a')}
        selected={options?.selected ?? false}
        culled={false}
        actions={actionsFixture()}
        textBuffer={textBuffer('flow/readme.md', 'rev-a')}
        textPreview={textPreview}
        onSelectNode={() => undefined}
        onTitlePointerDown={() => undefined}
        onTitlePointerMove={() => undefined}
        onTitlePointerUp={() => undefined}
      />
    );
  });
}

function textPreviewSource(previewWidth: number): CanvasTextPreviewSource {
  return {
    src: `/api/projects/p/canvas-text-preview?canvasId=canvas-1&path=flow%2Freadme.md&fingerprint=fp&w=${previewWidth}`,
    previewWidth
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
  return renderToStaticMarkup(
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
