import { describe, expect, it } from 'vitest';
import {
  buildResizeGeometry,
  getCanvasResizePreserveAspect,
  isAdditiveCanvasSelectionModifier,
  normalizeCanvasWheelDelta,
  selectedNodeProjectRelativePaths,
  shouldCanvasHandleGlobalWheelTarget,
  shouldCanvasHandleWheelTarget
} from './canvasInteraction';

describe('canvas interaction', () => {
  it('treats Shift, Meta, and Ctrl as additive canvas selection modifiers', () => {
    expect(isAdditiveCanvasSelectionModifier({ shiftKey: true, metaKey: false, ctrlKey: false })).toBe(true);
    expect(isAdditiveCanvasSelectionModifier({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe(true);
    expect(isAdditiveCanvasSelectionModifier({ shiftKey: false, metaKey: false, ctrlKey: true })).toBe(true);
    expect(isAdditiveCanvasSelectionModifier({ shiftKey: false, metaKey: false, ctrlKey: false })).toBe(false);
  });

  it('extracts selected node paths', () => {
    expect(selectedNodeProjectRelativePaths({
      kind: 'multi',
      items: [
        { kind: 'node', projectRelativePath: 'flow/cover.png' },
        { kind: 'node', projectRelativePath: 'flow/reel.mp4' }
      ]
    })).toEqual(['flow/cover.png', 'flow/reel.mp4']);
  });

  it('normalizes trackpad wheel deltas into pan deltas', () => {
    expect(normalizeCanvasWheelDelta({
      deltaX: 12,
      deltaY: -8,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false
    })).toEqual({ x: -12, y: 8, z: 0 });
  });

  it('normalizes modifier wheel deltas into capped zoom deltas', () => {
    expect(normalizeCanvasWheelDelta({
      deltaX: 0,
      deltaY: 1000,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false
    })).toEqual({ x: 0, y: 0, z: -0.1 });

    expect(normalizeCanvasWheelDelta({
      deltaX: 0,
      deltaY: -4,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false
    })).toEqual({ x: 0, y: 0, z: 0.04 });
  });

  it('does not turn horizontal modifier wheel input into canvas panning', () => {
    const delta = normalizeCanvasWheelDelta({
      deltaX: 40,
      deltaY: 0,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false
    });

    expect(delta).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('uses z-axis modifier wheel deltas for trackpad pinch zoom input', () => {
    expect(normalizeCanvasWheelDelta({
      deltaX: 0,
      deltaY: 0,
      deltaZ: -6,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false
    })).toEqual({ x: 0, y: 0, z: 0.06 });
  });

  it('maps shift wheel to horizontal panning on non-Darwin platforms', () => {
    expect(normalizeCanvasWheelDelta({
      deltaX: 0,
      deltaY: 25,
      ctrlKey: false,
      metaKey: false,
      shiftKey: true
    }, 'linux')).toEqual({ x: -25, y: 0, z: 0 });

    expect(normalizeCanvasWheelDelta({
      deltaX: 0,
      deltaY: 25,
      ctrlKey: false,
      metaKey: false,
      shiftKey: true
    }, 'darwin')).toEqual({ x: 0, y: -25, z: 0 });
  });

  it('handles wheel gestures only when the event target belongs to the canvas', () => {
    expect(shouldCanvasHandleWheelTarget(null)).toBe(true);
    expect(shouldCanvasHandleWheelTarget({
      closest: (selector: string) => selector === '[data-canvas-local-wheel="true"]' ? { tagName: 'SECTION' } : null
    } as unknown as EventTarget)).toBe(false);
  });

  it('routes focus-gated local wheel targets to the canvas until focused', () => {
    const unfocusedEditor = mockElement('canvas-text-body', undefined, 'focus', false);
    const focusedEditor = mockElement('canvas-text-body', undefined, 'focus', true);

    expect(shouldCanvasHandleWheelTarget(unfocusedEditor as unknown as EventTarget)).toBe(true);
    expect(shouldCanvasHandleWheelTarget(focusedEditor as unknown as EventTarget)).toBe(false);
  });

  it('lets pointer-focused text editor wheel gestures scroll locally', () => {
    const textBody = mockElement('canvas-text-body', undefined, 'focus', false);
    const textEditor = mockElement('canvas-text-editor', textBody, false, false, true);
    const textContent = mockElement('cm-content', textEditor);

    expect(shouldCanvasHandleWheelTarget(textContent as unknown as EventTarget)).toBe(false);
  });

  it('lets canvas-owned floating bars keep wheel gestures on the canvas', () => {
    const shell = mockElement('workbench-shell');
    const surface = mockElement('canvas-surface', shell);
    const floatingLayer = mockElement('floating-bar-layer', shell);
    const floatingActionButton = mockElement('floating-action-button', floatingLayer);
    const localWheelInput = mockElement('canvas-feedback-comment-input', floatingLayer, true);
    const unfocusedFocusLocalInput = mockElement('canvas-feedback-comment-input', floatingLayer, 'focus', false);
    const focusedFocusLocalInput = mockElement('canvas-feedback-comment-input', floatingLayer, 'focus', true);
    const panelLayer = mockElement('panel-layer', shell);
    const panelButton = mockElement('floating-panel-button', panelLayer);
    const otherShell = mockElement('workbench-shell');
    const otherFloatingLayer = mockElement('floating-bar-layer', otherShell);
    const otherFloatingActionButton = mockElement('floating-action-button', otherFloatingLayer);

    expect(shouldCanvasHandleGlobalWheelTarget(surface as unknown as EventTarget, surface as unknown as EventTarget)).toBe(true);
    expect(shouldCanvasHandleGlobalWheelTarget(floatingActionButton as unknown as EventTarget, surface as unknown as EventTarget)).toBe(true);
    expect(shouldCanvasHandleGlobalWheelTarget(localWheelInput as unknown as EventTarget, surface as unknown as EventTarget)).toBe(false);
    expect(shouldCanvasHandleGlobalWheelTarget(unfocusedFocusLocalInput as unknown as EventTarget, surface as unknown as EventTarget)).toBe(true);
    expect(shouldCanvasHandleGlobalWheelTarget(focusedFocusLocalInput as unknown as EventTarget, surface as unknown as EventTarget)).toBe(false);
    expect(shouldCanvasHandleGlobalWheelTarget(panelButton as unknown as EventTarget, surface as unknown as EventTarget)).toBe(false);
    expect(shouldCanvasHandleGlobalWheelTarget(otherFloatingActionButton as unknown as EventTarget, surface as unknown as EventTarget)).toBe(false);
  });

  it('builds resize geometry with default aspect-preserving corners', () => {
    expect(buildResizeGeometry('nw', { x: 100, y: 100, width: 200, height: 120 }, { x: 30, y: 20 }, false)).toEqual({
      x: 130,
      y: 120,
      width: 170,
      height: 100
    });
    expect(getCanvasResizePreserveAspect('se', { shiftKey: false }, 'image')).toBe(true);
    expect(getCanvasResizePreserveAspect('se', { shiftKey: true }, 'text')).toBe(true);
  });
});

function mockElement(
  className: string,
  parent?: MockElement,
  localWheel: false | true | 'focus' = false,
  focused = false,
  pointerFocused = false
): MockElement {
  const element: MockElement = {
    className,
    focused,
    localWheel,
    pointerFocused,
    parent,
    closest(selector: string): MockElement | null {
      if (
        selector === '[data-canvas-text-editor="true"][data-pointer-focus="true"]'
        && element.pointerFocused
      ) {
        return element;
      }
      if (selector === '[data-canvas-local-wheel="true"]' && element.localWheel === true) {
        return element;
      }
      if (selector === '[data-canvas-local-wheel="focus"]' && element.localWheel === 'focus') {
        return element;
      }
      if (selector.startsWith('.') && element.className === selector.slice(1)) {
        return element;
      }
      return element.parent?.closest(selector) ?? null;
    },
    matches(selector: string): boolean {
      return selector === ':focus-within' && element.focused;
    },
    contains(target: EventTarget | null): boolean {
      let current = target as unknown as MockElement | undefined;
      while (current) {
        if (current === element) {
          return true;
        }
        current = current.parent;
      }
      return false;
    }
  };
  return element;
}

interface MockElement {
  className: string;
  focused: boolean;
  localWheel: false | true | 'focus';
  pointerFocused: boolean;
  parent: MockElement | undefined;
  closest: (selector: string) => MockElement | null;
  matches: (selector: string) => boolean;
  contains: (target: EventTarget | null) => boolean;
}
