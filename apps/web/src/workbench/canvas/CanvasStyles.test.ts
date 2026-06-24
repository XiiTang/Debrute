import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const canvasStyles = readFileSync(fileURLToPath(new URL('../styles/canvas.css', import.meta.url)), 'utf8');

describe('Canvas styles', () => {
  it('keeps selected node resize handles outside the node content hit area', () => {
    expect(canvasStyles).toContain('.canvas-node-resize.n {\n  top: calc(-8px * var(--canvas-chrome-scale, 1));');
    expect(canvasStyles).toContain('.canvas-node-resize.s {\n  bottom: calc(-8px * var(--canvas-chrome-scale, 1));');
    expect(canvasStyles).toContain('.canvas-node-resize.e {\n  top: 50%;\n  right: calc(-8px * var(--canvas-chrome-scale, 1));');
    expect(canvasStyles).toContain('.canvas-node-resize.w {\n  top: 50%;\n  left: calc(-8px * var(--canvas-chrome-scale, 1));');
    expect(canvasStyles).toContain('.canvas-node-resize.nw {\n  top: calc(-8px * var(--canvas-chrome-scale, 1));\n  left: calc(-8px * var(--canvas-chrome-scale, 1));');
    expect(canvasStyles).toContain('.canvas-node-resize.ne {\n  top: calc(-8px * var(--canvas-chrome-scale, 1));\n  right: calc(-8px * var(--canvas-chrome-scale, 1));');
    expect(canvasStyles).toContain('.canvas-node-resize.sw {\n  bottom: calc(-8px * var(--canvas-chrome-scale, 1));\n  left: calc(-8px * var(--canvas-chrome-scale, 1));');
    expect(canvasStyles).toContain('.canvas-node-resize.se {\n  right: calc(-8px * var(--canvas-chrome-scale, 1));\n  bottom: calc(-8px * var(--canvas-chrome-scale, 1));');
  });
});
