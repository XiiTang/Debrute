import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { CanvasImageNodePreview, CanvasNodeContent, canvasTextBufferEnsureKey } from './CanvasNodeContent';
import type { CanvasImageNodeAssetHookState } from './CanvasImageNodeAssetContext';

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
    expect(html).not.toContain('class="canvas-node-placeholder"');
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
    expect(html).not.toContain('class="canvas-node-placeholder"');
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
    expect(html).not.toContain('class="canvas-node-placeholder"');
  });
});

describe('CanvasNodeContent text chrome', () => {
  it('renders text node titlebar actions through Workbench UI primitives', () => {
    const html = renderToStaticMarkup(
      <CanvasNodeContent
        node={textNode('flow/readme.md', 'rev-a')}
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

    expect(html).toContain('canvas-text-titlebar');
    expect(html).toContain('db-icon-button');
    expect(html).toContain('Open large editor');
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
    visible: true,
    locked: false,
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
    visible: true,
    locked: false,
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
