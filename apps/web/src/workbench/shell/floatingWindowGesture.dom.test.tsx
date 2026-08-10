import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  floatingWindowRectStyle,
  useFloatingWindowGesture,
  type FloatingWindowGesture
} from './floatingWindowGesture.js';
import type { WorkbenchWindowRect } from './windowBounds.js';

describe('floating window gesture', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-workbench-window-gesture');
    vi.restoreAllMocks();
  });

  it('previews the latest pointer position once per frame and commits once on release', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const onCommit = vi.fn();
    const onRender = vi.fn();
    const rendered = await renderGestureHarness(onCommit, onRender);
    const dragHandle = rendered.container.querySelector<HTMLElement>('[data-testid="drag-handle"]')!;
    const windowElement = rendered.container.querySelector<HTMLElement>('[data-testid="window"]')!;

    await act(async () => {
      dragHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 7, clientX: 10, clientY: 10 }));
      document.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, clientX: 40, clientY: 30 }));
      document.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, clientX: 50, clientY: 40 }));
    });

    expect(frames).toHaveLength(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.workbenchWindowGesture).toBe('move');

    await act(async () => frames[0]!(0));

    expect(windowElement.style.getPropertyValue('--db-workbench-window-preview-x')).toBe('140px');
    expect(windowElement.style.getPropertyValue('--db-workbench-window-preview-y')).toBe('130px');
    expect(onCommit).not.toHaveBeenCalled();
    expect(onRender).toHaveBeenCalledOnce();

    await rendered.rerender();

    expect(windowElement.style.getPropertyValue('--db-workbench-window-preview-x')).toBe('140px');
    expect(windowElement.style.getPropertyValue('--db-workbench-window-preview-y')).toBe('130px');

    await act(async () => {
      document.dispatchEvent(pointerEvent('pointerup', { pointerId: 7, clientX: 50, clientY: 40 }));
    });

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({ x: 140, y: 130, width: 300, height: 200 });
    expect(windowElement.style.getPropertyValue('--db-workbench-window-preview-x')).toBe('');
    expect(windowElement.style.getPropertyValue('--db-workbench-window-base-x')).toBe('140px');
    expect(onRender).toHaveBeenCalledTimes(3);
    expect(document.documentElement.hasAttribute('data-workbench-window-gesture')).toBe(false);

    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });

  it('restores the starting rectangle and skips commit when Escape cancels the gesture', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const onCommit = vi.fn();
    const rendered = await renderGestureHarness(onCommit);
    const dragHandle = rendered.container.querySelector<HTMLElement>('[data-testid="drag-handle"]')!;
    const windowElement = rendered.container.querySelector<HTMLElement>('[data-testid="window"]')!;

    await act(async () => {
      dragHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 8, clientX: 10, clientY: 10 }));
      document.dispatchEvent(pointerEvent('pointermove', { pointerId: 8, clientX: 60, clientY: 50 }));
    });
    await act(async () => frames[0]!(0));
    expect(windowElement.style.getPropertyValue('--db-workbench-window-preview-x')).toBe('150px');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });

    expect(windowElement.style.getPropertyValue('--db-workbench-window-preview-x')).toBe('');
    expect(windowElement.style.getPropertyValue('--db-workbench-window-base-x')).toBe('100px');
    expect(windowElement.style.getPropertyValue('--db-workbench-window-base-y')).toBe('100px');
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute('data-workbench-window-gesture')).toBe(false);

    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });

  it('uses the same lifecycle for directional resize gestures', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const onCommit = vi.fn();
    const rendered = await renderGestureHarness(onCommit);
    const resizeHandle = rendered.container.querySelector<HTMLElement>('[data-testid="resize-nw"]')!;

    await act(async () => {
      resizeHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 9, clientX: 100, clientY: 100 }));
      document.dispatchEvent(pointerEvent('pointermove', { pointerId: 9, clientX: 50, clientY: 60 }));
    });
    await act(async () => frames[0]!(0));
    await act(async () => {
      document.dispatchEvent(pointerEvent('pointerup', { pointerId: 9, clientX: 50, clientY: 60 }));
    });

    expect(onCommit).toHaveBeenCalledWith({ x: 50, y: 60, width: 350, height: 240 });
    expect(document.documentElement.hasAttribute('data-workbench-window-gesture')).toBe(false);

    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });

  it.each(['pointercancel', 'blur'] as const)('cancels on %s without committing', async (reason) => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const onCommit = vi.fn();
    const rendered = await renderGestureHarness(onCommit);
    const dragHandle = rendered.container.querySelector<HTMLElement>('[data-testid="drag-handle"]')!;
    const windowElement = rendered.container.querySelector<HTMLElement>('[data-testid="window"]')!;

    await act(async () => {
      dragHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 10, clientX: 10, clientY: 10 }));
      document.dispatchEvent(pointerEvent('pointermove', { pointerId: 10, clientX: 60, clientY: 50 }));
    });
    await act(async () => frames[0]!(0));
    await act(async () => {
      if (reason === 'pointercancel') {
        document.dispatchEvent(pointerEvent('pointercancel', { pointerId: 10, clientX: 60, clientY: 50 }));
      } else {
        window.dispatchEvent(new Event('blur'));
      }
    });

    expect(windowElement.style.getPropertyValue('--db-workbench-window-preview-x')).toBe('');
    expect(windowElement.style.getPropertyValue('--db-workbench-window-base-x')).toBe('100px');
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute('data-workbench-window-gesture')).toBe(false);

    await act(async () => rendered.root.unmount());
    rendered.container.remove();
  });
});

function GestureHarness({
  onCommit,
  onRender
}: {
  onCommit(rect: WorkbenchWindowRect): void;
  onRender?: (() => void) | undefined;
}): React.ReactElement {
  onRender?.();
  const [rect, setRect] = React.useState<WorkbenchWindowRect>({ x: 100, y: 100, width: 300, height: 200 });
  const windowRef = React.useRef<HTMLDivElement>(null);
  const gesture = useFloatingWindowGesture({
    windowRef,
    rect,
    onFocus: () => undefined,
    resolveRect: (candidate: WorkbenchWindowRect, _gesture: FloatingWindowGesture) => candidate,
    onCommit: (nextRect) => {
      setRect(nextRect);
      onCommit(nextRect);
    }
  });
  return (
    <div ref={windowRef} data-testid="window" style={floatingWindowRectStyle(rect)}>
      <div data-testid="drag-handle" {...gesture.dragHandleProps} />
      <div data-testid="resize-nw" {...gesture.resizeHandleProps('nw')} />
    </div>
  );
}

async function renderGestureHarness(
  onCommit: (rect: WorkbenchWindowRect) => void,
  onRender?: () => void
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<GestureHarness onCommit={onCommit} onRender={onRender} />));
  return {
    container,
    root,
    rerender: async () => {
      await act(async () => root.render(<GestureHarness onCommit={onCommit} onRender={onRender} />));
    }
  };
}

function pointerEvent(type: string, init: PointerEventInit): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, isPrimary: true, ...init });
}
