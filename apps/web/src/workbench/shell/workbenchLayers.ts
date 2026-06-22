import type { FloatingBarRect } from './floatingBars';

export const WORKBENCH_TITLE_BAR_HEIGHT = 32;

export function TITLE_BAR_RESERVED_RECT(width: number): FloatingBarRect {
  return {
    x: 0,
    y: 0,
    width,
    height: WORKBENCH_TITLE_BAR_HEIGHT
  };
}

export const FIXED_TOP_FLOATING_BAR_RECTS: FloatingBarRect[] = [
  { x: 18, y: WORKBENCH_TITLE_BAR_HEIGHT + 13, width: 50, height: 176 },
  { x: 76, y: WORKBENCH_TITLE_BAR_HEIGHT + 13, width: 280, height: 50 }
];
