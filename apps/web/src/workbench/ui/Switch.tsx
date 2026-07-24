import React from 'react';
import { cx } from './cx';

interface SwitchProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: React.ReactNode;
}

export function Switch({
  label,
  className,
  type: _type,
  ...props
}: SwitchProps): React.ReactElement {
  return (
    <label className={cx('db-switch', className)}>
      <input {...props} type="checkbox" className="db-switch__input" />
      <span className="db-switch__track" aria-hidden="true" />
      <span className="db-switch__label">{label}</span>
    </label>
  );
}
