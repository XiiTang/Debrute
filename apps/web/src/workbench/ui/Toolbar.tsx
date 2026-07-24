import React from 'react';
import { cx } from './cx';

export function Toolbar({
  ariaLabel,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  ariaLabel: string;
}): React.ReactElement {
  return (
    <div
      {...props}
      role="toolbar"
      aria-label={ariaLabel}
      className={cx('db-toolbar', className)}
    />
  );
}
