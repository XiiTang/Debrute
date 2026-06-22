import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CircleDot,
  Heart,
  MapPin,
  Square,
  Star,
  ThumbsDown,
  Trash2,
  X,
  type LucideIcon
} from 'lucide-react';
import {
  CANVAS_FEEDBACK_MARKS,
  type CanvasFeedbackEntry,
  type CanvasFeedbackMark
} from '@debrute/canvas-core';
import type { WorkbenchActions } from '../../types';
import type { CanvasOverlayRuntime } from './CanvasOverlayRuntime';
import type { CanvasImageFeedbackMode } from './CanvasImageFeedbackLayer';
import { IconButton, Input } from '../ui';

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
  overlayRuntime,
  localFeedbackMode,
  onLocalFeedbackModeChange,
  pendingRegionComment,
  onPendingRegionCommentChange,
  onSavePendingRegion,
  onCancelPendingRegion,
  onPointerEnter,
  onPointerLeave
}: {
  projectRelativePath: string;
  entry: CanvasFeedbackEntry | undefined;
  onUpdate: WorkbenchActions['updateCanvasFeedbackEntry'];
  overlayRuntime: CanvasOverlayRuntime;
  localFeedbackMode?: CanvasImageFeedbackMode | undefined;
  onLocalFeedbackModeChange?: ((mode: CanvasImageFeedbackMode) => void) | undefined;
  pendingRegionComment?: string | undefined;
  onPendingRegionCommentChange?: ((comment: string) => void) | undefined;
  onSavePendingRegion?: (() => void) | undefined;
  onCancelPendingRegion?: (() => void) | undefined;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}): React.ReactElement {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [marks, setMarks] = useState<CanvasFeedbackMark[]>(entry?.marks ?? []);
  const [note, setNote] = useState(entry?.note ?? '');
  const [regionComments, setRegionComments] = useState<Record<string, string>>(() => (
    Object.fromEntries((entry?.regions ?? []).map((region) => [region.id, region.comment]))
  ));
  const saveTimerRef = useRef<number | undefined>(undefined);
  const localFeedbackEnabled = Boolean(onLocalFeedbackModeChange);
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
    setRegionComments(Object.fromEntries((entry?.regions ?? []).map((region) => [region.id, region.comment])));
    latestSaveRef.current = next;
  }, [entry, projectRelativePath]);

  useEffect(() => () => {
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    if (!elementRef.current) {
      return;
    }
    return overlayRuntime.bindFeedbackBar(elementRef.current);
  }, [overlayRuntime]);

  const saveFeedback = (next: { marks: CanvasFeedbackMark[]; note: string }) => {
    latestSaveRef.current = next;
    void onUpdate({
      operation: 'set-entry',
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

  const updateRegionComment = (regionId: string, comment: string) => {
    setRegionComments((current) => ({
      ...current,
      [regionId]: comment
    }));
  };

  const saveRegionComment = (region: CanvasFeedbackEntry['regions'][number]) => {
    const comment = (regionComments[region.id] ?? region.comment).trim();
    if (!comment) {
      updateRegionComment(region.id, region.comment);
      return;
    }
    if (comment === region.comment) {
      return;
    }
    void onUpdate({
      operation: 'update-region',
      projectRelativePath,
      regionId: region.id,
      comment
    });
  };

  return (
    <div
      ref={elementRef}
      className="db-floating-bar canvas-feedback-bar"
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
        const pressed = marks.includes(mark);
        const { label, Icon } = FEEDBACK_MARKS[mark];
        return (
          <IconButton
            key={mark}
            className="canvas-feedback-mark"
            label={label}
            pressed={pressed}
            icon={<Icon size={14} />}
            onClick={() => toggleMark(mark)}
          />
        );
      })}
      {localFeedbackEnabled ? (
        <div className="canvas-feedback-local-mode" role="group" aria-label="Image region feedback tools">
          <IconButton
            className="canvas-feedback-mark"
            label="Add feedback pin"
            pressed={localFeedbackMode === 'pin'}
            icon={<MapPin size={14} />}
            onClick={() => onLocalFeedbackModeChange?.(localFeedbackMode === 'pin' ? undefined : 'pin')}
          />
          <IconButton
            className="canvas-feedback-mark"
            label="Add feedback rectangle"
            pressed={localFeedbackMode === 'rect'}
            icon={<Square size={14} />}
            onClick={() => onLocalFeedbackModeChange?.(localFeedbackMode === 'rect' ? undefined : 'rect')}
          />
        </div>
      ) : null}
      <Input
        className="canvas-feedback-note"
        data-canvas-local-wheel="true"
        aria-label={`Feedback note for ${projectRelativePath}`}
        title="Feedback note"
        value={note}
        placeholder="Note"
        onChange={(event) => scheduleNoteSave(event.currentTarget.value)}
        onBlur={flushNoteSave}
      />
      {localFeedbackEnabled && onSavePendingRegion ? (
        <div className="canvas-feedback-region-row pending">
          <span>New</span>
          <Input
            className="canvas-feedback-region-comment"
            data-canvas-local-wheel="true"
            aria-label={`New region feedback for ${projectRelativePath}`}
            title="Region feedback"
            value={pendingRegionComment ?? ''}
            placeholder="Comment"
            onChange={(event) => onPendingRegionCommentChange?.(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                onSavePendingRegion();
              }
              if (event.key === 'Escape') {
                onCancelPendingRegion?.();
              }
            }}
            onBlur={() => {
              if ((pendingRegionComment ?? '').trim()) {
                onSavePendingRegion();
              }
            }}
          />
        </div>
      ) : null}
      {localFeedbackEnabled && entry?.regions.length ? (
        <div className="canvas-feedback-regions">
          {entry.regions.map((region) => (
            <div
              key={region.id}
              className="canvas-feedback-region-row"
              data-canvas-feedback-region-label={region.label}
            >
              <span>{region.label}</span>
              <Input
                className="canvas-feedback-region-comment"
                data-canvas-local-wheel="true"
                aria-label={`Feedback for region ${region.label}`}
                title={`Feedback for region ${region.label}`}
                value={regionComments[region.id] ?? region.comment}
                onChange={(event) => updateRegionComment(region.id, event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    saveRegionComment(region);
                  }
                  if (event.key === 'Escape') {
                    updateRegionComment(region.id, region.comment);
                  }
                }}
                onBlur={() => saveRegionComment(region)}
              />
              <IconButton
                className="canvas-feedback-region-delete"
                label={`Delete feedback region ${region.label}`}
                title="Delete"
                icon={<Trash2 size={13} />}
                onClick={() => {
                  void onUpdate({
                    operation: 'delete-region',
                    projectRelativePath,
                    regionId: region.id
                  });
                }}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function stopCanvasFeedbackBarEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}
