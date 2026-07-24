import React from 'react';
import { cx } from './cx';

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>): React.ReactElement {
  return <article {...props} className={cx('db-card', className)} />;
}
