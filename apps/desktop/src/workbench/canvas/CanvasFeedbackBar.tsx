import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CircleDot,
  Heart,
  Star,
  ThumbsDown,
  X,
  type LucideIcon
} from 'lucide-react';
import {
  CANVAS_FEEDBACK_MARKS,
  type CanvasFeedbackEntry,
  type CanvasFeedbackMark
} from '@axis/canvas-core';
import type { WorkbenchActions } from '../../types';

const NOTE_SAVE_DELAY_MS = 350;

const FEEDBACK_MARKS: Record<CanvasFeedbackMark, { label: string; Icon: LucideIcon }> = {
  like: { label: 'Like', Icon: Heart },
  dislike: { label: 'Dislike', Icon: ThumbsDown },
  check: { label: 'Check', Icon: Check },
  cross: { label: 'Cross', Icon: X },
  pending: { label: 'Pending', Icon: CircleDot },
  important: { label: 'Important', Icon: Star },
  needs_revision: { label: 'Needs revision', Icon: AlertCircle }
};

export function CanvasFeedbackBar({
  projectRelativePath,
  entry,
  onUpdate,
  style,
  onPointerEnter,
  onPointerLeave
}: {
  projectRelativePath: string;
  entry: CanvasFeedbackEntry | undefined;
  onUpdate: WorkbenchActions['updateCanvasFeedbackEntry'];
  style?: React.CSSProperties;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}): React.ReactElement {
  const [marks, setMarks] = useState<CanvasFeedbackMark[]>(entry?.marks ?? []);
  const [note, setNote] = useState(entry?.note ?? '');
  const saveTimerRef = useRef<number | undefined>(undefined);
  const latestSaveRef = useRef<{ marks: CanvasFeedbackMark[]; note: string }>({
    marks: entry?.marks ?? [],
    note: entry?.note ?? ''
  });

  useEffect(() => {
    const next = {
      marks: entry?.marks ?? [],
      note: entry?.note ?? ''
    };
    setMarks(next.marks);
    setNote(next.note);
    latestSaveRef.current = next;
  }, [entry, projectRelativePath]);

  useEffect(() => () => {
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
    }
  }, []);

  const saveFeedback = (next: { marks: CanvasFeedbackMark[]; note: string }) => {
    latestSaveRef.current = next;
    void onUpdate({
      projectRelativePath,
      marks: next.marks,
      note: next.note
    });
  };

  const clearPendingNoteSave = () => {
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
  };

  const toggleMark = (mark: CanvasFeedbackMark) => {
    const nextMarks = marks.includes(mark)
      ? marks.filter((item) => item !== mark)
      : CANVAS_FEEDBACK_MARKS.filter((item) => item === mark || marks.includes(item));
    setMarks(nextMarks);
    clearPendingNoteSave();
    saveFeedback({ marks: nextMarks, note: latestSaveRef.current.note });
  };

  const scheduleNoteSave = (nextNote: string) => {
    setNote(nextNote);
    latestSaveRef.current = {
      marks: latestSaveRef.current.marks,
      note: nextNote
    };
    clearPendingNoteSave();
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined;
      saveFeedback(latestSaveRef.current);
    }, NOTE_SAVE_DELAY_MS);
  };

  const flushNoteSave = () => {
    if (saveTimerRef.current === undefined) {
      return;
    }
    clearPendingNoteSave();
    saveFeedback(latestSaveRef.current);
  };

  return (
    <div
      className="canvas-feedback-bar"
      style={style}
      data-canvas-feedback-bar="true"
      onPointerDown={stopCanvasFeedbackBarEvent}
      onPointerMove={stopCanvasFeedbackBarEvent}
      onPointerUp={stopCanvasFeedbackBarEvent}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onClick={stopCanvasFeedbackBarEvent}
      onDoubleClick={stopCanvasFeedbackBarEvent}
      onContextMenu={(event) => {
        event.preventDefault();
        stopCanvasFeedbackBarEvent(event);
      }}
      onKeyDown={stopCanvasFeedbackBarEvent}
    >
      {CANVAS_FEEDBACK_MARKS.map((mark) => {
        const active = marks.includes(mark);
        const { label, Icon } = FEEDBACK_MARKS[mark];
        return (
          <button
            key={mark}
            type="button"
            className={active ? 'canvas-feedback-mark active' : 'canvas-feedback-mark'}
            aria-label={label}
            aria-pressed={active}
            title={label}
            onClick={() => toggleMark(mark)}
          >
            <Icon size={14} />
          </button>
        );
      })}
      <input
        className="canvas-feedback-note"
        aria-label={`Feedback note for ${projectRelativePath}`}
        title="Feedback note"
        value={note}
        placeholder="Note"
        onChange={(event) => scheduleNoteSave(event.currentTarget.value)}
        onBlur={flushNoteSave}
      />
    </div>
  );
}

function stopCanvasFeedbackBarEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}
