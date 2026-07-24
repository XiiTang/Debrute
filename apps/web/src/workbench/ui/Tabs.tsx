import React from 'react';
import { cx } from './cx';

type TabFocusDirection = 'next' | 'previous';

export function getNextTabIndex({
  currentIndex,
  direction,
  tabCount,
  disabledIndexes
}: {
  currentIndex: number;
  direction: TabFocusDirection;
  tabCount: number;
  disabledIndexes: ReadonlySet<number>;
}): number {
  if (tabCount <= 0) {
    return -1;
  }
  const step = direction === 'next' ? 1 : -1;
  for (let offset = 1; offset <= tabCount; offset += 1) {
    const index = (currentIndex + step * offset + tabCount) % tabCount;
    if (!disabledIndexes.has(index)) {
      return index;
    }
  }
  return -1;
}

export function TabList({ className, onKeyDown, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      {...props}
      role="tablist"
      className={cx('db-tabs', className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) {
          return;
        }
        const direction = event.key === 'ArrowRight'
          ? 'next'
          : event.key === 'ArrowLeft'
            ? 'previous'
            : undefined;
        if (!direction) {
          return;
        }
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const disabledIndexes = new Set<number>();
        for (const [index, tab] of tabs.entries()) {
          if (tab.disabled || tab.hidden || tab.getAttribute('aria-disabled') === 'true') {
            disabledIndexes.add(index);
          }
        }
        const activeIndex = Math.max(0, tabs.indexOf(document.activeElement as HTMLButtonElement));
        const nextIndex = getNextTabIndex({
          currentIndex: activeIndex,
          direction,
          tabCount: tabs.length,
          disabledIndexes
        });
        if (nextIndex >= 0) {
          event.preventDefault();
          tabs[nextIndex]?.focus();
        }
      }}
    />
  );
}

export function Tab({
  active,
  appearance = 'default',
  className,
  type = 'button',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  appearance?: 'default' | 'strip';
}): React.ReactElement {
  return (
    <button
      {...props}
      type={type}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={cx('db-tab', `db-tab--${appearance}`, active && 'db-tab--active', className)}
    />
  );
}
