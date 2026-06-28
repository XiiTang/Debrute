import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../apps/web/src/workbench/settings/SettingsPanel';
import { GeneralSettingsPage } from '../apps/web/src/workbench/settings/general/GeneralSettingsPage';
import { I18nProvider } from '../apps/web/src/workbench/i18n';
import type { DebruteProductState } from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../apps/web/src/types';

describe('web Settings pages', () => {
  it('uses General as the default page and has no Debrute CLI navigation item', () => {
    const html = renderWithI18n(React.createElement(SettingsPanel, {
      state: stateFixture(),
      actions: actionsFixture()
    }));

    expect(html.match(/class="db-nav-row(?: db-nav-row--active)?"/g)).toHaveLength(5);
    expect(html.indexOf('General')).toBeLessThan(html.indexOf('LLM'));
    expect(html).toContain('Application');
    expect(html).toContain('Updates');
    expect(html.match(/Debrute CLI/g)).toHaveLength(1);
    expect(html).not.toContain('settings.debruteCli');
    expect(html).not.toContain('Install Debrute CLI');
  });

  it('renders runtime product update state and exactly one read-only CLI diagnostic line in General', () => {
    const html = renderWithI18n(React.createElement(GeneralSettingsPage, {
      actions: actionsFixture(),
      initialProductState: productState({
        update: {
          type: 'available',
          currentVersion: '0.2.0',
          updateVersion: '0.3.0',
          releaseName: 'Debrute 0.3.0'
        }
      })
    }));

    expect(html).toContain('General');
    expect(html).toContain('Application');
    expect(html).toContain('Updates');
    expect(html).toContain('Current version');
    expect(html).toContain('0.2.0');
    expect(html).toContain('0.3.0');
    expect(html.match(/Debrute CLI/g)).toHaveLength(1);
    expect(html).toContain('/Users/me/.debrute/bin/debrute');
    expect(html).toContain('Install and Restart');
    expect(html).not.toContain('Install Debrute CLI');
    expect(html).not.toContain('Copy Manual Install Command');
    expect(html).not.toContain('Repair PATH');
    expect(html).not.toContain('Sync Skills');
    expect(html).not.toContain('Restore All Debrute Skills');
    expect(html).not.toContain('Open GitHub Releases');
  });

  it('renders product errors without exposing standalone CLI install actions', () => {
    const html = renderWithI18n(React.createElement(GeneralSettingsPage, {
      actions: actionsFixture(),
      initialProductState: productState({
        cli: {
          status: 'error',
          version: '0.2.0',
          path: '/Users/me/.debrute/bin/debrute',
          message: 'Product payload manifest is invalid.'
        },
        update: {
          type: 'error',
          currentVersion: '0.2.0',
          operation: 'apply',
          message: 'checksum failed',
          updateVersion: '0.3.0'
        }
      })
    }));

    expect(html).toContain('Product payload manifest is invalid.');
    expect(html).toContain('checksum failed');
    expect(html).toContain('Install and Restart');
    expect(html).not.toContain('Download Update');
  });
});

function renderWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, { locale: 'en' }, element));
}

function productState(overrides: Partial<DebruteProductState> = {}): DebruteProductState {
  return {
    productVersion: '0.2.0',
    platform: 'darwin',
    cli: {
      status: 'ready',
      version: '0.2.0',
      path: '/Users/me/.debrute/bin/debrute',
      skillsVersion: '0.2.0',
      skillsRoot: '/Users/me/.agents/skills'
    },
    update: {
      type: 'idle',
      currentVersion: '0.2.0',
      updateAvailable: false
    },
    ...overrides
  };
}

function stateFixture(): WorkbenchState {
  return {
    snapshot: undefined,
    titleBarState: { available: false },
    workbenchPreferences: { locale: 'en', themePreference: 'system' },
    resolvedTheme: 'dark',
    projectOpen: { opening: false },
    explorerSelection: { selectedPaths: [], focusedPath: undefined, anchorPath: undefined },
    llmSettings: { providers: [], availableModelKeys: [], defaultModelKey: null },
    imageModelSettings: { models: [] },
    videoModelSettings: { models: [] },
    integrationsSettings: undefined,
    adobeBridge: undefined,
    canvasFeedback: undefined,
    textFileBuffers: {},
    textEditorWindows: {},
    notifications: []
  } as unknown as WorkbenchState;
}

function actionsFixture(): WorkbenchActions {
  return {
    getProductState: vi.fn(async () => productState()),
    checkProductUpdate: vi.fn(async () => productState()),
    applyProductUpdate: vi.fn(async () => ({ state: productState() })),
    saveWorkbenchPreferences: vi.fn(async () => undefined)
  } as unknown as WorkbenchActions;
}
