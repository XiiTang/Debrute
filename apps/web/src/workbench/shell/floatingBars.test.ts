import { describe, expect, it } from 'vitest';
import {
  CANVAS_FEEDBACK_BAR_SIZE,
  CANVAS_CARD_BAR_SIZE,
  CANVAS_MINIMAP_BUTTON_SIZE,
  CANVAS_MINIMAP_PANEL_SIZE,
  CANVAS_RESET_LAYOUT_BUTTON_SIZE,
  canvasCardBarRect,
  canvasMinimapButtonRect,
  canvasNodeToViewportRect,
  canvasResetLayoutButtonRect,
  placeCanvasFeedbackBar,
  placeCanvasMinimapPanel
} from './floatingBars';

describe('floating bar placement', () => {
  it('places feedback below a node by default', () => {
    const placement = placeCanvasFeedbackBar({
      nodeViewportRect: { x: 300, y: 200, width: 200, height: 120 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: []
    });

    expect(placement).toEqual({
      x: 201,
      y: 321,
      width: CANVAS_FEEDBACK_BAR_SIZE.width,
      height: CANVAS_FEEDBACK_BAR_SIZE.height,
      placement: 'below'
    });
  });

  it('keeps feedback close to the hovered node to avoid hover target handoff', () => {
    const nodeViewportRect = { x: 300, y: 200, width: 200, height: 120 };
    const placement = placeCanvasFeedbackBar({
      nodeViewportRect,
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: []
    });

    expect(placement?.placement).toBe('below');
    expect(placement?.y).toBe(nodeViewportRect.y + nodeViewportRect.height + 1);
  });

  it('flips feedback above when below does not fit', () => {
    const placement = placeCanvasFeedbackBar({
      nodeViewportRect: { x: 300, y: 650, width: 200, height: 40 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: []
    });

    expect(placement?.placement).toBe('above');
    expect(placement?.y).toBe(617);
  });

  it('clamps feedback horizontally inside the viewport', () => {
    const placement = placeCanvasFeedbackBar({
      nodeViewportRect: { x: 8, y: 200, width: 80, height: 80 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: []
    });

    expect(placement?.x).toBe(8);
  });

  it('uses the non-colliding candidate when a fixed bar reserves the preferred area', () => {
    const placement = placeCanvasFeedbackBar({
      nodeViewportRect: { x: 300, y: 200, width: 200, height: 120 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: [{ x: 190, y: 320, width: 420, height: 48 }]
    });

    expect(placement?.placement).toBe('above');
  });

  it('projects Canvas node bounds to viewport coordinates', () => {
    expect(canvasNodeToViewportRect({
      nodeRect: { x: 100, y: 50, width: 200, height: 100 },
      surfaceRect: { x: 10, y: 20, width: 900, height: 600 },
      camera: { x: 30, y: 40, z: 2 }
    })).toEqual({
      x: 240,
      y: 160,
      width: 400,
      height: 200
    });
  });

  it('derives the lower-left minimap button rect from the viewport', () => {
    expect(canvasMinimapButtonRect({
      x: 0,
      y: 0,
      width: 1000,
      height: 700
    })).toEqual({
      x: 18,
      y: 654,
      width: CANVAS_MINIMAP_BUTTON_SIZE.width,
      height: CANVAS_MINIMAP_BUTTON_SIZE.height
    });
  });

  it('places the Canvas card bar after the minimap and reset layout buttons', () => {
    const viewportRect = { x: 0, y: 0, width: 1000, height: 700 };
    const minimapButton = canvasMinimapButtonRect(viewportRect);
    const resetButton = canvasResetLayoutButtonRect(viewportRect);
    const cardBar = canvasCardBarRect(viewportRect);

    expect(resetButton).toEqual({
      x: 52,
      y: 654,
      width: CANVAS_RESET_LAYOUT_BUTTON_SIZE.width,
      height: CANVAS_RESET_LAYOUT_BUTTON_SIZE.height
    });
    expect(cardBar).toEqual({
      x: 88,
      y: 648,
      width: 580,
      height: CANVAS_CARD_BAR_SIZE.height
    });
    expect(resetButton.x).toBeGreaterThanOrEqual(minimapButton.x + minimapButton.width + 6);
    expect(cardBar.x).toBeGreaterThanOrEqual(resetButton.x + resetButton.width + 8);
  });

  it('places the minimap panel above the lower-left button', () => {
    const buttonRect = canvasMinimapButtonRect({ x: 0, y: 0, width: 1000, height: 700 });

    expect(placeCanvasMinimapPanel({
      buttonRect,
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 }
    })).toEqual({
      x: 18,
      y: 496,
      width: CANVAS_MINIMAP_PANEL_SIZE.width,
      height: CANVAS_MINIMAP_PANEL_SIZE.height
    });
  });

  it('clamps the minimap panel horizontally when the viewport is narrow', () => {
    const buttonRect = canvasMinimapButtonRect({ x: 0, y: 0, width: 260, height: 700 });

    expect(placeCanvasMinimapPanel({
      buttonRect,
      viewportRect: { x: 0, y: 0, width: 260, height: 700 }
    })).toEqual({
      x: 18,
      y: 496,
      width: CANVAS_MINIMAP_PANEL_SIZE.width,
      height: CANVAS_MINIMAP_PANEL_SIZE.height
    });
  });
});
