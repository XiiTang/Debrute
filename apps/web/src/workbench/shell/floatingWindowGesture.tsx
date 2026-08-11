import React from 'react';
import type { WorkbenchWindowRect } from './windowBounds';

export const FLOATING_WINDOW_RESIZE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
export type FloatingWindowResizeDirection = typeof FLOATING_WINDOW_RESIZE_DIRECTIONS[number];

export type FloatingWindowGesture =
  | { kind: 'move' }
  | { kind: 'resize'; direction: FloatingWindowResizeDirection };

interface ActiveFloatingWindowGesture {
  pointerId: number;
  document: Document;
  view: Window;
  gesture: FloatingWindowGesture;
  startPointer: { x: number; y: number };
  latestPointer: { x: number; y: number };
  startRect: WorkbenchWindowRect;
  moved: boolean;
  frameRequest: number | undefined;
  cleanupListeners(): void;
}

export function useFloatingWindowGesture({
  windowRef,
  rect,
  onFocus,
  resolveRect,
  onCommit
}: {
  windowRef: React.RefObject<HTMLElement | null>;
  rect: WorkbenchWindowRect;
  onFocus(): void;
  resolveRect(candidate: WorkbenchWindowRect, gesture: FloatingWindowGesture): WorkbenchWindowRect;
  onCommit(rect: WorkbenchWindowRect): void;
}): {
  dragHandleProps: React.HTMLAttributes<HTMLElement>;
  resizeHandleProps(direction: FloatingWindowResizeDirection): React.HTMLAttributes<HTMLElement>;
} {
  const rectRef = React.useRef(rect);
  const onFocusRef = React.useRef(onFocus);
  const resolveRectRef = React.useRef(resolveRect);
  const onCommitRef = React.useRef(onCommit);
  const activeRef = React.useRef<ActiveFloatingWindowGesture | undefined>(undefined);

  React.useLayoutEffect(() => {
    rectRef.current = rect;
    onFocusRef.current = onFocus;
    resolveRectRef.current = resolveRect;
    onCommitRef.current = onCommit;
    if (!activeRef.current && windowRef.current) {
      clearFloatingWindowPreview(windowRef.current);
    }
  }, [onCommit, onFocus, rect, resolveRect, windowRef]);

  const cancelActiveGesture = React.useCallback(() => {
    const active = activeRef.current;
    if (!active) {
      return;
    }
    if (active.frameRequest !== undefined) {
      active.view.cancelAnimationFrame(active.frameRequest);
    }
    if (windowRef.current) {
      clearFloatingWindowPreview(windowRef.current);
    }
    active.cleanupListeners();
    clearGestureCursor(active.document);
    activeRef.current = undefined;
  }, [windowRef]);

  React.useEffect(() => cancelActiveGesture, [cancelActiveGesture]);

  const startGesture = React.useCallback((
    event: React.PointerEvent<HTMLElement>,
    gesture: FloatingWindowGesture
  ) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    cancelActiveGesture();
    onFocusRef.current();

    const ownerDocument = event.currentTarget.ownerDocument;
    const view = ownerDocument.defaultView;
    if (!view) {
      return;
    }
    const startPointer = { x: event.clientX, y: event.clientY };
    const active: ActiveFloatingWindowGesture = {
      pointerId: event.pointerId,
      document: ownerDocument,
      view,
      gesture,
      startPointer,
      latestPointer: startPointer,
      startRect: rectRef.current,
      moved: false,
      frameRequest: undefined,
      cleanupListeners: () => undefined
    };

    const previewLatestPointer = () => {
      active.frameRequest = undefined;
      const element = windowRef.current;
      if (!element || !active.moved) {
        return;
      }
      writeFloatingWindowPreview(element, resolveRectRef.current(
        floatingWindowGestureRect(active.startRect, active.startPointer, active.latestPointer, gesture),
        gesture
      ));
    };
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== active.pointerId) {
        return;
      }
      active.latestPointer = { x: pointerEvent.clientX, y: pointerEvent.clientY };
      if (!active.moved && pointerDistanceSquared(active.startPointer, active.latestPointer) < 9) {
        return;
      }
      active.moved = true;
      if (pointerEvent.cancelable) {
        pointerEvent.preventDefault();
      }
      if (active.frameRequest === undefined) {
        active.frameRequest = view.requestAnimationFrame(previewLatestPointer);
      }
    };
    const finishGesture = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== active.pointerId) {
        return;
      }
      active.latestPointer = { x: pointerEvent.clientX, y: pointerEvent.clientY };
      if (active.frameRequest !== undefined) {
        view.cancelAnimationFrame(active.frameRequest);
        active.frameRequest = undefined;
      }
      const finalRect = active.moved
        ? resolveRectRef.current(
            floatingWindowGestureRect(active.startRect, active.startPointer, active.latestPointer, gesture),
            gesture
          )
        : undefined;
      if (finalRect && windowRef.current) {
        writeFloatingWindowPreview(windowRef.current, finalRect);
      }
      active.cleanupListeners();
      clearGestureCursor(ownerDocument);
      activeRef.current = undefined;
      if (finalRect) {
        onCommitRef.current(finalRect);
      }
    };
    const handlePointerCancel = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === active.pointerId) {
        cancelActiveGesture();
      }
    };
    const handleKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === 'Escape') {
        cancelActiveGesture();
      }
    };
    const handleWindowBlur = () => cancelActiveGesture();

    active.cleanupListeners = () => {
      ownerDocument.removeEventListener('pointermove', handlePointerMove, true);
      ownerDocument.removeEventListener('pointerup', finishGesture, true);
      ownerDocument.removeEventListener('pointercancel', handlePointerCancel, true);
      ownerDocument.removeEventListener('keydown', handleKeyDown, true);
      view.removeEventListener('blur', handleWindowBlur);
    };
    ownerDocument.addEventListener('pointermove', handlePointerMove, true);
    ownerDocument.addEventListener('pointerup', finishGesture, true);
    ownerDocument.addEventListener('pointercancel', handlePointerCancel, true);
    ownerDocument.addEventListener('keydown', handleKeyDown, true);
    view.addEventListener('blur', handleWindowBlur);
    ownerDocument.documentElement.dataset.workbenchWindowGesture = gestureCursor(gesture);
    activeRef.current = active;
  }, [cancelActiveGesture, windowRef]);

  return {
    dragHandleProps: {
      onPointerDown: (event) => startGesture(event, { kind: 'move' })
    },
    resizeHandleProps: (direction) => ({
      onPointerDown: (event) => startGesture(event, { kind: 'resize', direction })
    })
  };
}

export function FloatingWindowResizeHandles({
  resizeHandleProps
}: {
  resizeHandleProps(direction: FloatingWindowResizeDirection): React.HTMLAttributes<HTMLElement>;
}): React.ReactElement {
  return (
    <>
      {FLOATING_WINDOW_RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`floating-panel-resize-handle floating-panel-resize-handle--${direction}`}
          role="presentation"
          {...resizeHandleProps(direction)}
        />
      ))}
    </>
  );
}

export function floatingWindowRectStyle(rect: WorkbenchWindowRect): React.CSSProperties {
  return {
    '--db-workbench-window-base-x': `${rect.x}px`,
    '--db-workbench-window-base-y': `${rect.y}px`,
    '--db-workbench-window-base-width': `${rect.width}px`,
    '--db-workbench-window-base-height': `${rect.height}px`
  } as React.CSSProperties;
}

export function floatingWindowGestureRect(
  startRect: WorkbenchWindowRect,
  startPointer: { x: number; y: number },
  pointer: { x: number; y: number },
  gesture: FloatingWindowGesture
): WorkbenchWindowRect {
  const dx = pointer.x - startPointer.x;
  const dy = pointer.y - startPointer.y;
  if (gesture.kind === 'move') {
    return { ...startRect, x: startRect.x + dx, y: startRect.y + dy };
  }
  const { direction } = gesture;
  return {
    x: direction.includes('w') ? startRect.x + dx : startRect.x,
    y: direction.includes('n') ? startRect.y + dy : startRect.y,
    width: startRect.width
      + (direction.includes('e') ? dx : 0)
      - (direction.includes('w') ? dx : 0),
    height: startRect.height
      + (direction.includes('s') ? dy : 0)
      - (direction.includes('n') ? dy : 0)
  };
}

export function anchorResizedFloatingWindowRect(
  candidate: WorkbenchWindowRect,
  direction: FloatingWindowResizeDirection,
  size: Pick<WorkbenchWindowRect, 'width' | 'height'>
): WorkbenchWindowRect {
  return {
    x: direction.includes('w') ? candidate.x + candidate.width - size.width : candidate.x,
    y: direction.includes('n') ? candidate.y + candidate.height - size.height : candidate.y,
    width: size.width,
    height: size.height
  };
}

function writeFloatingWindowPreview(element: HTMLElement, rect: WorkbenchWindowRect): void {
  element.style.setProperty('--db-workbench-window-preview-x', `${rect.x}px`);
  element.style.setProperty('--db-workbench-window-preview-y', `${rect.y}px`);
  element.style.setProperty('--db-workbench-window-preview-width', `${rect.width}px`);
  element.style.setProperty('--db-workbench-window-preview-height', `${rect.height}px`);
}

function clearFloatingWindowPreview(element: HTMLElement): void {
  element.style.removeProperty('--db-workbench-window-preview-x');
  element.style.removeProperty('--db-workbench-window-preview-y');
  element.style.removeProperty('--db-workbench-window-preview-width');
  element.style.removeProperty('--db-workbench-window-preview-height');
}

function pointerDistanceSquared(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function gestureCursor(gesture: FloatingWindowGesture): string {
  return gesture.kind === 'move' ? 'move' : gesture.direction;
}

function clearGestureCursor(ownerDocument: Document): void {
  ownerDocument.documentElement.removeAttribute('data-workbench-window-gesture');
}
