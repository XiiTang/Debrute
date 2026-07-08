import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import { DEFAULT_FLOATING_PANEL_STATE } from './floatingPanels';
import { FloatingDock } from './FloatingDock';

function renderStaticWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      {element}
    </I18nProvider>
  );
}

describe('FloatingDock', () => {
  it('disables unavailable panel buttons', () => {
    const html = renderStaticWithI18n(
      <FloatingDock
        panelState={DEFAULT_FLOATING_PANEL_STATE}
        disabledPanelIds={['terminal']}
        onToggle={() => undefined}
      />
    );

    expect(html).toContain('aria-label="Terminal"');
    expect(html).toContain('disabled=""');
  });
});
