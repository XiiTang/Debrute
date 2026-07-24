import React from 'react';
import { cx } from './cx';

type ButtonVariant = 'default' | 'primary';
export type ButtonSize = 'xs' | 'sm' | 'md';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconStart?: React.ReactNode;
  loading?: boolean;
  pressed?: boolean;
}

export function Button({
  variant = 'default',
  size = 'md',
  iconStart,
  loading = false,
  pressed,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps): React.ReactElement {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-pressed={pressed}
      className={cx('db-button', `db-button--${variant}`, `db-button--${size}`, className)}
    >
      {loading ? <span className="db-button__spinner" aria-hidden="true" /> : iconStart ? <span className="db-button__icon">{iconStart}</span> : null}
      <span className="db-button__label">{children}</span>
    </button>
  );
}
