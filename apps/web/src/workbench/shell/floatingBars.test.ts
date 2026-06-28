import { describe, expect, it } from 'vitest';
import {
  CANVAS_FEEDBACK_BAR_SIZE,
  CANVAS_CARD_BAR_SIZE,
  CANVAS_MINIMAP_BUTTON_SIZE,
  CANVAS_MINIMAP_PANEL_SIZE,
  CANVAS_RESET_LAYOUT_BUTTON_SIZE,
  canvasCardBarRect,
  canvasFeedbackBarSizeForTarget,
  canvasFeedbackBarTargetWithCurrentEntry,
  canvasMinimapButtonRect,
  canvasNodeToViewportRect,
  feedbackBarPlacementForCanvasTarget,
  canvasResetLayoutButtonRect,
  placeCanvasFeedbackBar,
  placeCanvasMinimapPanel
} from './floatingBars';
import { TITLE_BAR_RESERVED_RECT, WORKBENCH_TITLE_BAR_HEIGHT } from './workbenchLayers';

describe('floating bar placement', () => {
  it('places feedback below a node by default', () => {
    const barSize = canvasFeedbackBarSizeForTarget({ supportsImageLocalFeedback: true, hasCommentRow: true });
    const placement = placeCanvasFeedbackBar({
      nodeViewportRect: { x: 300, y: 200, width: 200, height: 120 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: [],
      barSize
    });

    expect(placement).toEqual({
      x: 202,
      y: 323,
      width: barSize.width,
      height: barSize.height,
      placement: 'below'
    });
  });

  it('keeps feedback close to the hovered node to avoid hover target handoff', () => {
    const nodeViewportRect = { x: 300, y: 200, width: 200, height: 120 };
    const placement = placeCanvasFeedbackBar({
      nodeViewportRect,
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: [],
      barSize: canvasFeedbackBarSizeForTarget({ supportsImageLocalFeedback: true, hasCommentRow: true })
    });

    expect(placement?.placement).toBe('below');
    expect(placement?.y).toBe(nodeViewportRect.y + nodeViewportRect.height + 3);
  });

  it('flips feedback above when below does not fit', () => {
    const placement = placeCanvasFeedbackBar({
      nodeViewportRect: { x: 300, y: 650, width: 200, height: 40 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: [],
      barSize: canvasFeedbackBarSizeForTarget({ supportsImageLocalFeedback: true, hasCommentRow: true })
    });

    expect(placement?.placement).toBe('above');
    expect(placement?.y).toBe(571);
  });

  it('clamps feedback horizontally inside the viewport', () => {
    const placement = placeCanvasFeedbackBar({
      nodeViewportRect: { x: 8, y: 200, width: 80, height: 80 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: [],
      barSize: canvasFeedbackBarSizeForTarget({ supportsImageLocalFeedback: true, hasCommentRow: true })
    });

    expect(placement?.x).toBe(8);
  });

  it('uses the non-colliding candidate when a fixed bar reserves the preferred area', () => {
    const placement = placeCanvasFeedbackBar({
      nodeViewportRect: { x: 300, y: 200, width: 200, height: 120 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: [{ x: 190, y: 320, width: 420, height: 48 }],
      barSize: canvasFeedbackBarSizeForTarget({ supportsImageLocalFeedback: true, hasCommentRow: true })
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

  it('places retained feedback targets from the live Canvas camera', () => {
    expect(feedbackBarPlacementForCanvasTarget({
      target: {
        nodeRect: { x: 100, y: 50, width: 200, height: 100 },
        surfaceRect: { x: 10, y: 20, width: 900, height: 600 },
        supportsImageLocalFeedback: true,
        entry: undefined
      },
      camera: { x: 30, y: 40, z: 2 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: []
    })).toEqual({
      x: 242,
      y: 363,
      width: CANVAS_FEEDBACK_BAR_SIZE.imageWidth,
      height: CANVAS_FEEDBACK_BAR_SIZE.oneRowHeight,
      placement: 'below'
    });
  });

  it('sizes feedback bars from action set and comment row visibility', () => {
    expect(canvasFeedbackBarSizeForTarget({
      supportsImageLocalFeedback: false,
      hasCommentRow: false
    })).toEqual({ width: 325, height: 38 });
    expect(canvasFeedbackBarSizeForTarget({
      supportsImageLocalFeedback: false,
      hasCommentRow: true
    })).toEqual({ width: 325, height: 76 });
    expect(canvasFeedbackBarSizeForTarget({
      supportsImageLocalFeedback: true,
      hasCommentRow: false
    })).toEqual({ width: 397, height: 38 });
    expect(canvasFeedbackBarSizeForTarget({
      supportsImageLocalFeedback: true,
      hasCommentRow: true
    })).toEqual({ width: 397, height: 76 });
  });

  it('places feedback bars using their visible action rows and comment rows', () => {
    const baseTarget = {
      nodeRect: { x: 100, y: 50, width: 200, height: 100 },
      surfaceRect: { x: 10, y: 20, width: 900, height: 600 },
      camera: { x: 30, y: 40, z: 2 },
      entry: undefined
    };

    const fileOnlyPlacement = feedbackBarPlacementForCanvasTarget({
      target: {
        ...baseTarget,
        supportsImageLocalFeedback: false
      },
      camera: baseTarget.camera,
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: []
    });
    const imagePlacement = feedbackBarPlacementForCanvasTarget({
      target: {
        ...baseTarget,
        supportsImageLocalFeedback: true,
        entry: {
          projectRelativePath: 'flow/cover.png',
          marks: [],
          comments: [{
            id: 'comment-1',
            comment: 'overall direction',
            createdAt: '2026-05-26T12:00:00.000Z',
            updatedAt: '2026-05-26T12:00:00.000Z'
          }],
          nextRegionLabel: 1,
          regions: [],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      },
      camera: baseTarget.camera,
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: []
    });

    expect(fileOnlyPlacement?.width).toBe(CANVAS_FEEDBACK_BAR_SIZE.fileOnlyWidth);
    expect(imagePlacement?.width).toBe(CANVAS_FEEDBACK_BAR_SIZE.imageWidth);
    expect(fileOnlyPlacement?.height).toBe(CANVAS_FEEDBACK_BAR_SIZE.oneRowHeight);
    expect(imagePlacement?.height).toBe(CANVAS_FEEDBACK_BAR_SIZE.twoRowHeight);
  });

  it('refreshes retained feedback targets from the current feedback document before placement', () => {
    const target = {
      projectRelativePath: 'flow/cover.png',
      nodeRect: { x: 100, y: 50, width: 200, height: 100 },
      surfaceRect: { x: 10, y: 20, width: 900, height: 600 },
      camera: { x: 30, y: 40, z: 2 },
      entry: undefined,
      supportsImageLocalFeedback: true
    };
    const currentTarget = canvasFeedbackBarTargetWithCurrentEntry(target, {
      updatedAt: '2026-06-22T12:00:00.000Z',
      entries: {
        'flow/cover.png': {
          projectRelativePath: 'flow/cover.png',
          marks: [],
          comments: [{
            id: 'comment-1',
            comment: 'overall direction',
            createdAt: '2026-06-22T12:00:00.000Z',
            updatedAt: '2026-06-22T12:00:00.000Z'
          }],
          nextRegionLabel: 1,
          regions: [],
          updatedAt: '2026-06-22T12:00:00.000Z'
        }
      }
    });

    expect(currentTarget.entry?.comments.map((comment) => comment.comment)).toEqual(['overall direction']);
    expect(feedbackBarPlacementForCanvasTarget({
      target: currentTarget,
      camera: target.camera,
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: []
    })?.height).toBe(CANVAS_FEEDBACK_BAR_SIZE.twoRowHeight);
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
      x: 66,
      y: 654,
      width: CANVAS_RESET_LAYOUT_BUTTON_SIZE.width,
      height: CANVAS_RESET_LAYOUT_BUTTON_SIZE.height
    });
    expect(cardBar).toEqual({
      x: 102,
      y: 654,
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

  it('reserves the title bar at the top of the viewport', () => {
    expect(WORKBENCH_TITLE_BAR_HEIGHT).toBe(32);
    expect(TITLE_BAR_RESERVED_RECT(1280)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 32
    });
  });
});
