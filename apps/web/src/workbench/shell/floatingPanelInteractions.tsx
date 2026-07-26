import React from 'react';
import {
  FLOATING_PANEL_RESIZE_DIRECTIONS,
  type FloatingPanelResizeDirection,
  type FloatingPanelResizeInput
} from './floatingPanels.js';
import type { WorkbenchWindowRect } from './windowBounds.js';

interface FloatingPanelResizeStart extends WorkbenchWindowRect {
  pointerX: number;
  pointerY: number;
  direction: FloatingPanelResizeDirection;
}

export function FloatingPanelResizeHandles({
  layout,
  onBringToFront,
  onResize
}: {
  layout: WorkbenchWindowRect;
  onBringToFront(): void;
  onResize(input: FloatingPanelResizeInput): void;
}): React.ReactElement {
  const resizeStart = React.useRef<FloatingPanelResizeStart | undefined>(undefined);
  return (
    <>
      {FLOATING_PANEL_RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`floating-panel-resize-handle floating-panel-resize-handle--${direction}`}
          role="presentation"
          {...floatingPanelResizeHandleProps({
            direction,
            resizeStart,
            layout,
            onBringToFront,
            onResize
          })}
        />
      ))}
    </>
  );
}

export function floatingPanelDragHandleProps({
  dragStart,
  onBringToFront,
  onDrag
}: {
  dragStart: React.MutableRefObject<{ x: number; y: number } | undefined>;
  onBringToFront(): void;
  onDrag(dx: number, dy: number): void;
}): React.HTMLAttributes<HTMLElement> {
  return {
    onPointerDown: (event) => {
      dragStart.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      onBringToFront();
    },
    onPointerMove: (event) => {
      if (!dragStart.current) {
        return;
      }
      const next = { x: event.clientX, y: event.clientY };
      onDrag(next.x - dragStart.current.x, next.y - dragStart.current.y);
      dragStart.current = next;
    },
    onPointerUp: (event) => {
      dragStart.current = undefined;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
}

export function floatingPanelResizeHandleProps({
  direction,
  resizeStart,
  layout,
  onBringToFront,
  onResize
}: {
  direction: FloatingPanelResizeDirection;
  resizeStart: React.MutableRefObject<FloatingPanelResizeStart | undefined>;
  layout: WorkbenchWindowRect;
  onBringToFront(): void;
  onResize(input: FloatingPanelResizeInput): void;
}): React.HTMLAttributes<HTMLElement> {
  return {
    onPointerDown: (event) => {
      event.stopPropagation();
      resizeStart.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        direction,
        x: layout.x,
        y: layout.y,
        width: layout.width,
        height: layout.height
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      onBringToFront();
    },
    onPointerMove: (event) => {
      if (!resizeStart.current) {
        return;
      }
      onResize({
        ...resizeFloatingPanelRect(resizeStart.current, event.clientX, event.clientY),
        direction: resizeStart.current.direction
      });
    },
    onPointerUp: (event) => {
      resizeStart.current = undefined;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
}

function resizeFloatingPanelRect(
  start: FloatingPanelResizeStart,
  pointerX: number,
  pointerY: number
): WorkbenchWindowRect {
  const dx = pointerX - start.pointerX;
  const dy = pointerY - start.pointerY;
  return {
    x: start.direction.includes('w') ? start.x + dx : start.x,
    y: start.direction.includes('n') ? start.y + dy : start.y,
    width: start.width
      + (start.direction.includes('e') ? dx : 0)
      - (start.direction.includes('w') ? dx : 0),
    height: start.height
      + (start.direction.includes('s') ? dy : 0)
      - (start.direction.includes('n') ? dy : 0)
  };
}
