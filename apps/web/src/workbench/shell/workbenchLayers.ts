import type { FloatingBarRect } from './floatingBars';

export const WORKBENCH_TITLE_BAR_HEIGHT = 28;
export const WORKBENCH_CHROME_EDGE_INSET = {
  horizontal: 18,
  top: WORKBENCH_TITLE_BAR_HEIGHT + 13
} as const;

export function TITLE_BAR_RESERVED_RECT(width: number): FloatingBarRect {
  return {
    x: 0,
    y: 0,
    width,
    height: WORKBENCH_TITLE_BAR_HEIGHT
  };
}

export const WORKBENCH_TOP_CHROME_RESERVED_RECTS: FloatingBarRect[] = [
  {
    x: WORKBENCH_CHROME_EDGE_INSET.horizontal,
    y: WORKBENCH_CHROME_EDGE_INSET.top,
    width: 50,
    height: 176
  },
  {
    x: WORKBENCH_CHROME_EDGE_INSET.horizontal + 58,
    y: WORKBENCH_CHROME_EDGE_INSET.top,
    width: 280,
    height: 50
  }
];
