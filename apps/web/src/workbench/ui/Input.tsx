import React from 'react';
import { cx } from './cx';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export function Input({ invalid, className, type = 'text', ...props }: InputProps): React.ReactElement {
  return (
    <input
      {...props}
      type={type}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
      className={cx('db-input', invalid && 'db-input--invalid', className)}
    />
  );
}

export function SecretInput({
  className,
  masked = true,
  invalid,
  ...props
}: Omit<InputProps, 'type'> & { masked?: boolean }): React.ReactElement {
  return (
    <input
      {...props}
      type="text"
      aria-invalid={invalid || props['aria-invalid'] || undefined}
      className={cx('db-input', masked && 'db-input--secret', invalid && 'db-input--invalid', className)}
    />
  );
}
