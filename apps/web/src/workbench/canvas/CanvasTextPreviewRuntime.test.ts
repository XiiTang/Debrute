import { describe, expect, it } from 'vitest';
import {
  canvasTextPreviewLineWindow,
  canvasTextPreviewLines,
  canvasTextSourceLines
} from './CanvasTextPreviewRuntime';

describe('CanvasTextPreviewRuntime', () => {
  it('splits CRLF and LF content into source lines', () => {
    expect(canvasTextSourceLines('one\r\ntwo\nthree')).toEqual(['one', 'two', 'three']);
  });

  it('keeps trailing empty lines visible', () => {
    expect(canvasTextSourceLines('one\n')).toEqual(['one', '']);
  });

  it('bounds the visible source-line window with overscan', () => {
    expect(canvasTextPreviewLineWindow({
      lineCount: 100,
      scrollTop: 84,
      viewportHeight: 50.4,
      lineHeightPx: 16.8,
      overscan: 2
    })).toEqual({
      fromLine: 3,
      toLine: 10,
      offsetY: -33.6
    });
  });

  it('renders only the requested preview line window', () => {
    const lines = canvasTextPreviewLines({
      value: Array.from({ length: 12 }, (_item, index) => `line-${index + 1}`).join('\n'),
      language: 'plaintext',
      scrollTop: 50.4,
      viewportHeight: 33.6,
      lineHeightPx: 16.8,
      overscan: 1
    });

    expect(lines.map((line) => line.lineNumber)).toEqual([3, 4, 5, 6]);
    expect(lines.map((line) => line.segments.map((segment) => segment.text).join(''))).toEqual([
      'line-3',
      'line-4',
      'line-5',
      'line-6'
    ]);
  });

  it('slices highlight spans onto their source lines', () => {
    const lines = canvasTextPreviewLines({
      value: 'const title = "Debrute";\nplain',
      language: 'javascript',
      scrollTop: 0,
      viewportHeight: 50.4,
      lineHeightPx: 16.8,
      overscan: 0
    });

    expect(lines[0]!.segments.some((segment) => segment.className?.split(' ').includes('tok-keyword'))).toBe(true);
    expect(lines[0]!.segments.some((segment) => segment.className?.split(' ').includes('tok-string'))).toBe(true);
    expect(lines[1]!.segments.map((segment) => segment.text).join('')).toBe('plain');
  });
});
