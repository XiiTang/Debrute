import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PhotoshopStateView } from '@debrute/app-protocol';
import { I18nProvider } from '../../i18n/index.js';
import { PluginsSettingsPage } from './PluginsSettingsPage.js';

describe('Plugins settings page', { tags: ['settings'] }, () => {
  it('renders the four Runtime-owned Photoshop statuses with exact diagnostics', () => {
    expect(renderPage('en', false, state('off'))).toContain('>Off</span>');
    expect(renderPage('en', true, state('waiting'))).toContain('Waiting for Photoshop');
    expect(renderPage('en', true, state('connected', 2))).toContain('Connected · 2 instances');
    expect(renderPage('en', true, state('unavailable'))).toContain(
      'Unavailable — Unable to bind any port from 32124 to 32131.'
    );
    expect(renderPage('zh-CN', true, state('unavailable'))).toContain(
      '不可用——无法绑定 32124–32131 中任何端口。'
    );
  });

  it('submits a closed patch but leaves the switch controlled by Runtime projections', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const save = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(page(false, state('off'), save));
      });
      const toggle = requireToggle(container);
      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });

      expect(save).toHaveBeenCalledWith({
        plugins: { photoshop: { enabled: true } }
      });
      expect(toggle.checked).toBe(false);

      await act(async () => {
        root.render(page(true, state('waiting'), save));
      });
      expect(requireToggle(container).checked).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('disables only its switch and shows the exact transfer message while busy', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(page(true, { ...state('connected', 1), transferActive: true }, async () => undefined));
      });
      expect(requireToggle(container).disabled).toBe(true);
      expect(container.textContent).toContain('Transfer in progress.');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('preserves the exact stale-disable rejection until the live busy projection arrives', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(page(true, state('connected', 1), async () => {
          throw new Error('Transfer in progress.');
        }));
      });
      await act(async () => {
        requireToggle(container).click();
        await Promise.resolve();
      });
      expect(requireToggle(container).disabled).toBe(true);
      expect(container.textContent).toContain('Transfer in progress.');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

function page(
  enabled: boolean,
  photoshop: PhotoshopStateView,
  save: (input: { plugins: { photoshop: { enabled: boolean } } }) => Promise<void>
): React.ReactElement {
  return (
    <I18nProvider locale="en">
      <PluginsSettingsPage
        settings={{ photoshop: { enabled } }}
        photoshop={photoshop}
        onSettingsChange={save}
      />
    </I18nProvider>
  );
}

function renderPage(
  locale: 'en' | 'zh-CN',
  enabled: boolean,
  photoshop: PhotoshopStateView
): string {
  return renderToStaticMarkup(
    <I18nProvider locale={locale}>
      <PluginsSettingsPage
        settings={{ photoshop: { enabled } }}
        photoshop={photoshop}
        onSettingsChange={async () => undefined}
      />
    </I18nProvider>
  );
}

function state(
  status: PhotoshopStateView['status'],
  sessionCount = 0
): PhotoshopStateView {
  return {
    status,
    transferActive: false,
    sessions: Array.from({ length: sessionCount }, (_, index) => ({
      pluginSessionId: `session-${index + 1}`,
      hostVersion: '27.0',
      placementMimeTypes: ['image/png'],
      documents: []
    }))
  };
}

function requireToggle(container: HTMLElement): HTMLInputElement {
  const toggle = container.querySelector('input[type="checkbox"]');
  if (!(toggle instanceof HTMLInputElement)) {
    throw new Error('Expected Photoshop Integration switch.');
  }
  return toggle;
}
