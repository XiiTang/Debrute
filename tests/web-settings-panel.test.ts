import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../apps/web/src/workbench/settings/SettingsPanel';
import { GeneralSettingsPage } from '../apps/web/src/workbench/settings/general/GeneralSettingsPage';
import { I18nProvider } from '../apps/web/src/workbench/i18n';
import { unavailableWorkbenchTitleBarState, type DebruteGlobalSettingsView, type DebruteProductState } from '@debrute/app-protocol';
import { createEmptyProjectTreeSelection } from '../apps/web/src/workbench/project-explorer/projectTreeInteraction';
import type { WorkbenchActions, WorkbenchState } from '../apps/web/src/types';

describe('web Settings pages', () => {
  it('uses General as the default page and has no Debrute CLI navigation item', () => {
    const html = renderWithI18n(React.createElement(SettingsPanel, {
      state: stateFixture(),
      actions: actionsFixture()
    }));

    expect(html.match(/class="db-nav-row(?: db-nav-row--active)?"/g)).toHaveLength(8);
    expect(html).toContain('Application');
    expect(html).toContain('Updates');
    expect(html).not.toContain('settings.debruteCli');
    expect(html).not.toContain('Install Debrute CLI');
  });

  it('renders runtime product update state and exactly one read-only CLI diagnostic line in General', () => {
    const html = renderWithI18n(React.createElement(GeneralSettingsPage, {
      actions: actionsFixture(),
      settings: globalSettingsFixture(),
      resolvedTheme: 'dark',
      onSettingsChange: async () => undefined,
      initialProductState: productState({
        update: {
          type: 'available',
          currentVersion: '0.2.0',
          updateVersion: '0.3.0',
          releaseName: 'Debrute 0.3.0'
        }
      })
    }));

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
      settings: globalSettingsFixture(),
      resolvedTheme: 'dark',
      onSettingsChange: async () => undefined,
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
    titleBarState: unavailableWorkbenchTitleBarState(),
    globalSettings: { status: 'ready', value: globalSettingsFixture() },
    resolvedTheme: 'dark',
    projectOpen: { opening: false },
    explorerSelection: createEmptyProjectTreeSelection(),
    adobeBridge: { status: 'ready', value: { settings: { enabled: true, discoveryStatus: 'available' }, adobeClients: [], projects: [], links: [], transfers: [] } },
    canvasFeedback: undefined,
    textFileBuffers: {},
    textEditorWindows: {},
    notifications: []
  };
}

function actionsFixture(): WorkbenchActions {
  return {
    getProductState: vi.fn(async () => productState()),
    checkProductUpdate: vi.fn(async () => productState()),
    applyProductUpdate: vi.fn(async () => ({ state: productState() })),
    reloadGlobalSettings: vi.fn(async () => undefined),
    reloadAdobeBridge: vi.fn(async () => undefined),
    saveGlobalSettings: vi.fn(async () => undefined),
    runIntegrationOperation: vi.fn(async (input) => ({
      ok: true,
      integrationId: input.integrationId,
      operation: input.operation,
      settings: { integrations: [], backends: [] }
    }))
  } as unknown as WorkbenchActions;
}

function globalSettingsFixture(overrides: Partial<DebruteGlobalSettingsView> = {}): DebruteGlobalSettingsView {
  return {
    workbench: { locale: 'en', themePreference: 'system', defaultFrontend: 'electron' },
    chrome: { recentProjectRoots: [] },
    models: { image: { models: [] }, video: { models: [] }, audio: { models: [] } },
    integrations: { integrations: [], backends: [] },
    adobeBridge: { enabled: true },
    ...overrides
  };
}
