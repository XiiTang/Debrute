import React from 'react';
import { cx } from './cx';

export type StatusTone = 'neutral' | 'warning' | 'danger' | 'info' | 'loading';

export function StatusPill({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: StatusTone }): React.ReactElement {
  return <span {...props} className={cx('db-status-pill', `db-status-pill--${tone}`, className)} />;
}
