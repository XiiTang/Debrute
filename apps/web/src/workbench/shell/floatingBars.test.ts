import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CANVAS_FEEDBACK_BAR_LAYOUT,
  CANVAS_MINIMAP_BUTTON_SIZE,
  CANVAS_MINIMAP_PANEL_SIZE,
  canvasFeedbackBarSizeForTarget,
  canvasAnchorToViewportRect,
  canvasMinimapButtonRect,
  feedbackBarPlacementForCanvasTarget,
  canvasResetLayoutButtonRect,
  placeCanvasFeedbackBar,
  placeCanvasMinimapPanel,
  sameCanvasFeedbackBarTarget,
  type CanvasFeedbackBarTarget,
  type CanvasFeedbackNodeBarTarget,
  type CanvasLocalFeedbackDraft
} from './floatingBars';
import {
  TITLE_BAR_RESERVED_RECT,
  WORKBENCH_FLOATING_DOCK_EDGE_INSET,
  WORKBENCH_TITLE_BAR_HEIGHT
} from './workbenchLayers';

describe('feedback bar target equality', () => {
  it('requires local feedback drafts to carry the confirming image feedback target', () => {
    expectTypeOf<CanvasLocalFeedbackDraft['feedbackBarTarget']>().toEqualTypeOf<CanvasFeedbackNodeBarTarget>();
  });

  it('treats equal feedback bar targets as unchanged', () => {
    const target = feedbackTarget();

    expect(sameCanvasFeedbackBarTarget(target, {
      ...target,
      anchorRect: { ...target.anchorRect },
      surfaceRect: { ...target.surfaceRect },
      camera: { ...target.camera }
    })).toBe(true);
  });

  it('detects feedback bar target camera changes', () => {
    const target = feedbackTarget();

    expect(sameCanvasFeedbackBarTarget(target, {
      ...target,
      camera: { ...target.camera, z: 0.5 }
    })).toBe(false);
  });

  it('detects feedback bar target local toolset changes', () => {
    const target = feedbackTarget();

    expect(sameCanvasFeedbackBarTarget(target, {
      ...target,
      localToolset: 'none'
    })).toBe(false);
  });

  it('compares selection paths in stable selection order', () => {
    const target: CanvasFeedbackBarTarget = {
      kind: 'selection',
      projectRelativePaths: ['flow/a.png', 'flow/b.png'],
      anchorRect: { x: 10, y: 20, width: 300, height: 180 },
      surfaceRect: { x: 0, y: 0, width: 1280, height: 720 },
      camera: { x: 12, y: 24, z: 1 }
    };

    expect(sameCanvasFeedbackBarTarget(target, {
      ...target,
      projectRelativePaths: [...target.projectRelativePaths]
    })).toBe(true);
    expect(sameCanvasFeedbackBarTarget(target, {
      ...target,
      projectRelativePaths: [...target.projectRelativePaths].reverse()
    })).toBe(false);
  });
});

describe('floating bar placement', () => {
  it('places feedback below a node by default', () => {
    const barSize = canvasFeedbackBarSizeForTarget({ localToolset: 'image' });
    const placement = placeCanvasFeedbackBar({
      anchorViewportRect: { x: 300, y: 200, width: 200, height: 120 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: [],
      barSize
    });

    expect(placement).toEqual({
      x: 251,
      y: 323,
      width: barSize.width,
      height: barSize.height,
      placement: 'below'
    });
  });

  it('keeps feedback close to the hovered node to avoid hover target handoff', () => {
    const anchorViewportRect = { x: 300, y: 200, width: 200, height: 120 };
    const placement = placeCanvasFeedbackBar({
      anchorViewportRect,
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: [],
      barSize: canvasFeedbackBarSizeForTarget({ localToolset: 'image' })
    });

    expect(placement?.placement).toBe('below');
    expect(placement?.y).toBe(anchorViewportRect.y + anchorViewportRect.height + 3);
  });

  it('flips feedback above when below does not fit', () => {
    const placement = placeCanvasFeedbackBar({
      anchorViewportRect: { x: 300, y: 650, width: 200, height: 40 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: [],
      barSize: canvasFeedbackBarSizeForTarget({ localToolset: 'image' })
    });

    expect(placement?.placement).toBe('above');
    expect(placement?.y).toBe(523);
  });

  it('clamps feedback horizontally inside the viewport', () => {
    const placement = placeCanvasFeedbackBar({
      anchorViewportRect: { x: 8, y: 200, width: 80, height: 80 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: [],
      barSize: canvasFeedbackBarSizeForTarget({ localToolset: 'image' })
    });

    expect(placement?.x).toBe(8);
  });

  it('uses the non-colliding candidate when a fixed bar reserves the preferred area', () => {
    const placement = placeCanvasFeedbackBar({
      anchorViewportRect: { x: 300, y: 200, width: 200, height: 120 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: [{ x: 190, y: 320, width: 420, height: 48 }],
      barSize: canvasFeedbackBarSizeForTarget({ localToolset: 'image' })
    });

    expect(placement?.placement).toBe('above');
  });

  it('projects Canvas node bounds to viewport coordinates', () => {
    expect(canvasAnchorToViewportRect({
      anchorRect: { x: 100, y: 50, width: 200, height: 100 },
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
        kind: 'node',
        projectRelativePath: 'flow/cover.png',
        anchorRect: { x: 100, y: 50, width: 200, height: 100 },
        surfaceRect: { x: 10, y: 20, width: 900, height: 600 },
        camera: { x: 30, y: 40, z: 2 },
        localToolset: 'image',
        canStartVideoMomentFeedback: false
      },
      camera: { x: 30, y: 40, z: 2 },
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: []
    })).toEqual({
      x: 291,
      y: 363,
      width: 299,
      height: CANVAS_FEEDBACK_BAR_LAYOUT.twoRowHeight,
      placement: 'below'
    });
  });

  it('sizes feedback bars from fixed controls and visible action counts', () => {
    expect(canvasFeedbackBarSizeForTarget({
      localToolset: 'none'
    })).toEqual({ width: 228, height: 124 });
    expect(canvasFeedbackBarSizeForTarget({
      localToolset: 'image'
    })).toEqual({ width: 299, height: 124 });
    expect(canvasFeedbackBarSizeForTarget({
      localToolset: 'video'
    })).toEqual({ width: 329, height: 124 });
    expect(canvasFeedbackBarSizeForTarget({
      localToolset: 'none',
      marksOnly: true
    })).toEqual({ width: 228, height: 38 });
  });

  it('adds width for extra visible feedback actions without media width buckets', () => {
    expect(canvasFeedbackBarSizeForTarget({
      localToolset: 'none',
      extraActionCount: 1
    }).width).toBe(
      canvasFeedbackBarSizeForTarget({
        localToolset: 'none'
      }).width
      + CANVAS_FEEDBACK_BAR_LAYOUT.actionButtonSize
      + CANVAS_FEEDBACK_BAR_LAYOUT.actionGap
    );
  });

  it('places the always-present editable comment row for each toolset', () => {
    const baseTarget = {
      kind: 'node' as const,
      projectRelativePath: 'flow/cover.png',
      anchorRect: { x: 100, y: 50, width: 200, height: 100 },
      surfaceRect: { x: 10, y: 20, width: 900, height: 600 },
      camera: { x: 30, y: 40, z: 2 },
      canStartVideoMomentFeedback: false
    };

    const nodeOnlyPlacement = feedbackBarPlacementForCanvasTarget({
      target: {
        ...baseTarget,
        localToolset: 'none'
      },
      camera: baseTarget.camera,
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: []
    });
    const imagePlacement = feedbackBarPlacementForCanvasTarget({
      target: {
        ...baseTarget,
        localToolset: 'image'
      },
      camera: baseTarget.camera,
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 },
      reservedRects: []
    });

    expect(nodeOnlyPlacement?.width).toBe(228);
    expect(imagePlacement?.width).toBe(299);
    expect(nodeOnlyPlacement?.height).toBe(CANVAS_FEEDBACK_BAR_LAYOUT.twoRowHeight);
    expect(imagePlacement?.height).toBe(CANVAS_FEEDBACK_BAR_LAYOUT.twoRowHeight);
  });

  it('keeps the lower-left minimap button close to the bottom edge while matching the top-left dock x inset', () => {
    expect(canvasMinimapButtonRect({
      x: 0,
      y: 0,
      width: 1000,
      height: 700
    })).toEqual({
      x: WORKBENCH_FLOATING_DOCK_EDGE_INSET.horizontal,
      y: 658,
      width: CANVAS_MINIMAP_BUTTON_SIZE.width,
      height: CANVAS_MINIMAP_BUTTON_SIZE.height
    });
  });

  it('places lower-left Canvas controls in one row', () => {
    const viewportRect = { x: 0, y: 0, width: 1000, height: 700 };
    const minimapButton = canvasMinimapButtonRect(viewportRect);
    const resetButton = canvasResetLayoutButtonRect(viewportRect);
    expect(resetButton.y).toBe(minimapButton.y);
    expect(resetButton.x).toBeGreaterThan(minimapButton.x + minimapButton.width);
  });

  it('places the minimap panel above the lower-left button', () => {
    const buttonRect = canvasMinimapButtonRect({ x: 0, y: 0, width: 1000, height: 700 });

    expect(placeCanvasMinimapPanel({
      buttonRect,
      viewportRect: { x: 0, y: 0, width: 1000, height: 700 }
    })).toEqual({
      x: 18,
      y: 500,
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
      y: 500,
      width: CANVAS_MINIMAP_PANEL_SIZE.width,
      height: CANVAS_MINIMAP_PANEL_SIZE.height
    });
  });

  it('reserves the title bar at the top of the viewport', () => {
    expect(TITLE_BAR_RESERVED_RECT(1280)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: WORKBENCH_TITLE_BAR_HEIGHT
    });
  });
});

function feedbackTarget(projectRelativePath = 'flow/a.png'): CanvasFeedbackNodeBarTarget {
  return {
    kind: 'node',
    projectRelativePath,
    anchorRect: { x: 10, y: 20, width: 300, height: 180 },
    surfaceRect: { x: 0, y: 0, width: 1280, height: 720 },
    camera: { x: 12, y: 24, z: 1 },
    localToolset: 'image',
    canStartVideoMomentFeedback: false
  };
}
