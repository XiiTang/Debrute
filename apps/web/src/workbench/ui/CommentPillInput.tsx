import React from 'react';
import { cx } from './cx';

interface CommentPillInputSizing {
  minWidthPx?: number;
  maxWidthPx?: number;
}

interface CommentPillInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'children'> {
  inputClassName?: string;
  sizing?: CommentPillInputSizing;
}

export const CommentPillInput = React.forwardRef<HTMLInputElement, CommentPillInputProps>(function CommentPillInput({
  className,
  disabled,
  inputClassName,
  sizing,
  type = 'text',
  ...props
}, ref): React.ReactElement {
  const sizingStyle: React.CSSProperties & Record<string, string | number | undefined> = {
    '--db-comment-pill-input-ch': commentPillInputCharacterCount(props.value, props.placeholder),
    ...(sizing?.minWidthPx ? { '--db-comment-pill-min-width': `${sizing.minWidthPx}px` } : {}),
    ...(sizing?.maxWidthPx ? { '--db-comment-pill-max-width': `${sizing.maxWidthPx}px` } : {})
  };

  return (
    <span
      style={sizingStyle}
      className={cx(
        'db-comment-pill-input',
        disabled && 'db-comment-pill-input--disabled',
        className
      )}
    >
      <input
        {...props}
        ref={ref}
        type={type}
        disabled={disabled}
        className={cx('db-comment-pill-input__field', inputClassName)}
      />
    </span>
  );
});

function commentPillInputCharacterCount(
  value: React.InputHTMLAttributes<HTMLInputElement>['value'],
  placeholder: React.InputHTMLAttributes<HTMLInputElement>['placeholder']
): number {
  const text = value === undefined || value === null || value === ''
    ? placeholder ?? ''
    : String(value);
  return Math.max(6, Math.min(36, Array.from(text).length + 1));
}
