import React, { useLayoutEffect, useRef } from 'react';
import { Clock3, MapPin, Square } from '../ui/index.js';
import { CANVAS_FEEDBACK_MARKS, type CanvasFeedbackMark } from '@debrute/canvas-core';
import type { CanvasOverlayRuntime } from './CanvasOverlayRuntime';
import type { CanvasFeedbackLocalToolset } from '../shell/floatingBars';
import type { CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import type { CanvasFeedbackCapsule } from './CanvasFeedbackInteraction';
import { CANVAS_FEEDBACK_MARK_PRESENTATION } from './canvasFeedbackPresentation';
import { CloseButton, IconButton } from '../ui/index.js';
import { useI18n } from '../i18n';

const MOMENT_PILL_COLORS = [
  'var(--db-canvas-moment-1)',
  'var(--db-canvas-moment-2)',
  'var(--db-canvas-moment-3)',
  'var(--db-canvas-moment-4)',
  'var(--db-canvas-moment-5)',
  'var(--db-canvas-moment-6)'
] as const;
const FEEDBACK_TEXTAREA_MIN_WIDTH = 24;
const FEEDBACK_TEXTAREA_MAX_WIDTH = 240;
const FEEDBACK_TEXTAREA_MIN_HEIGHT = 18;
const FEEDBACK_TEXTAREA_MAX_HEIGHT = 72;

export interface CanvasFeedbackBarProps {
  projectRelativePath: string;
  capsules: readonly CanvasFeedbackCapsule[];
  focusedCapsuleId?: string | undefined;
  authoringItemId?: string | undefined;
  marks: readonly CanvasFeedbackMark[];
  onSetMarks(marks: CanvasFeedbackMark[]): void;
  overlayRuntime: CanvasOverlayRuntime;
  localToolset?: CanvasFeedbackLocalToolset | undefined;
  localFeedbackMode?: CanvasMediaFeedbackMode | undefined;
  onLocalFeedbackModeChange?: ((mode: CanvasMediaFeedbackMode) => void) | undefined;
  canStartVideoMomentFeedback?: boolean | undefined;
  onStartVideoMomentFeedback?: ((mode: 'comment' | 'pin' | 'rect') => void) | undefined;
  onCreateFileCapsule(): string;
  onCapsuleChange(itemId: string, value: string): void;
  onCapsuleFocus(itemId: string): void;
  onCapsuleBlur(itemId: string): Promise<void>;
  onCapsuleDelete(itemId: string): Promise<void>;
  onPointerEnter?: (() => void) | undefined;
  onPointerLeave?: (() => void) | undefined;
}

export function CanvasFeedbackBar({
  projectRelativePath,
  capsules,
  focusedCapsuleId,
  authoringItemId,
  marks,
  onSetMarks,
  overlayRuntime,
  localToolset = 'none',
  localFeedbackMode,
  onLocalFeedbackModeChange,
  canStartVideoMomentFeedback = false,
  onStartVideoMomentFeedback,
  onCreateFileCapsule,
  onCapsuleChange,
  onCapsuleFocus,
  onCapsuleBlur,
  onCapsuleDelete,
  onPointerEnter,
  onPointerLeave
}: CanvasFeedbackBarProps): React.ReactElement {
  const i18n = useI18n();
  const elementRef = useRef<HTMLDivElement | null>(null);
  const textareaRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const hideAddComment = Boolean(
    authoringItemId && capsules.some((capsule) => capsule.itemId === authoringItemId)
  );

  useLayoutEffect(() => {
    if (!elementRef.current) {
      return;
    }
    return overlayRuntime.bindFeedbackBar(elementRef.current);
  }, [overlayRuntime]);

  useLayoutEffect(() => {
    if (!focusedCapsuleId) {
      return;
    }
    const textarea = textareaRefs.current.get(focusedCapsuleId);
    if (!textarea || document.activeElement === textarea) {
      return;
    }
    textarea.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [capsules, focusedCapsuleId]);

  const toggleMark = (mark: CanvasFeedbackMark) => {
    const nextMarks = marks.includes(mark)
      ? marks.filter((item) => item !== mark)
      : CANVAS_FEEDBACK_MARKS.filter((item) => item === mark || marks.includes(item));
    onSetMarks(nextMarks);
  };

  return (
    <div
      ref={elementRef}
      className="db-floating-bar canvas-feedback-bar canvas-feedback-bar--has-comment-row"
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
            const { labelKey, Icon } = CANVAS_FEEDBACK_MARK_PRESENTATION[mark];
            return (
              <IconButton
                key={mark}
                className="canvas-feedback-mark"
                label={i18n.t(labelKey)}
                pressed={marks.includes(mark)}
                icon={<Icon />}
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
                icon={<MapPin />}
                onClick={() => onLocalFeedbackModeChange?.(localFeedbackMode === 'pin' ? undefined : 'pin')}
              />
              <IconButton
                className="canvas-feedback-mark"
                label={i18n.t('canvas.feedback.addRectangle')}
                pressed={localFeedbackMode === 'rect'}
                icon={<Square />}
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
                icon={<Clock3 />}
                onClick={() => onStartVideoMomentFeedback?.('comment')}
              />
              <IconButton
                className="canvas-feedback-mark"
                label={i18n.t('canvas.feedback.addPin')}
                disabled={!canStartVideoMomentFeedback}
                pressed={localFeedbackMode === 'pin'}
                icon={<MapPin />}
                onClick={() => onStartVideoMomentFeedback?.('pin')}
              />
              <IconButton
                className="canvas-feedback-mark"
                label={i18n.t('canvas.feedback.addRectangle')}
                disabled={!canStartVideoMomentFeedback}
                pressed={localFeedbackMode === 'rect'}
                icon={<Square />}
                onClick={() => onStartVideoMomentFeedback?.('rect')}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="canvas-feedback-comment-strip" aria-label={i18n.t('canvas.feedback.commentsForFile', { path: projectRelativePath })}>
        {capsules.map((capsule) => (
          <FeedbackCapsule
            key={capsule.itemId}
            capsule={capsule}
            registerTextarea={(textarea) => {
              if (textarea) {
                textareaRefs.current.set(capsule.itemId, textarea);
              } else {
                textareaRefs.current.delete(capsule.itemId);
              }
            }}
            onChange={onCapsuleChange}
            onFocus={onCapsuleFocus}
            onBlur={onCapsuleBlur}
            onDelete={onCapsuleDelete}
          />
        ))}
        {!hideAddComment ? (
          <button
            type="button"
            className="canvas-feedback-add-comment"
            data-canvas-feedback-add-comment="true"
            aria-label={i18n.t('canvas.feedback.newFileCommentForFile', { path: projectRelativePath })}
            title={i18n.t('canvas.feedback.newFileComment')}
            onClick={() => onCreateFileCapsule()}
          >
            + {i18n.t('canvas.feedback.commentPlaceholder')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FeedbackCapsule({
  capsule,
  registerTextarea,
  onChange,
  onFocus,
  onBlur,
  onDelete
}: {
  capsule: CanvasFeedbackCapsule;
  registerTextarea(textarea: HTMLTextAreaElement | null): void;
  onChange(itemId: string, value: string): void;
  onFocus(itemId: string): void;
  onBlur(itemId: string): Promise<void>;
  onDelete(itemId: string): Promise<void>;
}): React.ReactElement {
  const i18n = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const spatial = capsule.kind === 'pin' || capsule.kind === 'region';
  const className = [
    'canvas-feedback-comment-pill',
    capsule.scope === 'file' ? 'canvas-feedback-comment-pill--file' : 'canvas-feedback-comment-pill--moment',
    spatial ? 'canvas-feedback-comment-pill--spatial' : undefined,
    capsule.unsynchronized ? 'canvas-feedback-comment-pill--active-surface' : undefined
  ].filter(Boolean).join(' ');

  useLayoutEffect(() => {
    if (textareaRef.current) {
      resizeFeedbackTextarea(textareaRef.current);
    }
  }, [capsule.comment]);

  return (
    <span
      className={className}
      data-canvas-feedback-item-id={capsule.itemId}
      data-canvas-feedback-moment={capsule.momentLabel}
      data-canvas-feedback-region-label={spatial ? capsule.label : undefined}
      data-unsynchronized={capsule.unsynchronized ? 'true' : undefined}
      style={capsule.momentLabel
        ? { '--canvas-feedback-moment-color': momentColor(capsule.momentLabel) } as React.CSSProperties
        : undefined}
      onPointerDown={(event) => {
        if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLButtonElement) {
          return;
        }
        event.preventDefault();
        textareaRef.current?.focus();
      }}
    >
      {capsule.momentLabel ? (
        <span className="canvas-feedback-comment-pill-moment-badge" aria-hidden="true">{capsule.momentLabel}</span>
      ) : null}
      <textarea
        ref={(textarea) => {
          textareaRef.current = textarea;
          registerTextarea(textarea);
        }}
        className="canvas-feedback-comment-textarea"
        data-canvas-local-wheel="focus"
        aria-label={capsuleAriaLabel(capsule, i18n)}
        rows={1}
        value={capsule.comment}
        placeholder={i18n.t('canvas.feedback.commentPlaceholder')}
        onInput={(event) => {
          resizeFeedbackTextarea(event.currentTarget);
          onChange(capsule.itemId, event.currentTarget.value);
        }}
        onFocus={() => onFocus(capsule.itemId)}
        onBlur={() => { void onBlur(capsule.itemId); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.blur();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {spatial && capsule.label !== undefined ? (
        <span className="canvas-feedback-comment-pill-badge" aria-hidden="true">{capsule.label}</span>
      ) : null}
      <CloseButton
        className="canvas-feedback-comment-pill-close"
        label={i18n.t('canvas.feedback.deleteItem')}
        title={i18n.t('canvas.feedback.deleteItem')}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void onDelete(capsule.itemId);
        }}
      />
    </span>
  );
}

function capsuleAriaLabel(
  capsule: CanvasFeedbackCapsule,
  i18n: ReturnType<typeof useI18n>
): string {
  if (capsule.scope === 'moment' && capsule.momentTimeSeconds !== undefined) {
    return i18n.t('canvas.feedback.videoMomentItem', { seconds: capsule.momentTimeSeconds });
  }
  if ((capsule.kind === 'pin' || capsule.kind === 'region') && capsule.label !== undefined) {
    return i18n.t('canvas.feedback.region', { index: capsule.label });
  }
  return i18n.t('canvas.feedback.fileLevelComment', { path: capsule.projectRelativePath });
}

function resizeFeedbackTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.width = `${FEEDBACK_TEXTAREA_MIN_WIDTH}px`;
  textarea.style.whiteSpace = 'pre';
  textarea.style.overflowWrap = 'normal';
  const contentWidth = textarea.scrollWidth;
  textarea.style.removeProperty('white-space');
  textarea.style.removeProperty('overflow-wrap');
  textarea.style.width = `${Math.min(
    FEEDBACK_TEXTAREA_MAX_WIDTH,
    Math.max(FEEDBACK_TEXTAREA_MIN_WIDTH, Math.ceil(contentWidth))
  )}px`;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(
    FEEDBACK_TEXTAREA_MAX_HEIGHT,
    Math.max(FEEDBACK_TEXTAREA_MIN_HEIGHT, textarea.scrollHeight)
  )}px`;
}

function momentColor(label: string): string {
  const match = /^M([1-9][0-9]*)$/.exec(label);
  const index = match ? Number(match[1]) - 1 : 0;
  return MOMENT_PILL_COLORS[index % MOMENT_PILL_COLORS.length]!;
}

function stopCanvasFeedbackBarEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}
