import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FLOATING_PANEL_STATE } from './floatingPanels';
import { WorkbenchFloatingPanelShell } from './FloatingPanel';
import { I18nProvider } from '../i18n';

describe('FloatingPanel', () => {
  it('renders the shared product shell title, body, resize handles, and close action', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
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
      </I18nProvider>
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
    expect(html).toContain('>Explorer<');
  });
});
