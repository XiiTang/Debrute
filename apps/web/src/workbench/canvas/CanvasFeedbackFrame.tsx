import React from 'react';
import {
  CANVAS_FEEDBACK_MARKS,
  type CanvasFeedbackEntry,
  type CanvasFeedbackMark
} from '@debrute/canvas-core';
import {
  CANVAS_FEEDBACK_FRAME_COLORS,
  type CanvasFeedbackFrameKind
} from './canvasFeedbackPresentation';

export function CanvasFeedbackFrame({
  entry
}: {
  entry: CanvasFeedbackEntry | undefined;
}): React.ReactElement | null {
  const kinds = orderedCanvasFeedbackFrameKinds(entry);
  if (kinds.length === 0) {
    return null;
  }

  return (
    <div
      className="canvas-feedback-frame"
      data-canvas-feedback-frame="true"
      data-canvas-feedback-frame-kinds={kinds.join(' ')}
      style={{
        '--canvas-feedback-frame-gradient': canvasFeedbackFrameGradient(kinds)
      } as React.CSSProperties}
      aria-hidden="true"
    />
  );
}

export function canvasFeedbackEntryHasFeedback(entry: CanvasFeedbackEntry | undefined): entry is CanvasFeedbackEntry {
  return Boolean(entry && (
    entry.marks.length > 0
    || entry.comments.length > 0
    || entry.regions.length > 0
  ));
}

export function orderedCanvasFeedbackFrameKinds(
  entry: CanvasFeedbackEntry | undefined
): CanvasFeedbackFrameKind[] {
  if (!canvasFeedbackEntryHasFeedback(entry)) {
    return [];
  }
  return [
    ...orderedCanvasFeedbackMarks(entry.marks),
    ...(entry.comments.length > 0 ? ['comments' as const] : []),
    ...(entry.regions.length > 0 ? ['regions' as const] : [])
  ];
}

export function orderedCanvasFeedbackMarks(marks: readonly CanvasFeedbackMark[]): CanvasFeedbackMark[] {
  const selected = new Set(marks);
  return CANVAS_FEEDBACK_MARKS.filter((mark) => selected.has(mark));
}

export function canvasFeedbackFrameGradient(kinds: readonly CanvasFeedbackFrameKind[]): string {
  const segmentSize = 100 / kinds.length;
  const segments = kinds.map((kind, index) => {
    const start = formatGradientStop(segmentSize * index);
    const end = formatGradientStop(index === kinds.length - 1 ? 100 : segmentSize * (index + 1));
    return `${CANVAS_FEEDBACK_FRAME_COLORS[kind]} ${start} ${end}`;
  });
  return `conic-gradient(${segments.join(', ')})`;
}

function formatGradientStop(value: number): string {
  return `${Number(value.toFixed(4))}%`;
}
