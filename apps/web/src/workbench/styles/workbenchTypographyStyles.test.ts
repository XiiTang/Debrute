import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const baseStyles = readFileSync('apps/web/src/workbench/ui/styles/base.css', 'utf8');
const tokenStyles = readFileSync('apps/web/src/workbench/ui/styles/tokens.css', 'utf8');
const controlStyles = readFileSync('apps/web/src/workbench/ui/styles/controls.css', 'utf8');
const titleBarStyles = readFileSync('apps/web/src/workbench/styles/titlebar.css', 'utf8');
const shellStyles = readFileSync('apps/web/src/workbench/styles/shell.css', 'utf8');
const canvasStyles = readFileSync('apps/web/src/workbench/styles/canvas.css', 'utf8');

describe('Workbench functional typography', () => {
  it('uses one unitless functional line height for clipped single-line text', () => {
    expect(tokenStyles).toContain('--db-line-height-functional: 1.45;');
    expect(cssRule(baseStyles, 'body')).toContain('line-height: var(--db-line-height-functional);');

    const clippedSingleLineRules = [
      cssRule(controlStyles, '.db-button,\n.db-icon-button'),
      cssRule(titleBarStyles, '.workbench-titlebar__title'),
      cssRule(shellStyles, '.floating-panel-title'),
      cssRule(canvasStyles, '.canvas-minimap-button-zoom')
    ];

    for (const rule of clippedSingleLineRules) {
      expect(rule).not.toMatch(/line-height\s*:/);
    }
  });

  it('preserves leaf-owned horizontal truncation', () => {
    for (const rule of [
      cssRule(controlStyles, '.db-button__label'),
      cssRule(titleBarStyles, '.workbench-titlebar__title'),
      cssRule(shellStyles, '.floating-panel-title')
    ]) {
      expect(rule).toContain('overflow: hidden;');
      expect(rule).toContain('text-overflow: ellipsis;');
    }

    const minimapZoomRule = cssRule(canvasStyles, '.canvas-minimap-button-zoom');
    expect(minimapZoomRule).toContain('overflow: hidden;');
    expect(minimapZoomRule).toContain('white-space: nowrap;');
  });
});

function cssRule(styles: string, selector: string): string {
  const match = styles.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{[^}]*\\}`));
  if (!match) {
    throw new Error(`Expected CSS rule for ${selector}.`);
  }
  return match[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
