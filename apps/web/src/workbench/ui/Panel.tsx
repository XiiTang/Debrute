import React from 'react';
import { cx } from './cx';

export const Panel = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(function Panel(
  { className, ...props },
  ref
): React.ReactElement {
  return <section ref={ref} {...props} className={cx('db-panel', className)} />;
});

export function PanelHeader({ className, ...props }: React.HTMLAttributes<HTMLElement>): React.ReactElement {
  return <header {...props} className={cx('db-panel__header', className)} />;
}

export function PanelBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div {...props} className={cx('db-panel__body', className)} />;
}

export function PanelTitle({ className, ...props }: React.HTMLAttributes<HTMLElement>): React.ReactElement {
  return <strong {...props} className={cx('db-panel__title', className)} />;
}
