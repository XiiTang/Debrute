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
});
