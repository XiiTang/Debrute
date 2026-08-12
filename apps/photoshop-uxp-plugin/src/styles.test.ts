import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Photoshop UXP panel styles', () => {
  it('uses only the UXP layout and typography subset required by the panel', async () => {
    const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

    expect(css).not.toMatch(/display:\s*grid/);
    expect(css).not.toContain('color-mix(');
    expect(css).not.toMatch(/(^|[;{])\s*font\s*:/m);
    expect(css).not.toContain('text-transform:');
  });

  it('keeps only the fixed-layout tree viewport scrollable on both axes', async () => {
    const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

    expect(css.match(/\.photoshop-panel\s*\{[\s\S]*?\}/)?.[0]).toContain('height: 100vh');
    expect(css.match(/\.photoshop-panel__destination\s*\{[\s\S]*?\}/)?.[0]).toContain('flex: 1 1 auto');
    expect(css.match(/\.photoshop-panel__tree\s*\{[\s\S]*?\}/)?.[0]).toContain('overflow: auto');
    expect(css.match(/\.photoshop-panel__tree-content\s*\{[\s\S]*?\}/)?.[0]).toContain('min-width: 100%');
    expect(css.match(/\.photoshop-panel__tree-content\s*\{[\s\S]*?\}/)?.[0]).toContain('width: max-content');
    expect(css.match(/\.photoshop-panel__tree-row\s*\{[\s\S]*?\}/)?.[0]).toContain('width: 100%');
    expect(css.match(/\.photoshop-panel__footer\s*\{[\s\S]*?\}/)?.[0]).toContain('flex: 0 0 auto');
    expect(css).not.toContain('.photoshop-panel__selection');
    expect(css).not.toContain('.photoshop-panel__browser-row');
    expect(css).not.toMatch(/\bselect\b/);
    expect(css).not.toMatch(/@media|@container/);
  });

  it('matches the supported panel sizes and keeps focus, theme, and disabled states explicit', async () => {
    const [css, manifestText] = await Promise.all([
      readFile(new URL('./styles.css', import.meta.url), 'utf8'),
      readFile(new URL('../public/manifest.json', import.meta.url), 'utf8')
    ]);
    const manifest = JSON.parse(manifestText) as {
      entrypoints: Array<{
        minimumSize: { width: number; height: number };
        maximumSize: { width: number; height: number };
        preferredDockedSize: { width: number; height: number };
      }>;
    };
    const panel = manifest.entrypoints[0];

    expect(panel?.minimumSize).toEqual({ width: 300, height: 420 });
    expect(panel?.preferredDockedSize).toEqual({ width: 320, height: 560 });
    expect(panel?.maximumSize.height).toBe(900);
    expect(css.match(/\.photoshop-panel\s*\{[\s\S]*?\}/)?.[0]).toContain('min-width: 300px');
    expect(css.match(/\.photoshop-panel\s*\{[\s\S]*?\}/)?.[0]).toContain('min-height: 420px');
    expect(css).toContain('--panel-bg: var(--uxp-host-background-color');
    expect(css).toContain('--panel-text: var(--uxp-host-text-color');
    expect(css).toMatch(/\.photoshop-panel__tree-row:focus\s*\{/);
    expect(css).toMatch(/\.photoshop-panel__tree-row--selected\s*\{/);
    expect(css.match(/\.photoshop-panel__tree\s*\{[\s\S]*?\}/)?.[0]).toContain('--tree-indent-step: 14px');
    expect(css.match(/\.photoshop-panel__tree\s*\{[\s\S]*?\}/)?.[0]).toContain('--tree-row-left-offset: 6px');
    const rowRule = css.match(/\.photoshop-panel__tree-row\s*\{[\s\S]*?\}/)?.[0];
    expect(rowRule).toContain('display: flex');
    expect(rowRule).toContain('align-items: center');
    expect(rowRule).toContain('text-align: left');
    expect(rowRule).toContain('min-height: 24px');
    expect(rowRule).toContain('border-radius: 0');
    expect(rowRule).toContain('padding: 0 8px 0 calc(var(--tree-row-left-offset) + var(--tree-indent))');
    const iconRule = css.match(/\.photoshop-panel__tree-row svg\s*\{[\s\S]*?\}/)?.[0];
    expect(iconRule).toContain('width: 16px');
    expect(iconRule).toContain('flex: 0 0 16px');
    const labelRule = css.match(/\.photoshop-panel__tree-label\s*\{[\s\S]*?\}/)?.[0];
    expect(labelRule).toContain('margin-left: 7px');
    const guideRule = css.match(/\.photoshop-panel__tree-guide\s*\{[\s\S]*?\}/)?.[0];
    expect(guideRule).toContain('width: 1px');
    expect(guideRule).toContain('background: var(--panel-guide)');
    expect(css).not.toMatch(/(?:repeating-)?linear-gradient/);
    expect(css).not.toContain('.photoshop-panel__tree-disclosure');
    expect(css).toMatch(/\.photoshop-panel__tree-state\s*\{/);
    expect(css).toContain('.photoshop-panel__tree-state--error');
    expect(css).toContain('.photoshop-panel__tree-state--missing');
    expect(css).toMatch(/\.photoshop-panel__send:focus\s*\{/);
    expect(css).toMatch(/\.photoshop-panel__send:disabled\s*\{/);
    expect(css).toContain('.photoshop-panel__connection--connected');
    expect(css).toContain('.photoshop-panel__connection--waiting');
    expect(css).not.toContain('.photoshop-panel__connection--ready');
    expect(css).not.toContain('.photoshop-panel__connection--connecting');
    expect(css).not.toContain('.photoshop-panel__connection--disconnected');
  });
});
