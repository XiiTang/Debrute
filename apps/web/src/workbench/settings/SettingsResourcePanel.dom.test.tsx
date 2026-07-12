import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { SettingsResourcePanel } from './SettingsResourcePanel';

describe('SettingsResourcePanel', { tags: ['settings'] }, () => {
  it('renders loading state without rendering ready children', () => {
    const html = renderWithI18n(
      <SettingsResourcePanel title="Image Models" resource={{ status: 'loading' }} onRetry={async () => undefined}>
        {() => <div>ready content</div>}
      </SettingsResourcePanel>
    );

    expect(html).toContain('<h2>Image Models</h2>');
    expect(html).toContain('Loading settings');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('ready content');
  });

  it('renders error state with retry instead of ready children', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onRetry = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <SettingsResourcePanel title="Image Models" resource={{ status: 'error', message: 'secrets invalid' }} onRetry={onRetry}>
              {() => <div>ready content</div>}
            </SettingsResourcePanel>
          </I18nProvider>
        );
      });

      expect(container.textContent).toContain('Failed to load settings: secrets invalid');
      expect(container.textContent).not.toContain('ready content');

      const retry = requireButton(container, 'Retry');
      await act(async () => {
        retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });

      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      await unmount(root, container);
    }
  });

  it('renders ready children with the loaded value', () => {
    const html = renderWithI18n(
      <SettingsResourcePanel title="Image Models" resource={{ status: 'ready', value: { label: 'loaded' } }} onRetry={async () => undefined}>
        {(value) => <div>{value.label}</div>}
      </SettingsResourcePanel>
    );

    expect(html).toContain('<h2>Image Models</h2>');
    expect(html).toContain('loaded');
    expect((html.match(/<h2/g) ?? []).length).toBe(1);
    expect(html).not.toContain('Loading settings');
    expect(html).not.toContain('Failed to load settings');
  });
});

function renderWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(<I18nProvider locale="en">{element}</I18nProvider>);
}

async function unmount(root: Root, container: HTMLDivElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function requireButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent === label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button ${label}.`);
  }
  return button;
}
