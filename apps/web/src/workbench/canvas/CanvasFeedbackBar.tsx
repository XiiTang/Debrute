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
import { CommentPillInput, IconButton } from '../ui';

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
  pendingRegionLabel,
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
  pendingRegionLabel?: number | undefined;
  pendingRegionComment?: string | undefined;
  onPendingRegionCommentChange?: ((comment: string) => void) | undefined;
  onSavePendingRegion?: (() => void) | undefined;
  onCancelPendingRegion?: (() => void) | undefined;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}): React.ReactElement {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const creatorInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRegionFocusTimerRef = useRef<number | undefined>(undefined);
  const [draftComment, setDraftComment] = useState('');
  const [marks, setMarks] = useState<CanvasFeedbackMark[]>(entry?.marks ?? []);
  const draftCommentRef = useRef('');
  const pendingRegionCommentRef = useRef(pendingRegionComment ?? '');
  const creatorSaveInFlightRef = useRef<string | undefined>(undefined);
  const localFeedbackEnabled = Boolean(onLocalFeedbackModeChange);
  const hasPendingRegionDraft = localFeedbackEnabled && Boolean(onSavePendingRegion);
  const hasCommentRow = Boolean((entry?.comments.length ?? 0) > 0 || (entry?.regions.length ?? 0) > 0);
  const creatorValue = hasPendingRegionDraft ? pendingRegionComment ?? '' : draftComment;
  const creatorLabel = hasPendingRegionDraft
    ? `New annotation comment for ${projectRelativePath}`
    : `New file-level comment for ${projectRelativePath}`;
  const creatorTitle = hasPendingRegionDraft ? 'New annotation comment' : 'New file-level comment';
  const pendingRegionFocusKey = hasPendingRegionDraft
    ? `${projectRelativePath}:${pendingRegionLabel ?? 'pending'}`
    : undefined;

  useEffect(() => {
    setMarks(entry?.marks ?? []);
  }, [entry]);

  useEffect(() => {
    draftCommentRef.current = '';
    setDraftComment('');
  }, [projectRelativePath]);

  useEffect(() => {
    pendingRegionCommentRef.current = pendingRegionComment ?? '';
  }, [pendingRegionComment]);

  useLayoutEffect(() => {
    if (!elementRef.current) {
      return;
    }
    return overlayRuntime.bindFeedbackBar(elementRef.current);
  }, [overlayRuntime]);

  useLayoutEffect(() => {
    if (pendingRegionFocusTimerRef.current !== undefined) {
      window.clearTimeout(pendingRegionFocusTimerRef.current);
      pendingRegionFocusTimerRef.current = undefined;
    }
    if (!pendingRegionFocusKey) {
      return undefined;
    }
    pendingRegionFocusTimerRef.current = window.setTimeout(() => {
      pendingRegionFocusTimerRef.current = undefined;
      creatorInputRef.current?.focus();
    }, 0);
    return () => {
      if (pendingRegionFocusTimerRef.current !== undefined) {
        window.clearTimeout(pendingRegionFocusTimerRef.current);
        pendingRegionFocusTimerRef.current = undefined;
      }
    };
  }, [pendingRegionFocusKey]);

  const toggleMark = (mark: CanvasFeedbackMark) => {
    const nextMarks = marks.includes(mark)
      ? marks.filter((item) => item !== mark)
      : CANVAS_FEEDBACK_MARKS.filter((item) => item === mark || marks.includes(item));
    setMarks(nextMarks);
    void onUpdate({
      operation: 'set-marks',
      projectRelativePath,
      marks: nextMarks
    });
  };

  const saveFileDraftComment = async () => {
    const comment = draftCommentRef.current.trim();
    if (!comment) {
      draftCommentRef.current = '';
      setDraftComment('');
      return;
    }
    if (creatorSaveInFlightRef.current === comment) {
      return;
    }
    creatorSaveInFlightRef.current = comment;
    const saved = await onUpdate({
      operation: 'add-comment',
      projectRelativePath,
      comment
    });
    if (creatorSaveInFlightRef.current === comment) {
      creatorSaveInFlightRef.current = undefined;
    }
    if (saved && draftCommentRef.current.trim() === comment) {
      draftCommentRef.current = '';
      setDraftComment('');
    }
  };

  const saveCreatorComment = async () => {
    if (hasPendingRegionDraft) {
      if (pendingRegionCommentRef.current.trim()) {
        onSavePendingRegion?.();
      }
      return;
    }
    await saveFileDraftComment();
  };

  return (
    <div
      ref={elementRef}
      className={`db-floating-bar canvas-feedback-bar${hasCommentRow ? ' canvas-feedback-bar--has-comment-row' : ''}`}
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
      <div className="canvas-feedback-primary-row">
        <div className="canvas-feedback-actions" role="group" aria-label="Canvas feedback actions">
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
        </div>
        <CommentPillInput
          ref={creatorInputRef}
          className="canvas-feedback-comment-creator"
          inputClassName="canvas-feedback-comment-input"
          data-canvas-local-wheel="focus"
          aria-label={creatorLabel}
          title={creatorTitle}
          value={creatorValue}
          placeholder="Comment"
          autoFocus={hasPendingRegionDraft}
          sizing={{ minWidthPx: 90, maxWidthPx: 90 }}
          onChange={(event) => {
            if (hasPendingRegionDraft) {
              pendingRegionCommentRef.current = event.currentTarget.value;
              onPendingRegionCommentChange?.(event.currentTarget.value);
              return;
            }
            draftCommentRef.current = event.currentTarget.value;
            setDraftComment(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void saveCreatorComment();
            }
            if (event.key === 'Escape') {
              if (hasPendingRegionDraft) {
                pendingRegionCommentRef.current = '';
                onCancelPendingRegion?.();
                return;
              }
              draftCommentRef.current = '';
              setDraftComment('');
            }
          }}
          onBlur={() => { void saveCreatorComment(); }}
        />
      </div>

      {hasCommentRow ? (
        <div className="canvas-feedback-comment-strip" aria-label={`Feedback comments for ${projectRelativePath}`}>
          {entry?.comments.map((fileComment) => (
            <span
              key={fileComment.id}
              className="canvas-feedback-comment-pill canvas-feedback-comment-pill--file"
              title="File-level comment"
              data-canvas-local-wheel="true"
            >
              <span className="canvas-feedback-comment-pill-text">{fileComment.comment}</span>
              <IconButton
                className="canvas-feedback-comment-pill-close"
                label={`Delete file-level comment for ${projectRelativePath}`}
                title={`Delete file-level comment for ${projectRelativePath}`}
                icon={<X size={11} strokeWidth={2.4} />}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void onUpdate({
                    operation: 'delete-comment',
                    projectRelativePath,
                    commentId: fileComment.id
                  });
                }}
              />
            </span>
          ))}
          {localFeedbackEnabled && entry?.regions.length ? entry.regions.map((region) => (
            <span
              key={region.id}
              className="canvas-feedback-comment-pill canvas-feedback-comment-pill--region"
              data-canvas-feedback-region-label={region.label}
              data-canvas-local-wheel="true"
              title={`Feedback for region ${region.label}`}
            >
              <span className="canvas-feedback-comment-pill-text">{region.comment}</span>
              <span className="canvas-feedback-comment-pill-badge" aria-hidden="true">{region.label}</span>
              <IconButton
                className="canvas-feedback-comment-pill-close"
                label={`Delete feedback region ${region.label}`}
                title={`Delete feedback region ${region.label}`}
                icon={<X size={11} strokeWidth={2.4} />}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void onUpdate({
                    operation: 'delete-region',
                    projectRelativePath,
                    regionId: region.id
                  });
                }}
              />
            </span>
          )) : null}
        </div>
      ) : null}
    </div>
  );
}

function stopCanvasFeedbackBarEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}
