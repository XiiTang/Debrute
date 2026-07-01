import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const canvasStyles = readFileSync(fileURLToPath(new URL('../styles/canvas.css', import.meta.url)), 'utf8');

describe('Canvas styles', () => {
  it('keeps the Canvas card bar without floating-bar base chrome', () => {
    expect(canvasStyles).not.toContain('.canvas-card-bar.db-floating-bar');
    expect(canvasStyles).not.toMatch(/\.canvas-card-bar\.db-floating-bar\s*{[^}]*\b(?:border|background|box-shadow|backdrop-filter)\s*:/);
    expect(canvasStyles).not.toMatch(/\.canvas-card-rename-input\.db-input\s*{[^}]*background:/);
  });

  it('keeps Canvas card names inside a fixed-width capsule', () => {
    expect(canvasStyles).toContain('--canvas-card-width: 78px;');
    expect(canvasStyles).toContain('.canvas-card {\n  width: var(--canvas-card-width);');
    expect(canvasStyles).toContain('padding: 0 8px;');
    expect(canvasStyles).toContain('.canvas-card-rename-form {\n  width: var(--canvas-card-width);');
    expect(canvasStyles).toContain('.canvas-card-rename-input {\n  width: 100%;');
    expect(canvasStyles).toContain('text-align: center;');
    expect(canvasStyles).not.toContain('.canvas-card .db-button__label');
    expect(canvasStyles).not.toContain('.canvas-card-rename-input.db-input');
    expect(canvasStyles).not.toContain('--canvas-card-name-ch');
    expect(canvasStyles).not.toContain('padding: 0 24px 0 8px;');
  });

  it('keeps the add-canvas control visually close to the canvas cards', () => {
    expect(canvasStyles).toMatch(/\.canvas-card-bar\s*{[^}]*\bgap: 4px;/);
    expect(canvasStyles).toMatch(/\.canvas-card-scroll\s*{[^}]*margin-right: calc\(-1 \* var\(--canvas-card-delete-overlap\)\);/);
  });

  it('keeps lower-left Canvas controls just above the bottom edge', () => {
    expect(canvasStyles).toMatch(/\.canvas-card-bar\s*{[^}]*\bbottom: 14px;/);
    expect(canvasStyles).toMatch(/\.canvas-minimap-bar\s*{[^}]*\bbottom: 14px;/);
    expect(canvasStyles).toMatch(/\.canvas-reset-layout-button\s*{[^}]*\bbottom: 14px;/);
  });

  it('pins the Canvas card delete control to the card border corner', () => {
    expect(canvasStyles).toContain('--canvas-card-delete-overlap: 7px;');
    expect(canvasStyles).toContain('height: calc(100% + var(--canvas-card-delete-overlap) + 2px);\n  margin-top: calc(-1 * var(--canvas-card-delete-overlap));\n  margin-right: calc(-1 * var(--canvas-card-delete-overlap));\n  padding-top: var(--canvas-card-delete-overlap);\n  padding-right: var(--canvas-card-delete-overlap);\n  padding-bottom: 2px;\n  padding-left: 2px;');
    expect(canvasStyles).toContain('.canvas-card-delete {\n  position: absolute;\n  top: 0;\n  right: 0;\n  transform: translate(37%, -37%);\n  z-index: 1;');
    expect(canvasStyles).toContain('.canvas-card-delete.db-workbench-close-button {\n  opacity: 0;\n  pointer-events: none;\n}');
    expect(canvasStyles).toContain('.canvas-card-wrap:hover .canvas-card-delete.db-workbench-close-button,\n.canvas-card-delete.db-workbench-close-button:focus-visible {\n  opacity: 1;\n  pointer-events: auto;\n}');
    expect(canvasStyles).not.toContain('.canvas-card-delete.db-icon-button');
    expect(canvasStyles).not.toContain('.canvas-card-delete::before');
    expect(canvasStyles).not.toMatch(/\.canvas-card-delete[^{]*{[^}]*background:/);
    expect(canvasStyles).not.toContain('transform: translate(0, -35%);');
    expect(canvasStyles).not.toContain('top: 1px;\n  right: 2px;');
  });

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

  it('keeps Canvas feedback frames as pointer-transparent node chrome below resize handles', () => {
    expect(canvasStyles).toMatch(/\.canvas-feedback-frame\s*{[^}]*position: absolute;/);
    expect(canvasStyles).toMatch(/\.canvas-feedback-frame\s*{[^}]*inset: calc\(-1px \* var\(--canvas-chrome-scale, 1\)\);/);
    expect(canvasStyles).toMatch(/\.canvas-feedback-frame\s*{[^}]*z-index: 3;/);
    expect(canvasStyles).toMatch(/\.canvas-feedback-frame\s*{[^}]*border: calc\(1px \* var\(--canvas-chrome-scale, 1\)\) solid transparent;/);
    expect(canvasStyles).toMatch(/\.canvas-feedback-frame\s*{[^}]*border-image-source: var\(--canvas-feedback-frame-gradient\);/);
    expect(canvasStyles).toMatch(/\.canvas-feedback-frame\s*{[^}]*border-image-slice: 1;/);
    expect(canvasStyles).toMatch(/\.canvas-feedback-frame\s*{[^}]*pointer-events: none;/);
    expect(canvasStyles).toMatch(/\.canvas-node-element\.canvas-node-has-feedback(?:\:hover|\.hovered|\.selected)/);
    expect(canvasStyles).toMatch(/\.canvas-node-resize\s*{[^}]*z-index: 4;/);
  });
});
