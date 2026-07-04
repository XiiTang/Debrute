import React from 'react';
import {
  CANVAS_FEEDBACK_MARKS,
  type CanvasFeedbackEntry,
  type CanvasFeedbackMark
} from '@debrute/canvas-core';

export type CanvasFeedbackFrameKind = CanvasFeedbackMark | 'comments' | 'regions';

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
      aria-hidden="true"
    />
  );
}

export function canvasFeedbackEntryHasFeedback(entry: CanvasFeedbackEntry | undefined): entry is CanvasFeedbackEntry {
  return Boolean(entry && (
    entry.marks.length > 0
    || entry.items.length > 0
  ));
}

export function orderedCanvasFeedbackFrameKinds(
  entry: CanvasFeedbackEntry | undefined
): CanvasFeedbackFrameKind[] {
  if (!canvasFeedbackEntryHasFeedback(entry)) {
    return [];
  }
  const hasComments = entry.items.some((item) => item.kind === 'comment');
  const hasSpatial = entry.items.some((item) => item.kind === 'pin' || item.kind === 'region');
  return [
    ...orderedCanvasFeedbackMarks(entry.marks),
    ...(hasComments ? ['comments' as const] : []),
    ...(hasSpatial ? ['regions' as const] : [])
  ];
}

export function orderedCanvasFeedbackMarks(marks: readonly CanvasFeedbackMark[]): CanvasFeedbackMark[] {
  const selected = new Set(marks);
  return CANVAS_FEEDBACK_MARKS.filter((mark) => selected.has(mark));
}
