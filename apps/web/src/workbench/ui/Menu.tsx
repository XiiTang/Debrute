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
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
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

function MenuItem({
  variant = 'default',
  disabled,
  className,
  icon,
  children,
  type = 'button',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'danger';
  icon?: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      {...props}
      type={type}
      role="menuitem"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      className={cx('db-menu__item', `db-menu__item--${variant}`, className)}
    >
      <span className="db-menu__item-icon" aria-hidden="true">{icon}</span>
      <span className="db-menu__item-label">{children}</span>
    </button>
  );
}

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
