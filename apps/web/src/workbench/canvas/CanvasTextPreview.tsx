import React from 'react';
import type { ProjectTextLanguageId } from '@debrute/project-core';
import { CANVAS_TEXT_SURFACE_METRICS, canvasTextSurfaceCssVariables } from './CanvasTextSurface';
import {
  canvasTextPreviewLineWindow,
  canvasTextPreviewLines,
  canvasTextSourceLines
} from './CanvasTextPreviewRuntime';

const CANVAS_TEXT_PREVIEW_GUTTER_MEASURE_STYLE = {
  height: 0,
  visibility: 'hidden',
  pointerEvents: 'none'
} as const satisfies React.CSSProperties;

export function CanvasTextPreview({
  value,
  language,
  wordWrap,
  scrollTop,
  viewportHeight
}: {
  value: string;
  language: ProjectTextLanguageId;
  wordWrap: boolean;
  scrollTop: number;
  viewportHeight?: number | undefined;
}): React.ReactElement {
  const lineCount = canvasTextSourceLines(value).length;
  const effectiveViewportHeight = viewportHeight
    ?? CANVAS_TEXT_SURFACE_METRICS.lineHeightPx * CANVAS_TEXT_SURFACE_METRICS.previewInitialLineCount;
  const lineWindow = canvasTextPreviewLineWindow({
    lineCount,
    scrollTop,
    viewportHeight: effectiveViewportHeight,
    lineHeightPx: CANVAS_TEXT_SURFACE_METRICS.lineHeightPx,
    overscan: CANVAS_TEXT_SURFACE_METRICS.previewLineOverscan
  });
  const lines = canvasTextPreviewLines({
    value,
    language,
    scrollTop,
    viewportHeight: effectiveViewportHeight,
    lineHeightPx: CANVAS_TEXT_SURFACE_METRICS.lineHeightPx,
    overscan: CANVAS_TEXT_SURFACE_METRICS.previewLineOverscan
  });
  const windowOffsetStyle = {
    transform: `translateY(${lineWindow.offsetY}px)`
  } as React.CSSProperties;
  const firstLineNumberStyle = {
    marginTop: `${CANVAS_TEXT_SURFACE_METRICS.contentPaddingBlockPx}px`
  } as React.CSSProperties;

  return (
    <div
      data-canvas-text-editor="true"
      data-editor-engine="codemirror"
      data-editor-mode="preview"
      data-word-wrap={wordWrap ? 'on' : 'off'}
      className="canvas-text-editor canvas-text-editor--preview"
      style={canvasTextSurfaceCssVariables() as React.CSSProperties}
    >
      <div className="cm-editor" aria-hidden="true">
        <div className="cm-scroller">
          <div className="cm-gutters cm-gutters-before" aria-hidden="true" style={windowOffsetStyle}>
            <div className="cm-gutter cm-lineNumbers">
              <div className="cm-gutterElement canvas-text-editor__gutter-measure" style={CANVAS_TEXT_PREVIEW_GUTTER_MEASURE_STYLE}>
                {canvasTextPreviewLineNumberMeasureText(lineCount)}
              </div>
              {lines.map((line, index) => (
                <div
                  key={line.lineNumber}
                  className="cm-gutterElement"
                  style={index === 0 ? firstLineNumberStyle : undefined}
                >
                  {line.lineNumber}
                </div>
              ))}
            </div>
          </div>
          <div className="cm-content" style={windowOffsetStyle}>
            {lines.map((line) => (
              <div key={line.lineNumber} className="cm-line">
                {line.segments.map((segment, index) => (
                  segment.className ? (
                    <span key={index} className={segment.className}>{segment.text}</span>
                  ) : (
                    <React.Fragment key={index}>{segment.text}</React.Fragment>
                  )
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function canvasTextPreviewLineNumberMeasureText(lineCount: number): string {
  const digitCount = Math.max(1, String(Math.max(1, Math.floor(lineCount))).length);
  return '9'.repeat(digitCount);
}
