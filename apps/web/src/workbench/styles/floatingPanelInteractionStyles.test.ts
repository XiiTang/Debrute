import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shellStyles = readFileSync('apps/web/src/workbench/styles/shell.css', 'utf8');

describe('Workbench floating panel interaction geometry', () => {
  it('reserves the complete north-east title slot for the close action', () => {
    const panelRule = cssRule(shellStyles, '.floating-panel--workbench-panel');
    const closeRule = cssRule(
      shellStyles,
      '.floating-panel--workbench-panel .floating-panel-close-button'
    );
    const northResizeRule = cssRule(
      shellStyles,
      '.floating-panel--workbench-panel .floating-panel-resize-handle--n'
    );
    const eastResizeRule = cssRule(
      shellStyles,
      '.floating-panel--workbench-panel .floating-panel-resize-handle--e'
    );

    expect(panelRule).toContain(
      '--db-floating-panel-close-hit-area-size: var(--db-floating-panel-drag-hit-area-height);'
    );
    expect(closeRule).toContain('top: 0;');
    expect(closeRule).toContain('right: 0;');
    expect(closeRule).toContain('width: var(--db-floating-panel-close-hit-area-size);');
    expect(closeRule).toContain('height: var(--db-floating-panel-close-hit-area-size);');
    expect(northResizeRule).toContain('right: var(--db-floating-panel-close-hit-area-size);');
    expect(eastResizeRule).toContain('top: var(--db-floating-panel-close-hit-area-size);');
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
