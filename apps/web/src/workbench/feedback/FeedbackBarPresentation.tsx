import React from 'react';
import { IconButton, MapPin, Square, type IconButtonProps } from '../ui/index';
import { useI18n } from '../i18n/index';

export const FeedbackBarMarkButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function FeedbackBarMarkButton({ className, ...props }, ref): React.ReactElement {
    return (
      <IconButton
        {...props}
        ref={ref}
        className={['canvas-feedback-mark', className].filter(Boolean).join(' ')}
      />
    );
  }
);

export function FeedbackImageRegionTools({
  mode,
  onModeChange,
  inert = false
}: {
  mode?: 'pin' | 'rect' | undefined;
  onModeChange?: ((mode: 'pin' | 'rect' | undefined) => void) | undefined;
  inert?: boolean;
}): React.ReactElement {
  const i18n = useI18n();
  return (
    <div className="canvas-feedback-local-mode" role="group" aria-label={i18n.t('canvas.feedback.imageRegionTools')}>
      <FeedbackBarMarkButton
        className={inert ? 'canvas-feedback-preview-inert' : undefined}
        label={i18n.t('canvas.feedback.addPin')}
        pressed={!inert && mode === 'pin'}
        aria-disabled={inert || undefined}
        tabIndex={inert ? -1 : undefined}
        icon={<MapPin />}
        onClick={inert ? undefined : () => onModeChange?.(mode === 'pin' ? undefined : 'pin')}
      />
      <FeedbackBarMarkButton
        className={inert ? 'canvas-feedback-preview-inert' : undefined}
        label={i18n.t('canvas.feedback.addRectangle')}
        pressed={!inert && mode === 'rect'}
        aria-disabled={inert || undefined}
        tabIndex={inert ? -1 : undefined}
        icon={<Square />}
        onClick={inert ? undefined : () => onModeChange?.(mode === 'rect' ? undefined : 'rect')}
      />
    </div>
  );
}

export function FeedbackImageBarPreview({
  barRef,
  className,
  label,
  children
}: {
  barRef: React.RefObject<HTMLDivElement | null>;
  className?: string;
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  const i18n = useI18n();
  return (
    <div
      ref={barRef}
      className={[
        'db-floating-bar',
        'canvas-feedback-bar',
        'canvas-feedback-bar--has-comment-row',
        className
      ].filter(Boolean).join(' ')}
      aria-label={label}
      data-feedback-settings-bar="true"
    >
      <div className="canvas-feedback-primary-row">
        <div className="canvas-feedback-actions">
          <div className="canvas-feedback-mark-actions" role="list">
            {children}
          </div>
          <FeedbackImageRegionTools inert />
        </div>
      </div>
      <div className="canvas-feedback-comment-row">
        <div className="canvas-feedback-comment-strip" />
        <button
          type="button"
          className="canvas-feedback-add-comment canvas-feedback-preview-inert"
          aria-disabled="true"
          tabIndex={-1}
        >
          {i18n.t('canvas.feedback.commentPlaceholder')}
        </button>
      </div>
    </div>
  );
}
