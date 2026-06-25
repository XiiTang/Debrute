import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOATING_PANEL_STATE,
  FLOATING_PANEL_DEFINITIONS
} from './floatingPanels';
import { FloatingPanel } from './FloatingPanel';
import { FLOATING_PANEL_TITLEBAR_HEIGHT } from './windowBounds';

describe('FloatingPanel', () => {
  it('exposes the shared titlebar height to floating panel CSS', () => {
    const html = renderToStaticMarkup(
      <FloatingPanel
        panelId="explorer"
        state={{
          panels: {
            ...DEFAULT_FLOATING_PANEL_STATE.panels,
            explorer: {
              ...DEFAULT_FLOATING_PANEL_STATE.panels.explorer,
              open: true
            }
          }
        }}
        orderState={{ orderBackToFront: [] }}
        onClose={() => undefined}
        onBringToFront={() => undefined}
        onDrag={() => undefined}
        onResize={() => undefined}
      >
        <div>Explorer content</div>
      </FloatingPanel>
    );

    expect(html).toContain(`--db-floating-panel-titlebar-height:${FLOATING_PANEL_TITLEBAR_HEIGHT}px`);
    expect(html).toContain(`height:${FLOATING_PANEL_DEFINITIONS.explorer.defaultHeight}px`);
  });

  it('sizes floating panel rows and headers from the shared titlebar CSS variable', () => {
    const css = readFileSync('apps/web/src/workbench/styles/shell.css', 'utf8');

    expect(css).toContain('grid-template-rows: var(--db-floating-panel-titlebar-height) minmax(0, 1fr);');
    expect(css).toContain('height: var(--db-floating-panel-titlebar-height);');
    expect(css).toContain('min-height: var(--db-floating-panel-titlebar-height);');
  });
});
