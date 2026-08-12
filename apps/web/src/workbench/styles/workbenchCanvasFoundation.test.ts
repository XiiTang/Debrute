import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shellStyles = readFileSync('apps/web/src/workbench/styles/shell.css', 'utf8');
const titleBarStyles = readFileSync('apps/web/src/workbench/styles/titlebar.css', 'utf8');
const canvasStyles = readFileSync('apps/web/src/workbench/styles/canvas.css', 'utf8');
const tokenStyles = readFileSync('apps/web/src/workbench/ui/styles/tokens.css', 'utf8');
const controlStyles = readFileSync('apps/web/src/workbench/ui/styles/controls.css', 'utf8');

describe('Workbench Canvas foundation', () => {
  it('uses one Canvas grid without a shell underlay', () => {
    const shellRule = cssRule(shellStyles, '.workbench-shell');
    const canvasSurfaceRule = cssRule(canvasStyles, '.canvas-surface');

    expect(shellRule).toContain('background-size: var(--db-canvas-grid-size);');
    expect(canvasSurfaceRule).toContain('background-size: var(--db-canvas-grid-size);');
    expect(shellStyles).not.toContain('.workbench-shell::before');
  });

  it('keeps transparent title-bar controls legible without a persistent strip', () => {
    const titleRule = cssRule(titleBarStyles, '.workbench-titlebar__title');
    const menuButtonRule = cssRule(titleBarStyles, '.workbench-titlebar__menu-button');
    const windowButtonRule = cssRule(controlStyles, '.db-icon-button--titlebar');
    const windowButtonIconRule = cssRule(controlStyles, '.db-icon-button--window-close .db-icon-button__icon');

    expect(titleRule).toContain('text-shadow: var(--db-titlebar-contrast-shadow);');
    expect(menuButtonRule).toContain('text-shadow: var(--db-titlebar-contrast-shadow);');
    expect(windowButtonRule).toContain('color: var(--db-text-muted);');
    expect(windowButtonIconRule).toContain('padding: var(--db-titlebar-icon-contrast-inset);');
    expect(titleBarStyles).not.toContain('.db-icon-button__icon');
  });

  it('centres valid Workbench states below the one canonical title-bar height', () => {
    const titleBarRule = cssRule(titleBarStyles, '.workbench-titlebar');
    const emptyEditorRule = cssRule(shellStyles, '.empty-editor');
    const titledBootRule = cssRule(shellStyles, '.boot-screen--with-titlebar');

    expect(tokenStyles).toContain('--db-titlebar-height: 28px;');
    expect(titleBarRule).toContain('height: var(--db-titlebar-height);');
    expect(emptyEditorRule).toContain('height: 100%;');
    expect(emptyEditorRule).toContain('padding-block-start: var(--db-titlebar-height);');
    expect(titledBootRule).toContain('padding-block-start: var(--db-titlebar-height);');
  });

  it('centres every Canvas resize handle on the selected node border', () => {
    const expectedAnchors = new Map([
      ['n', ['top: 0;', 'left: 50%;', 'transform: translate(-50%, -50%);']],
      ['s', ['bottom: 0;', 'left: 50%;', 'transform: translate(-50%, 50%);']],
      ['e', ['top: 50%;', 'right: 0;', 'transform: translate(50%, -50%);']],
      ['w', ['top: 50%;', 'left: 0;', 'transform: translate(-50%, -50%);']],
      ['nw', ['top: 0;', 'left: 0;', 'transform: translate(-50%, -50%);']],
      ['ne', ['top: 0;', 'right: 0;', 'transform: translate(50%, -50%);']],
      ['sw', ['bottom: 0;', 'left: 0;', 'transform: translate(-50%, 50%);']],
      ['se', ['bottom: 0;', 'right: 0;', 'transform: translate(50%, 50%);']]
    ]);

    for (const [handle, declarations] of expectedAnchors) {
      const rule = cssRule(canvasStyles, `.canvas-node-resize.${handle}`);
      for (const declaration of declarations) {
        expect(rule).toContain(declaration);
      }
    }
    expect(canvasStyles).not.toContain('calc(-8px * var(--canvas-chrome-scale, 1))');
  });

  it('paints node hover, Selection, and inactive-content affordance without changing layout geometry', () => {
    const frameRule = cssRule(canvasStyles, '.db-canvas-node-frame');
    const framePaintRule = cssRule(canvasStyles, '.db-canvas-node-frame:not(.image)::before');
    const hoverRule = cssRule(canvasStyles, '.db-canvas-node-frame[data-canvas-hovered="true"]');
    const selectionRule = cssRule(canvasStyles, '.db-canvas-node-frame[data-canvas-selected="true"]');
    const inactiveContentHoverRule = cssRule(
      canvasStyles,
      '.canvas-node-element:not([data-canvas-content-active="true"]) [data-canvas-node-zone="content"]:hover::after'
    );

    expect(frameRule).toContain('border: 0;');
    expect(framePaintRule).toContain('position: absolute;');
    expect(framePaintRule).toContain('box-shadow: inset');
    expect(framePaintRule).toContain('pointer-events: none;');
    expect(hoverRule).toContain('outline: calc(1px * var(--canvas-chrome-scale, 1))');
    expect(selectionRule).toContain('outline: calc(2px * var(--canvas-chrome-scale, 1))');
    expect(inactiveContentHoverRule).toContain('box-shadow: inset 0 0 0 calc(1px * var(--canvas-local-chrome-scale, 1))');
    expect(canvasStyles).not.toContain(
      '.canvas-node-element[data-canvas-content-active="true"] [data-canvas-node-zone="content"]::after'
    );
  });

  it('keeps image and video spatial Feedback above raster previews and below Canvas controls', () => {
    const feedbackLayerRule = cssRule(canvasStyles, '.canvas-media-feedback-layer');
    const rasterLayersRule = cssRule(canvasStyles, '.canvas-raster-preview-layers');
    const contentZoneRule = cssRule(canvasStyles, '[data-canvas-node-zone="content"]::after');

    expect(feedbackLayerRule).toContain('z-index: 3;');
    expect(rasterLayersRule).toContain('z-index: 2;');
    expect(contentZoneRule).toContain('z-index: 6;');
  });

  it('keeps Audio and Video Media Chrome rectangular and the shared presentation scale data-driven', () => {
    const nodeRule = cssRule(canvasStyles, '.canvas-node-element');
    const presentationRule = cssRule(canvasStyles, '.canvas-node-presentation');
    const titlebarRule = cssRule(canvasStyles, '.db-canvas-node-titlebar');
    const videoRule = cssRule(canvasStyles, '.canvas-video-node');
    const audioRule = cssRule(canvasStyles, '.canvas-audio-node');
    const textRule = cssRule(canvasStyles, '.canvas-text-node');
    const mediaControlRules = cssRule(canvasStyles, '.canvas-video-player media-time-display');

    expect(presentationRule).toContain('var(--canvas-node-presentation-scale, 1)');
    expect(nodeRule).toContain('--canvas-local-chrome-scale: var(--canvas-chrome-scale, 1);');
    expect(presentationRule).toContain('var(--canvas-node-presentation-scale-inverse, 1)');
    expect(presentationRule).not.toContain('scale(10)');
    expect(titlebarRule).toContain('height: var(--canvas-node-titlebar-height);');
    for (const rule of [videoRule, audioRule, textRule]) {
      expect(rule).toContain('grid-template-rows: var(--canvas-node-titlebar-height) minmax(0, 1fr);');
    }
    expect(mediaControlRules).toContain('border-radius: 0;');
  });
});

function cssRule(styles: string, selector: string): string {
  const matches = styles.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{[^}]*\\}`, 'g'));
  if (!matches) {
    throw new Error(`Expected CSS rule for ${selector}.`);
  }
  return matches.join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
