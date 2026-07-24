import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DebruteGlobalSettingsView } from '@debrute/app-protocol';
import type { SettingsResource, WorkbenchActions, WorkbenchState } from '../../../types.js';
import {
  AdobeBridgeSettingsPage,
  isPhotoshopLinkedToCurrentProject
} from './AdobeBridgeSettingsPage.js';
import { SettingsPanel } from '../SettingsPanel.js';
import { I18nProvider } from '../../i18n/index.js';
import { buildWorkbenchTitleBarState } from '../../shell/workbenchTitleBarState.js';

describe('web Adobe Bridge settings page', { tags: ['settings'] }, () => {
  it('adds Adobe Bridge to the Settings directory', () => {
    const html = renderWithI18n(React.createElement(SettingsPanel, {
      state: createState(),
      actions: createActions()
    }));

    expect(html).toContain('Adobe Bridge');
    expect(html).toContain('db-nav-row__icon');
  });

  it('renders bridge status, Photoshop clients, projects, and link actions', () => {
    const state = createState();
    const html = renderWithI18n(React.createElement(AdobeBridgeSettingsPage, {
      persistedSettings: readyResourceValue(state.globalSettings).adobeBridge,
      bridge: readyResourceValue(state.adobeBridge),
      projectId: state.projectId,
      actions: createActions()
    }));

    expect(html).not.toContain('<h2');
    expect(html).toContain('Available');
    expect(html).toContain('Photoshop 2026 · poster.psd');
    expect(html).toContain('Campaign');
    expect(html).toContain('Disconnect');
    expect(html).toContain('db-status-pill--neutral');
  });

  it('renders Adobe Bridge transfer failures with stable error labels', () => {
    const state = createState({
      adobeBridge: {
        status: 'ready',
        value: {
          ...readyResourceValue(createState().adobeBridge),
          transfers: [{
            transferId: 'transfer-failed',
            direction: 'debrute-to-photoshop',
            projectId: 'project-1',
            pluginInstanceId: 'ps-1',
            projectRelativePath: 'assets/cover.png',
            status: 'failed',
            errorCode: 'photoshop_place_failed',
            message: 'Action failed',
            createdAt: '2026-06-18T00:00:02.000Z',
            updatedAt: '2026-06-18T00:00:03.000Z'
          }]
        }
      }
    });
    const html = renderWithI18n(React.createElement(AdobeBridgeSettingsPage, {
      persistedSettings: readyResourceValue(state.globalSettings).adobeBridge,
      bridge: readyResourceValue(state.adobeBridge),
      projectId: state.projectId,
      actions: createActions()
    }));

    expect(html).toContain('Recent transfer failures');
    expect(html).toContain('assets/cover.png');
    expect(html).toContain('Photoshop could not place the file as a Smart Object.');
    expect(html).not.toContain('Action failed');
  });

  it('uses persisted enabled state and live discovery state', () => {
    const state = createState();
    const html = renderWithI18n(React.createElement(AdobeBridgeSettingsPage, {
      persistedSettings: { enabled: false },
      bridge: {
        ...readyResourceValue(state.adobeBridge),
        settings: { enabled: true, discoveryStatus: 'available' }
      },
      projectId: state.projectId,
      actions: createActions()
    }));

    expect(html).not.toContain('checked=""');
    expect(html).toContain('Available');
  });

  it('treats Photoshop links as project-scoped in Settings', () => {
    const state = createState({
      projectId: 'project-1',
      adobeBridge: {
        status: 'ready',
        value: {
          ...readyResourceValue(createState().adobeBridge),
          pairedPlugins: [],
          clients: [
            ...readyResourceValue(createState().adobeBridge).clients,
            {
              pluginInstanceId: 'ps-other-project',
              hostApp: 'photoshop',
              hostVersion: '2026',
              clientRuntime: 'uxp',
              displayName: 'Photoshop 2026 · other.psd',
              documentCount: 1,
              activeDocumentTitle: 'other.psd',
              connectedAt: '2026-06-18T00:00:00.000Z',
              lastSeenAt: '2026-06-18T00:00:01.000Z'
            }
          ],
          links: [
            ...readyResourceValue(createState().adobeBridge).links,
            {
              linkId: 'link-other-project',
              projectId: 'project-2',
              pluginInstanceId: 'ps-other-project',
              createdAt: '2026-06-18T00:00:01.000Z',
              status: 'active'
            }
          ]
        }
      }
    });

    const bridge = readyResourceValue(state.adobeBridge);
    expect(isPhotoshopLinkedToCurrentProject(bridge, state.projectId, 'ps-1')).toBe(true);
    expect(isPhotoshopLinkedToCurrentProject(bridge, state.projectId, 'ps-other-project')).toBe(false);
  });
});

function renderWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(I18nProvider, { locale: 'en', children: null }, element));
}

function createState(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    snapshot: undefined,
    projectId: 'project-1',
    titleBarState: buildWorkbenchTitleBarState({ platform: 'darwin', host: 'web', locale: 'en', recentProjectRoots: [] }),
    globalSettings: { status: 'ready', value: globalSettingsFixture() },
    product: { status: 'ready', value: null },
    resolvedTheme: 'dark',
    projectOpen: { opening: false },
    explorerSelection: { selectedPaths: [], focusedPath: null, anchorPath: null },
    adobeBridge: {
      status: 'ready',
      value: {
        settings: { enabled: true, discoveryStatus: 'available' },
        pairedPlugins: [],
        clients: [{
          pluginInstanceId: 'ps-1',
          hostApp: 'photoshop',
          hostVersion: '2026',
          clientRuntime: 'uxp',
          displayName: 'Photoshop 2026 · poster.psd',
          documentCount: 1,
          activeDocumentTitle: 'poster.psd',
          connectedAt: '2026-06-18T00:00:00.000Z',
          lastSeenAt: '2026-06-18T00:00:01.000Z'
        }],
        projects: [{
          projectId: 'project-1',
          projectName: 'Campaign',
          projectRevision: 1,
          directories: [{ projectRelativePath: 'assets', name: 'assets', depth: 1 }]
        }],
        links: [{
          linkId: 'link-1',
          projectId: 'project-1',
          pluginInstanceId: 'ps-1',
          createdAt: '2026-06-18T00:00:01.000Z',
          status: 'active'
        }],
        transfers: []
      }
    },
    canvasFeedback: undefined,
    textFileBuffers: {},
    textEditorWindows: {},
    notifications: [],
    ...overrides
  };
}

function createActions(): WorkbenchActions {
  return {
    reloadAdobeBridge: async () => undefined,
    saveGlobalSettings: async () => undefined,
    linkAdobeBridgePhotoshop: async () => undefined,
    unlinkAdobeBridgePhotoshop: async () => undefined
  } as unknown as WorkbenchActions;
}

function globalSettingsFixture(overrides: Partial<DebruteGlobalSettingsView> = {}): DebruteGlobalSettingsView {
  return {
    workbench: { locale: 'en', themePreference: 'system', defaultFrontend: 'desktop' },
    chrome: { recentProjects: [] },
    models: { image: [], video: [], audio: [] },
    integrations: { integrations: [], backends: [] },
    adobeBridge: { enabled: true },
    ...overrides
  };
}

function readyResourceValue<T>(resource: SettingsResource<T>): T {
  if (resource.status !== 'ready') {
    throw new Error(`Expected ready resource, got ${resource.status}.`);
  }
  return resource.value;
}
