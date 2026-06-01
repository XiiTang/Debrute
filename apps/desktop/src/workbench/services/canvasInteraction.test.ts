import { describe, expect, it } from 'vitest';
import {
  buildResizeGeometry,
  canvasSurfacePointToCanvasPoint,
  canvasUpdateFromMovedSelection,
  canvasViewportCenterPoint,
  getCanvasResizePreserveAspect,
  getCanvasWheelIntent,
  getWheelZoomScale,
  isAdditiveCanvasSelectionModifier,
  screenPointToCanvasPoint,
  selectedNodeProjectRelativePaths,
  shouldCanvasHandleGlobalWheelTarget,
  shouldCanvasHandleWheelTarget
} from './canvasInteraction';

describe('canvas interaction', () => {
  it('converts screen points through the canvas viewport', () => {
    expect(screenPointToCanvasPoint({ x: 50, y: 30, zoom: 2 }, { x: 250, y: 130 })).toEqual({ x: 100, y: 50 });
  });

  it('converts pointer positions through the canvas surface bounds and viewport', () => {
    expect(canvasSurfacePointToCanvasPoint({
      viewport: { x: 40, y: 20, zoom: 2 },
      surfaceRect: { left: 100, top: 50 },
      point: { x: 260, y: 170 }
    })).toEqual({ x: 60, y: 50 });
  });

  it('places button-driven canvas nodes at the live surface viewport center', () => {
    expect(canvasViewportCenterPoint({
      viewport: { x: 40, y: 20, zoom: 2 },
      surfaceRect: { width: 900, height: 500 }
    })).toEqual({ x: 205, y: 115 });
  });

  it('treats Shift, Meta, and Ctrl as additive canvas selection modifiers', () => {
    expect(isAdditiveCanvasSelectionModifier({ shiftKey: true, metaKey: false, ctrlKey: false })).toBe(true);
    expect(isAdditiveCanvasSelectionModifier({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe(true);
    expect(isAdditiveCanvasSelectionModifier({ shiftKey: false, metaKey: false, ctrlKey: true })).toBe(true);
    expect(isAdditiveCanvasSelectionModifier({ shiftKey: false, metaKey: false, ctrlKey: false })).toBe(false);
  });

  it('moves selected nodes only', () => {
    const update = canvasUpdateFromMovedSelection({
      kind: 'node',
      projectRelativePath: 'flow/one.png'
    }, { dx: 12, dy: 8 }, {
      nodes: [
        { projectRelativePath: 'flow/one.png', x: 100, y: 120, width: 190, height: 86 },
        { projectRelativePath: 'flow/two.png', x: 400, y: 420, width: 190, height: 86 }
      ]
    });

    expect(update).toEqual({
      nodeLayouts: [{ projectRelativePath: 'flow/one.png', x: 112, y: 128, width: 190, height: 86 }]
    });
  });

  it('excludes locked nodes from movement layout updates', () => {
    const update = canvasUpdateFromMovedSelection({
      kind: 'multi',
      items: [
        { kind: 'node', projectRelativePath: 'flow/free.png' },
        { kind: 'node', projectRelativePath: 'flow/locked.png' }
      ]
    }, { dx: 12, dy: 8 }, {
      nodes: [
        { projectRelativePath: 'flow/free.png', x: 260, y: 220, width: 300, height: 180, locked: false },
        { projectRelativePath: 'flow/locked.png', x: 500, y: 220, width: 300, height: 180, locked: true }
      ]
    });

    expect(update).toEqual({
      nodeLayouts: [{ projectRelativePath: 'flow/free.png', x: 272, y: 228, width: 300, height: 180 }]
    });
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

  it('uses desktop canvas background and wheel gestures', () => {
    expect(getWheelZoomScale(9.95, -1000)).toBe(10);
    expect(getWheelZoomScale(0.031, 1000)).toBe(0.03);
    expect(getCanvasWheelIntent({ deltaX: 42, deltaY: -18, ctrlKey: false, metaKey: false })).toEqual({
      kind: 'pan',
      deltaX: -42,
      deltaY: 18
    });
  });

  it('handles wheel gestures only when the event target belongs to the canvas', () => {
    expect(shouldCanvasHandleWheelTarget(null)).toBe(true);
    expect(shouldCanvasHandleWheelTarget({
      closest: (selector: string) => selector === '[data-canvas-local-wheel="true"]' ? { tagName: 'SECTION' } : null
    } as unknown as EventTarget)).toBe(false);
  });

  it('lets canvas-owned floating bars keep wheel gestures on the canvas', () => {
    const shell = mockElement('workbench-shell');
    const surface = mockElement('canvas-surface', shell);
    const floatingLayer = mockElement('floating-bar-layer', shell);
    const toolbarButton = mockElement('canvas-toolbar-button', floatingLayer);
    const localWheelInput = mockElement('canvas-feedback-note', floatingLayer, true);
    const panelLayer = mockElement('panel-layer', shell);
    const panelButton = mockElement('floating-panel-button', panelLayer);
    const otherShell = mockElement('workbench-shell');
    const otherFloatingLayer = mockElement('floating-bar-layer', otherShell);
    const otherToolbarButton = mockElement('canvas-toolbar-button', otherFloatingLayer);

    expect(shouldCanvasHandleGlobalWheelTarget(surface as unknown as EventTarget, surface as unknown as EventTarget)).toBe(true);
    expect(shouldCanvasHandleGlobalWheelTarget(toolbarButton as unknown as EventTarget, surface as unknown as EventTarget)).toBe(true);
    expect(shouldCanvasHandleGlobalWheelTarget(localWheelInput as unknown as EventTarget, surface as unknown as EventTarget)).toBe(false);
    expect(shouldCanvasHandleGlobalWheelTarget(panelButton as unknown as EventTarget, surface as unknown as EventTarget)).toBe(false);
    expect(shouldCanvasHandleGlobalWheelTarget(otherToolbarButton as unknown as EventTarget, surface as unknown as EventTarget)).toBe(false);
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

function mockElement(className: string, parent?: MockElement, localWheel = false): MockElement {
  const element: MockElement = {
    className,
    localWheel,
    parent,
    closest(selector: string): MockElement | null {
      if (selector === '[data-canvas-local-wheel="true"]' && element.localWheel) {
        return element;
      }
      if (selector.startsWith('.') && element.className === selector.slice(1)) {
        return element;
      }
      return element.parent?.closest(selector) ?? null;
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
  localWheel: boolean;
  parent: MockElement | undefined;
  closest: (selector: string) => MockElement | null;
  contains: (target: EventTarget | null) => boolean;
}
