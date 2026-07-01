import React from 'react';
import { MapPin, MessageSquare } from 'lucide-react';
import {
  CANVAS_FEEDBACK_MARKS,
  type CanvasFeedbackEntry,
  type CanvasFeedbackMark
} from '@debrute/canvas-core';
import { CANVAS_FEEDBACK_MARK_PRESENTATION } from './canvasFeedbackPresentation';
import { useI18n } from '../i18n';

const MAX_VISIBLE_MARKS = 3;

export function CanvasFeedbackSummary({
  entry
}: {
  entry: CanvasFeedbackEntry | undefined;
}): React.ReactElement | null {
  const i18n = useI18n();
  if (!canvasFeedbackEntryHasFeedback(entry)) {
    return null;
  }

  const marks = orderedCanvasFeedbackMarks(entry.marks);
  const visibleMarks = marks.slice(0, MAX_VISIBLE_MARKS);
  const hiddenMarkCount = marks.length - visibleMarks.length;
  const labelItems = [
    ...marks.map((mark) => i18n.t(CANVAS_FEEDBACK_MARK_PRESENTATION[mark].labelKey)),
    ...(entry.comments.length > 0 ? [i18n.t('canvas.feedback.summaryComments', { count: entry.comments.length })] : []),
    ...(entry.regions.length > 0 ? [i18n.t('canvas.feedback.summaryRegions', { count: entry.regions.length })] : [])
  ];
  const label = i18n.t('canvas.feedback.summaryLabel', { items: labelItems.join(', ') });

  return (
    <div
      className="canvas-feedback-summary"
      data-canvas-feedback-summary="true"
      role="img"
      aria-label={label}
    >
      {visibleMarks.map((mark) => {
        const { Icon } = CANVAS_FEEDBACK_MARK_PRESENTATION[mark];
        return (
          <span
            key={mark}
            className="canvas-feedback-summary-item canvas-feedback-summary-item--mark"
            data-canvas-feedback-summary-mark={mark}
            aria-hidden="true"
          >
            <Icon size={12} />
          </span>
        );
      })}
      {hiddenMarkCount > 0 ? (
        <span
          className="canvas-feedback-summary-item canvas-feedback-summary-overflow"
          data-canvas-feedback-summary-overflow={hiddenMarkCount}
          aria-hidden="true"
        >
          +{hiddenMarkCount}
        </span>
      ) : null}
      {entry.comments.length > 0 ? (
        <span
          className="canvas-feedback-summary-item canvas-feedback-summary-count"
          data-canvas-feedback-summary-comments={entry.comments.length}
          aria-hidden="true"
        >
          <MessageSquare size={12} />
          <span>{entry.comments.length}</span>
        </span>
      ) : null}
      {entry.regions.length > 0 ? (
        <span
          className="canvas-feedback-summary-item canvas-feedback-summary-count"
          data-canvas-feedback-summary-regions={entry.regions.length}
          aria-hidden="true"
        >
          <MapPin size={12} />
          <span>{entry.regions.length}</span>
        </span>
      ) : null}
    </div>
  );
}

export function canvasFeedbackEntryHasFeedback(entry: CanvasFeedbackEntry | undefined): entry is CanvasFeedbackEntry {
  return Boolean(entry && (
    entry.marks.length > 0
    || entry.comments.length > 0
    || entry.regions.length > 0
  ));
}

export function orderedCanvasFeedbackMarks(marks: readonly CanvasFeedbackMark[]): CanvasFeedbackMark[] {
  const selected = new Set(marks);
  return CANVAS_FEEDBACK_MARKS.filter((mark) => selected.has(mark));
}
