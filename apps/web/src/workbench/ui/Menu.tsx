import React from 'react';
import { cx } from './cx';

type MenuFocusDirection = 'next' | 'previous' | 'first' | 'last';

export function getNextMenuItemIndex({
  currentIndex,
  direction,
  itemCount,
  disabledIndexes
}: {
  currentIndex: number;
  direction: MenuFocusDirection;
  itemCount: number;
  disabledIndexes: ReadonlySet<number>;
}): number {
  if (itemCount <= 0) {
    return -1;
  }
  const isEnabled = (index: number) => !disabledIndexes.has(index);
  if (direction === 'first') {
    for (let index = 0; index < itemCount; index += 1) {
      if (isEnabled(index)) {
        return index;
      }
    }
    return -1;
  }
  if (direction === 'last') {
    for (let index = itemCount - 1; index >= 0; index -= 1) {
      if (isEnabled(index)) {
        return index;
      }
    }
    return -1;
  }
  const step = direction === 'next' ? 1 : -1;
  for (let offset = 1; offset <= itemCount; offset += 1) {
    const index = (currentIndex + step * offset + itemCount) % itemCount;
    if (isEnabled(index)) {
      return index;
    }
  }
  return -1;
}

const MenuRoot = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { ariaLabel: string }>(function MenuRoot({
  ariaLabel,
  className,
  onKeyDown,
  ...props
}, ref): React.ReactElement {
  return (
    <div
      {...props}
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      className={cx('db-menu', className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) {
          return;
        }
        const direction = menuFocusDirectionForKey(event.key);
        if (!direction) {
          return;
        }
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
          .filter((item) => item.closest('[role="menu"]') === event.currentTarget);
        const disabledIndexes = new Set<number>();
        for (const [index, item] of items.entries()) {
          if (item.disabled || item.hidden || item.getAttribute('aria-disabled') === 'true') {
            disabledIndexes.add(index);
          }
        }
        const activeIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
        const nextIndex = getNextMenuItemIndex({
          currentIndex: activeIndex,
          direction,
          itemCount: items.length,
          disabledIndexes
        });
        if (nextIndex >= 0) {
          event.preventDefault();
          items[nextIndex]?.focus();
        }
      }}
    />
  );
});

const MenuItem = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'danger';
  start?: React.ReactNode;
  end?: React.ReactNode;
}>(function MenuItem({
  variant = 'default',
  disabled,
  className,
  start,
  end,
  children,
  type = 'button',
  ...props
}, ref): React.ReactElement {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      role="menuitem"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      className={cx('db-menu__item', `db-menu__item--${variant}`, className)}
    >
      {start ? <span className="db-menu__item-start" aria-hidden="true">{start}</span> : null}
      <span className="db-menu__item-label">{children}</span>
      {end ? <span className="db-menu__item-end">{end}</span> : null}
    </button>
  );
});

function MenuSeparator(): React.ReactElement {
  return <div className="db-menu__separator" role="separator" />;
}

export const Menu = Object.assign(MenuRoot, {
  Item: MenuItem,
  Separator: MenuSeparator
});

function menuFocusDirectionForKey(key: string): MenuFocusDirection | undefined {
  if (key === 'ArrowDown') {
    return 'next';
  }
  if (key === 'ArrowUp') {
    return 'previous';
  }
  if (key === 'Home') {
    return 'first';
  }
  if (key === 'End') {
    return 'last';
  }
  return undefined;
}
