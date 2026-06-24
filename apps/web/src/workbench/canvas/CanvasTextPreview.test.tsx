import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CanvasTextPreview, canvasTextPreviewLineNumberMeasureText } from './CanvasTextPreview';

describe('CanvasTextPreview', () => {
  it('renders the preview editor surface marker without edit mode', () => {
    const html = renderToStaticMarkup(
      <CanvasTextPreview
        value="# Notes"
        language="markdown"
        wordWrap={false}
        scrollTop={0}
        viewportHeight={120}
      />
    );

    expect(html).toContain('data-canvas-text-editor="true"');
    expect(html).toContain('data-editor-engine="codemirror"');
    expect(html).toContain('data-editor-mode="preview"');
    expect(html).not.toContain('data-editor-mode="edit"');
  });

  it('uses shared text surface CSS variables', () => {
    const html = renderToStaticMarkup(
      <CanvasTextPreview
        value="# Notes"
        language="markdown"
        wordWrap={false}
        scrollTop={0}
        viewportHeight={120}
      />
    );

    expect(html).toContain('--canvas-text-editor-line-height:16.8px');
    expect(html).toContain('--canvas-text-editor-line-padding-inline:8px');
  });

  it('escapes literal text through React text nodes', () => {
    const html = renderToStaticMarkup(
      <CanvasTextPreview
        value={'<script>alert("x")</script>'}
        language="plaintext"
        wordWrap={false}
        scrollTop={0}
        viewportHeight={120}
      />
    );

    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('renders only the bounded preview line window', () => {
    const value = Array.from({ length: 30 }, (_item, index) => `line-${index + 1}`).join('\n');
    const html = renderToStaticMarkup(
      <CanvasTextPreview
        value={value}
        language="plaintext"
        wordWrap={false}
        scrollTop={0}
        viewportHeight={33.6}
      />
    );

    expect(html).toContain('line-1');
    expect(html).toContain('line-4');
    expect(html).not.toContain('line-30');
  });

  it('exposes word wrap state', () => {
    const html = renderToStaticMarkup(
      <CanvasTextPreview
        value="long line"
        language="plaintext"
        wordWrap
        scrollTop={0}
        viewportHeight={120}
      />
    );

    expect(html).toContain('data-word-wrap="on"');
  });

  it('renders CodeMirror-compatible line number gutter structure', () => {
    const html = renderToStaticMarkup(
      <CanvasTextPreview
        value={'one\ntwo\nthree'}
        language="plaintext"
        wordWrap={false}
        scrollTop={0}
        viewportHeight={120}
      />
    );

    expect(html).toContain('class="cm-gutters cm-gutters-before"');
    expect(html).toContain('class="cm-gutter cm-lineNumbers"');
    expect(html).toContain('style="height:0;visibility:hidden;pointer-events:none"');
    expect(html).toContain('>9</div><div class="cm-gutterElement" style="margin-top:6px">1</div>');
  });

  it('sizes the hidden gutter measurement row for the source line count', () => {
    expect(canvasTextPreviewLineNumberMeasureText(0)).toBe('9');
    expect(canvasTextPreviewLineNumberMeasureText(9)).toBe('9');
    expect(canvasTextPreviewLineNumberMeasureText(10)).toBe('99');
    expect(canvasTextPreviewLineNumberMeasureText(100)).toBe('999');
  });
});
