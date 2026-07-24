import React from 'react';
import { cx } from './cx';

type IconButtonVariant = 'ghost' | 'danger' | 'chrome' | 'window-close';
type IconButtonSize = 'xs' | 'sm' | 'window';

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  icon: React.ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  pressed?: boolean;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'sm',
  pressed,
  className,
  type = 'button',
  ...props
}, ref): React.ReactElement {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={label}
      title={props.title ?? label}
      aria-pressed={pressed}
      className={cx('db-icon-button', `db-icon-button--${variant}`, `db-icon-button--${size}`, className)}
    >
      <span className="db-icon-button__icon" aria-hidden="true">{icon}</span>
    </button>
  );
});
