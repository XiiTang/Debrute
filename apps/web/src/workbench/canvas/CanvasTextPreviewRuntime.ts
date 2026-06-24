import type { ProjectTextLanguageId } from '@debrute/project-core';
import { canvasTextHighlightSpans, type CanvasTextHighlightSpan } from './CanvasTextHighlighting';

export interface CanvasTextPreviewSegment {
  text: string;
  className?: string;
}

export interface CanvasTextPreviewLine {
  lineNumber: number;
  segments: CanvasTextPreviewSegment[];
}

export interface CanvasTextPreviewLineWindow {
  fromLine: number;
  toLine: number;
  offsetY: number;
}

export function canvasTextSourceLines(value: string): string[] {
  return canvasTextNormalizeLineEndings(value).split('\n');
}

export function canvasTextPreviewLineWindow(input: {
  lineCount: number;
  scrollTop: number;
  viewportHeight: number;
  lineHeightPx: number;
  overscan: number;
}): CanvasTextPreviewLineWindow {
  if (input.lineCount <= 0) {
    return { fromLine: 0, toLine: 0, offsetY: 0 };
  }
  const firstVisible = Math.max(0, Math.floor(input.scrollTop / input.lineHeightPx));
  const visibleCount = Math.max(1, Math.ceil(input.viewportHeight / input.lineHeightPx));
  const fromLine = Math.max(0, firstVisible - input.overscan);
  const toLine = Math.min(input.lineCount, firstVisible + visibleCount + input.overscan);
  const offsetY = fromLine * input.lineHeightPx - input.scrollTop;
  return {
    fromLine,
    toLine,
    offsetY: Math.round(offsetY * 1000) / 1000
  };
}

export function canvasTextPreviewLines(input: {
  value: string;
  language: ProjectTextLanguageId;
  scrollTop: number;
  viewportHeight: number;
  lineHeightPx: number;
  overscan: number;
}): CanvasTextPreviewLine[] {
  const normalizedValue = canvasTextNormalizeLineEndings(input.value);
  const sourceLines = canvasTextSourceLines(normalizedValue);
  const window = canvasTextPreviewLineWindow({
    lineCount: sourceLines.length,
    scrollTop: input.scrollTop,
    viewportHeight: input.viewportHeight,
    lineHeightPx: input.lineHeightPx,
    overscan: input.overscan
  });
  const lineStarts = canvasTextLineStarts(sourceLines);
  const visibleLines = sourceLines.slice(window.fromLine, window.toLine);
  const visibleValue = visibleLines.join('\n');
  const visibleOffset = lineStarts[window.fromLine] ?? 0;
  const spans = canvasTextHighlightSpans({
    value: visibleValue,
    language: input.language,
    baseOffset: visibleOffset
  });

  return visibleLines.map((line, index) => {
    const lineIndex = window.fromLine + index;
    const from = lineStarts[lineIndex]!;
    const to = from + line.length;
    return {
      lineNumber: lineIndex + 1,
      segments: canvasTextPreviewSegmentsForLine({
        line,
        lineStart: from,
        lineEnd: to,
        spans
      })
    };
  });
}

export function canvasTextNormalizeLineEndings(value: string): string {
  return value.replace(/\r\n|\r/g, '\n');
}

function canvasTextLineStarts(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function canvasTextPreviewSegmentsForLine(input: {
  line: string;
  lineStart: number;
  lineEnd: number;
  spans: readonly CanvasTextHighlightSpan[];
}): CanvasTextPreviewSegment[] {
  if (input.line.length === 0) {
    return [{ text: '' }];
  }
  const segments: CanvasTextPreviewSegment[] = [];
  let cursor = input.lineStart;
  for (const span of input.spans) {
    if (span.to <= input.lineStart || span.from >= input.lineEnd) {
      continue;
    }
    const from = Math.max(input.lineStart, span.from, cursor);
    const to = Math.min(input.lineEnd, span.to);
    if (from >= to) {
      continue;
    }
    if (cursor < from) {
      segments.push({
        text: input.line.slice(cursor - input.lineStart, from - input.lineStart)
      });
    }
    segments.push({
      text: input.line.slice(from - input.lineStart, to - input.lineStart),
      className: span.className
    });
    cursor = to;
  }
  if (cursor < input.lineEnd) {
    segments.push({
      text: input.line.slice(cursor - input.lineStart)
    });
  }
  return segments;
}
