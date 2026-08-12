import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/index';
import { SettingsResourcePanel } from './SettingsResourcePanel';

describe('SettingsResourcePanel', { tags: ['settings'] }, () => {
  it('renders loading state without rendering ready children', () => {
    const html = renderWithI18n(
      <SettingsResourcePanel title="Image Models" resource={{ status: 'loading' }}>
        {() => <div>ready content</div>}
      </SettingsResourcePanel>
    );

    expect(html).toContain('<h2>Image Models</h2>');
    expect(html).toContain('Loading settings');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('ready content');
  });

  it('renders ready children with the loaded value', () => {
    const html = renderWithI18n(
      <SettingsResourcePanel title="Image Models" resource={{ status: 'ready', value: { label: 'loaded' } }}>
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
