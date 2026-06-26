import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOATING_PANEL_STATE,
  FLOATING_PANEL_DEFINITIONS
} from './floatingPanels';
import { WorkbenchFloatingPanelShell } from './FloatingPanel';
import { FLOATING_PANEL_DRAG_HIT_AREA_HEIGHT } from './windowBounds';

describe('FloatingPanel', () => {
  it('renders the shared product shell title inside the drag area without legacy header chrome', () => {
    const html = renderToStaticMarkup(
      <WorkbenchFloatingPanelShell
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
      </WorkbenchFloatingPanelShell>
    );

    expect(html).toContain('floating-panel-interaction-row');
    expect(html).toContain('class="floating-panel-drag-hit-area"');
    expect(html).toContain('class="floating-panel-title"');
    expect(html).toContain('floating-panel-body');
    for (const direction of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      expect(html).toContain(`floating-panel-resize-handle--${direction}`);
    }
    expect(html).toContain('Close Explorer');
    expect(html).toContain('db-workbench-close-button');
    expect(html).toContain('width="10"');
    expect(html).toContain('height="10"');
    expect(html).not.toContain('db-panel__header');
    expect(html).not.toContain('db-panel__title');
    expect(html).toContain('>Explorer<');
    expect(html).toContain(`--db-floating-panel-drag-hit-area-height:${FLOATING_PANEL_DRAG_HIT_AREA_HEIGHT}px`);
    expect(html).toContain(`height:${FLOATING_PANEL_DEFINITIONS.explorer.defaultHeight}px`);
  });
});
