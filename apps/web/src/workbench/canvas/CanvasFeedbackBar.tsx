import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Clock3,
  MapPin,
  Square,
  X
} from 'lucide-react';
import {
  CANVAS_FEEDBACK_MARKS,
  type CanvasFeedbackEntry,
  type CanvasFeedbackItem,
  type CanvasFeedbackMark
} from '@debrute/canvas-core';
import type { WorkbenchActions } from '../../types';
import type { CanvasOverlayRuntime } from './CanvasOverlayRuntime';
import type { CanvasFeedbackLocalToolset } from '../shell/floatingBars';
import type { CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import { CANVAS_FEEDBACK_MARK_PRESENTATION } from './canvasFeedbackPresentation';
import { CommentPillInput, IconButton } from '../ui';
import { useI18n } from '../i18n';

const MOMENT_PILL_COLORS = [
  '#2563eb',
  '#16a34a',
  '#dc2626',
  '#9333ea',
  '#0891b2',
  '#ca8a04'
] as const;

export function CanvasFeedbackBar({
  projectRelativePath,
  entry,
  onUpdate,
  overlayRuntime,
  localToolset = 'none',
  localFeedbackMode,
  onLocalFeedbackModeChange,
  canStartVideoMomentFeedback = false,
  onStartVideoMomentFeedback,
  pendingItemLabel,
  pendingItemComment,
  pendingItemReadyForComment = true,
  onPendingItemCommentChange,
  onSavePendingItem,
  onCancelPendingItem,
  onSeekToMoment,
  onPointerEnter,
  onPointerLeave
}: {
  projectRelativePath: string;
  entry: CanvasFeedbackEntry | undefined;
  onUpdate: WorkbenchActions['updateCanvasFeedbackEntry'];
  overlayRuntime: CanvasOverlayRuntime;
  localToolset?: CanvasFeedbackLocalToolset | undefined;
  localFeedbackMode?: CanvasMediaFeedbackMode | undefined;
  onLocalFeedbackModeChange?: ((mode: CanvasMediaFeedbackMode) => void) | undefined;
  canStartVideoMomentFeedback?: boolean | undefined;
  onStartVideoMomentFeedback?: ((mode: 'comment' | 'pin' | 'rect') => void) | undefined;
  pendingItemLabel?: number | string | undefined;
  pendingItemComment?: string | undefined;
  pendingItemReadyForComment?: boolean | undefined;
  onPendingItemCommentChange?: ((comment: string) => void) | undefined;
  onSavePendingItem?: (() => boolean | Promise<boolean> | undefined) | undefined;
  onCancelPendingItem?: (() => void) | undefined;
  onSeekToMoment?: ((seconds: number) => void) | undefined;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}): React.ReactElement {
  const i18n = useI18n();
  const elementRef = useRef<HTMLDivElement | null>(null);
  const creatorInputRef = useRef<HTMLInputElement | null>(null);
  const pendingItemFocusTimerRef = useRef<number | undefined>(undefined);
  const [draftComment, setDraftComment] = useState('');
  const [marks, setMarks] = useState<CanvasFeedbackMark[]>(entry?.marks ?? []);
  const draftCommentRef = useRef('');
  const pendingItemCommentRef = useRef(pendingItemComment ?? '');
  const creatorSaveInFlightRef = useRef<string | undefined>(undefined);
  const pendingItemSaveInFlightRef = useRef<string | undefined>(undefined);
  const hasPendingItemDraft = Boolean(onSavePendingItem && pendingItemReadyForComment);
  const hasItemRow = Boolean((entry?.items.length ?? 0) > 0);
  const creatorValue = hasPendingItemDraft ? pendingItemComment ?? '' : draftComment;
  const creatorLabel = hasPendingItemDraft
    ? i18n.t('canvas.feedback.newAnnotationCommentForFile', { path: projectRelativePath })
    : i18n.t('canvas.feedback.newFileCommentForFile', { path: projectRelativePath });
  const creatorTitle = hasPendingItemDraft ? i18n.t('canvas.feedback.newAnnotationComment') : i18n.t('canvas.feedback.newFileComment');
  const pendingItemFocusKey = hasPendingItemDraft
    ? `${projectRelativePath}:${pendingItemLabel ?? 'pending'}`
    : undefined;

  useEffect(() => {
    setMarks(entry?.marks ?? []);
  }, [entry]);

  useEffect(() => {
    draftCommentRef.current = '';
    setDraftComment('');
  }, [projectRelativePath]);

  useEffect(() => {
    pendingItemCommentRef.current = pendingItemComment ?? '';
  }, [pendingItemComment]);

  useEffect(() => {
    pendingItemSaveInFlightRef.current = undefined;
  }, [pendingItemFocusKey, pendingItemComment]);

  useLayoutEffect(() => {
    if (!elementRef.current) {
      return;
    }
    return overlayRuntime.bindFeedbackBar(elementRef.current);
  }, [overlayRuntime]);

  useLayoutEffect(() => {
    if (pendingItemFocusTimerRef.current !== undefined) {
      window.clearTimeout(pendingItemFocusTimerRef.current);
      pendingItemFocusTimerRef.current = undefined;
    }
    if (!pendingItemFocusKey) {
      return undefined;
    }
    pendingItemFocusTimerRef.current = window.setTimeout(() => {
      pendingItemFocusTimerRef.current = undefined;
      creatorInputRef.current?.focus();
    }, 0);
    return () => {
      if (pendingItemFocusTimerRef.current !== undefined) {
        window.clearTimeout(pendingItemFocusTimerRef.current);
        pendingItemFocusTimerRef.current = undefined;
      }
    };
  }, [pendingItemFocusKey]);

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
      operation: 'add-item',
      projectRelativePath,
      item: {
        kind: 'comment',
        scope: 'file',
        comment
      }
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
    if (hasPendingItemDraft) {
      const comment = pendingItemCommentRef.current.trim();
      if (comment) {
        if (pendingItemSaveInFlightRef.current === comment) {
          return;
        }
        pendingItemSaveInFlightRef.current = comment;
        const saved = await onSavePendingItem?.();
        if (saved === false && pendingItemSaveInFlightRef.current === comment) {
          pendingItemSaveInFlightRef.current = undefined;
        }
      }
      return;
    }
    await saveFileDraftComment();
  };

  return (
    <div
      ref={elementRef}
      className={`db-floating-bar canvas-feedback-bar${hasItemRow ? ' canvas-feedback-bar--has-comment-row' : ''}`}
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
        <div className="canvas-feedback-actions" role="group" aria-label={i18n.t('canvas.feedback.actions')}>
          {CANVAS_FEEDBACK_MARKS.map((mark) => {
            const pressed = marks.includes(mark);
            const { labelKey, Icon } = CANVAS_FEEDBACK_MARK_PRESENTATION[mark];
            return (
              <IconButton
                key={mark}
                className="canvas-feedback-mark"
                label={i18n.t(labelKey)}
                pressed={pressed}
                icon={<Icon size={14} />}
                onClick={() => toggleMark(mark)}
              />
            );
          })}
          {localToolset === 'image' ? (
            <div className="canvas-feedback-local-mode" role="group" aria-label={i18n.t('canvas.feedback.imageRegionTools')}>
              <IconButton
                className="canvas-feedback-mark"
                label={i18n.t('canvas.feedback.addPin')}
                pressed={localFeedbackMode === 'pin'}
                icon={<MapPin size={14} />}
                onClick={() => onLocalFeedbackModeChange?.(localFeedbackMode === 'pin' ? undefined : 'pin')}
              />
              <IconButton
                className="canvas-feedback-mark"
                label={i18n.t('canvas.feedback.addRectangle')}
                pressed={localFeedbackMode === 'rect'}
                icon={<Square size={14} />}
                onClick={() => onLocalFeedbackModeChange?.(localFeedbackMode === 'rect' ? undefined : 'rect')}
              />
            </div>
          ) : null}
          {localToolset === 'video' ? (
            <div className="canvas-feedback-local-mode" role="group" aria-label={i18n.t('canvas.feedback.videoMomentTools')}>
              <IconButton
                className="canvas-feedback-mark"
                label={i18n.t('canvas.feedback.addMomentComment')}
                disabled={!canStartVideoMomentFeedback}
                icon={<Clock3 size={14} />}
                onClick={() => onStartVideoMomentFeedback?.('comment')}
              />
              <IconButton
                className="canvas-feedback-mark"
                label={i18n.t('canvas.feedback.addPin')}
                disabled={!canStartVideoMomentFeedback}
                pressed={localFeedbackMode === 'pin'}
                icon={<MapPin size={14} />}
                onClick={() => onStartVideoMomentFeedback?.('pin')}
              />
              <IconButton
                className="canvas-feedback-mark"
                label={i18n.t('canvas.feedback.addRectangle')}
                disabled={!canStartVideoMomentFeedback}
                pressed={localFeedbackMode === 'rect'}
                icon={<Square size={14} />}
                onClick={() => onStartVideoMomentFeedback?.('rect')}
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
          placeholder={i18n.t('canvas.feedback.commentPlaceholder')}
          autoFocus={hasPendingItemDraft}
          sizing={{ minWidthPx: 110, maxWidthPx: 110 }}
          onChange={(event) => {
            if (hasPendingItemDraft) {
              pendingItemCommentRef.current = event.currentTarget.value;
              onPendingItemCommentChange?.(event.currentTarget.value);
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
              if (hasPendingItemDraft) {
                pendingItemCommentRef.current = '';
                onCancelPendingItem?.();
                return;
              }
              draftCommentRef.current = '';
              setDraftComment('');
            }
          }}
          onBlur={() => { void saveCreatorComment(); }}
        />
      </div>

      {hasItemRow ? (
        <div className="canvas-feedback-comment-strip" aria-label={i18n.t('canvas.feedback.commentsForFile', { path: projectRelativePath })}>
          {entry?.items.map((item) => (
            <FeedbackItemPill
              key={item.id}
              item={item}
              projectRelativePath={projectRelativePath}
              onUpdate={onUpdate}
              onSeekToMoment={onSeekToMoment}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FeedbackItemPill({
  item,
  projectRelativePath,
  onUpdate,
  onSeekToMoment
}: {
  item: CanvasFeedbackItem;
  projectRelativePath: string;
  onUpdate: WorkbenchActions['updateCanvasFeedbackEntry'];
  onSeekToMoment?: ((seconds: number) => void) | undefined;
}): React.ReactElement {
  const i18n = useI18n();
  const spatial = item.kind === 'pin' || item.kind === 'region';
  const moment = item.scope === 'moment' ? item.moment : undefined;
  const className = [
    'canvas-feedback-comment-pill',
    item.scope === 'file' ? 'canvas-feedback-comment-pill--file' : 'canvas-feedback-comment-pill--moment',
    spatial ? 'canvas-feedback-comment-pill--spatial' : undefined
  ].filter(Boolean).join(' ');
  return (
    <span
      className={className}
      title={pillTitle(item, i18n, projectRelativePath)}
      data-canvas-local-wheel="true"
      data-canvas-feedback-moment={moment?.label}
      data-canvas-feedback-region-label={spatial ? item.label : undefined}
      style={moment ? { '--canvas-feedback-moment-color': momentColor(moment.label) } as React.CSSProperties : undefined}
      onClick={() => {
        if (moment) {
          onSeekToMoment?.(moment.currentTimeSeconds);
        }
      }}
    >
      <span className="canvas-feedback-comment-pill-text">{item.comment}</span>
      {spatial ? <span className="canvas-feedback-comment-pill-badge" aria-hidden="true">{item.label}</span> : null}
      <IconButton
        className="canvas-feedback-comment-pill-close"
        label={i18n.t('canvas.feedback.deleteItem')}
        title={i18n.t('canvas.feedback.deleteItem')}
        icon={<X size={11} strokeWidth={2.4} />}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void onUpdate({
            operation: 'delete-item',
            projectRelativePath,
            itemId: item.id
          });
        }}
      />
    </span>
  );
}

function pillTitle(item: CanvasFeedbackItem, i18n: ReturnType<typeof useI18n>, projectRelativePath: string): string {
  if (item.scope === 'moment') {
    return i18n.t('canvas.feedback.videoMomentItem', { seconds: item.moment.currentTimeSeconds });
  }
  if (item.kind === 'pin' || item.kind === 'region') {
    return i18n.t('canvas.feedback.region', { index: item.label });
  }
  return i18n.t('canvas.feedback.fileLevelComment', { path: projectRelativePath });
}

function momentColor(label: string): string {
  const match = /^M([1-9][0-9]*)$/.exec(label);
  const index = match ? Number(match[1]) - 1 : 0;
  return MOMENT_PILL_COLORS[index % MOMENT_PILL_COLORS.length]!;
}

function stopCanvasFeedbackBarEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}
