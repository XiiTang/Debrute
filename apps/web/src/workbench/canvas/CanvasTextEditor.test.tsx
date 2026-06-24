import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CanvasTextEditor } from './CanvasTextEditor';

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
    expect(html).toContain('class="canvas-text-editor"');
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
});
