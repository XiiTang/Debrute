import type { FloatingBarRect } from './floatingBars';

export const WORKBENCH_TITLE_BAR_HEIGHT = 32;
export const WORKBENCH_FLOATING_DOCK_EDGE_INSET = {
  horizontal: 18,
  vertical: WORKBENCH_TITLE_BAR_HEIGHT + 13
} as const;

export function TITLE_BAR_RESERVED_RECT(width: number): FloatingBarRect {
  return {
    x: 0,
    y: 0,
    width,
    height: WORKBENCH_TITLE_BAR_HEIGHT
  };
}

export const FIXED_TOP_FLOATING_BAR_RECTS: FloatingBarRect[] = [
  {
    x: WORKBENCH_FLOATING_DOCK_EDGE_INSET.horizontal,
    y: WORKBENCH_FLOATING_DOCK_EDGE_INSET.vertical,
    width: 50,
    height: 176
  },
  {
    x: WORKBENCH_FLOATING_DOCK_EDGE_INSET.horizontal + 58,
    y: WORKBENCH_FLOATING_DOCK_EDGE_INSET.vertical,
    width: 280,
    height: 50
  }
];
