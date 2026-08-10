import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx.js';

export function Modal({
  labelledBy,
  className,
  children,
  onCancel
}: {
  labelledBy: string;
  className?: string;
  children: React.ReactNode;
  onCancel(): void;
}): React.ReactElement {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const background = [...document.body.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== dialog)
      .map((element) => ({ element, inert: element.inert === true }));
    for (const { element } of background) {
      element.inert = true;
    }
    dialog.showModal();
    const initialFocus = dialog.querySelector<HTMLElement>('[data-modal-initial-focus]');
    initialFocus?.focus();

    return () => {
      if (dialog.open) {
        dialog.close();
      }
      for (const { element, inert } of background) {
        element.inert = inert;
      }
      if (returnFocusRef.current?.isConnected) {
        returnFocusRef.current.focus();
      }
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className={cx('db-modal', className)}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      {children}
    </dialog>,
    document.body
  );
}
