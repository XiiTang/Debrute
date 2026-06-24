import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canvasTextHighlightSpans,
  canvasTextSyntaxHighlighter
} from './CanvasTextHighlighting';

const canvasStyles = readFileSync(fileURLToPath(new URL('../styles/canvas.css', import.meta.url)), 'utf8');

describe('CanvasTextHighlighting', () => {
  it('exports the shared syntax highlighter used by editor and preview', () => {
    expect(canvasTextSyntaxHighlighter.style).toEqual(expect.any(Function));
  });

  it('highlights JavaScript through stable token classes', () => {
    const spans = canvasTextHighlightSpans({
      value: 'const title = "Debrute";',
      language: 'javascript'
    });

    expect(spans.some((span) => span.className.split(' ').includes('tok-keyword'))).toBe(true);
    expect(spans.some((span) => span.className.split(' ').includes('tok-string'))).toBe(true);
  });

  it('returns no spans for plain text', () => {
    expect(canvasTextHighlightSpans({
      value: 'plain text only',
      language: 'plaintext'
    })).toEqual([]);
  });

  it('can offset token positions for preview window highlighting', () => {
    const spans = canvasTextHighlightSpans({
      value: 'const title = "Debrute";',
      language: 'javascript',
      baseOffset: 500
    });

    expect(Math.min(...spans.map((span) => span.from))).toBeGreaterThanOrEqual(500);
    expect(spans.some((span) => span.className.split(' ').includes('tok-keyword'))).toBe(true);
  });

  it('styles token classes emitted by representative project languages', () => {
    const tokenClasses = new Set([
      ...canvasTextHighlightSpans({
        value: '# Heading\n**bold** [link](https://debrute.local)',
        language: 'markdown'
      }).flatMap((span) => span.className.split(' ')),
      ...canvasTextHighlightSpans({
        value: '<section class="hero">Debrute</section>',
        language: 'html'
      }).flatMap((span) => span.className.split(' ')),
      ...canvasTextHighlightSpans({
        value: 'type User = { id: string };\nconst value = /x+/g;',
        language: 'typescript'
      }).flatMap((span) => span.className.split(' '))
    ]);

    for (const className of tokenClasses) {
      expect(canvasStyles).toContain(`.${className}`);
    }
  });
});
