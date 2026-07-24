import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shellStyles = readFileSync('apps/web/src/workbench/styles/shell.css', 'utf8');
const titleBarStyles = readFileSync('apps/web/src/workbench/styles/titlebar.css', 'utf8');
const canvasStyles = readFileSync('apps/web/src/workbench/styles/canvas.css', 'utf8');
const tokenStyles = readFileSync('apps/web/src/workbench/ui/styles/tokens.css', 'utf8');
const controlStyles = readFileSync('apps/web/src/workbench/ui/styles/controls.css', 'utf8');

describe('Workbench Canvas foundation', () => {
  it('paints one continuous Canvas background behind a transparent title bar', () => {
    const shellRule = cssRule(shellStyles, '.workbench-shell');
    const canvasSurfaceRule = cssRule(canvasStyles, '.canvas-surface');

    expect(shellRule).toContain('background: var(--db-canvas-field);');
    expect(shellRule).toContain('background-size: var(--db-canvas-grid-size);');
    expect(canvasSurfaceRule).toContain('background: var(--db-canvas-field);');
    expect(canvasSurfaceRule).toContain('background-size: var(--db-canvas-grid-size);');
    expect(shellStyles).not.toContain('.workbench-shell::before');
    expect(titleBarStyles).not.toContain('.workbench-titlebar::before');
  });

  it('keeps transparent title-bar controls legible without a persistent strip', () => {
    const titleBarRule = cssRule(titleBarStyles, '.workbench-titlebar');
    const titleRule = cssRule(titleBarStyles, '.workbench-titlebar__title');
    const menuButtonRule = cssRule(titleBarStyles, '.workbench-titlebar__menu-button');
    const windowButtonRule = cssRule(controlStyles, '.db-icon-button--titlebar');
    const windowButtonIconRule = cssRule(controlStyles, '.db-icon-button--window-close .db-icon-button__icon');

    expect(titleBarRule).not.toContain('background:');
    expect(titleRule).toContain('text-shadow: var(--db-titlebar-contrast-shadow);');
    expect(menuButtonRule).toContain('text-shadow: var(--db-titlebar-contrast-shadow);');
    expect(windowButtonRule).toContain('color: var(--db-text-muted);');
    expect(controlStyles).toContain('.db-icon-button--titlebar .db-icon-button__icon,');
    expect(windowButtonIconRule).toContain('background: var(--db-canvas-bg);');
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
