import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkbenchActions, WorkbenchState } from '../apps/web/src/types';
import {
  AdobeBridgeSettingsPage,
  isPhotoshopLinkedToCurrentProject
} from '../apps/web/src/workbench/settings/adobe-bridge/AdobeBridgeSettingsPage';
import { SettingsPanel } from '../apps/web/src/workbench/settings/SettingsPanel';

describe('web Adobe Bridge settings page', () => {
  it('adds Adobe Bridge to the Settings directory', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsPanel, {
      state: createState(),
      actions: createActions()
    }));

    expect(html).toContain('Adobe Bridge');
    expect(html).toContain('db-nav-row__icon');
  });

  it('renders bridge status, Photoshop clients, projects, and link actions', () => {
    const html = renderToStaticMarkup(React.createElement(AdobeBridgeSettingsPage, {
      state: createState(),
      actions: createActions()
    }));

    expect(html).toContain('<h2>Adobe Bridge</h2>');
    expect(html).toContain('Available');
    expect(html).toContain('Photoshop 2026 · poster.psd');
    expect(html).toContain('Campaign');
    expect(html).toContain('Disconnect');
  });

  it('renders Adobe Bridge transfer failures with stable error labels', () => {
    const html = renderToStaticMarkup(React.createElement(AdobeBridgeSettingsPage, {
      state: createState({
        adobeBridge: {
          ...createState().adobeBridge!,
          transfers: [{
            transferId: 'transfer-failed',
            direction: 'debrute-to-photoshop',
            projectId: 'project-1',
            adobeClientId: 'ps-1',
            projectRelativePath: 'assets/cover.png',
            status: 'failed',
            errorCode: 'photoshop_place_failed',
            message: 'Action failed',
            createdAt: '2026-06-18T00:00:02.000Z',
            updatedAt: '2026-06-18T00:00:03.000Z'
          }]
        }
      }),
      actions: createActions()
    }));

    expect(html).toContain('Recent transfer failures');
    expect(html).toContain('assets/cover.png');
    expect(html).toContain('Photoshop could not place the file as a Smart Object.');
    expect(html).not.toContain('Action failed');
  });

  it('treats Photoshop links as project-scoped in Settings', () => {
    const state = createState({
      projectId: 'project-1',
      adobeBridge: {
        ...createState().adobeBridge!,
        adobeClients: [
          ...createState().adobeBridge!.adobeClients,
          {
            adobeClientId: 'ps-other-project',
            hostApp: 'photoshop',
            hostVersion: '2026',
            displayName: 'Photoshop 2026 · other.psd',
            documentCount: 1,
            activeDocumentTitle: 'other.psd',
            connectedAt: '2026-06-18T00:00:00.000Z',
            lastSeenAt: '2026-06-18T00:00:01.000Z'
          }
        ],
        links: [
          ...createState().adobeBridge!.links,
          {
            linkId: 'link-other-project',
            projectId: 'project-2',
            adobeClientId: 'ps-other-project',
            createdAt: '2026-06-18T00:00:01.000Z',
            status: 'active'
          }
        ]
      }
    });

    expect(isPhotoshopLinkedToCurrentProject(state.adobeBridge, state.projectId, 'ps-1')).toBe(true);
    expect(isPhotoshopLinkedToCurrentProject(state.adobeBridge, state.projectId, 'ps-other-project')).toBe(false);
  });
});

function createState(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    snapshot: undefined,
    projectId: 'project-1',
    explorerSelection: { selectedPaths: [], focusedPath: null, anchorPath: null },
    llmSettings: { providers: [], availableModelKeys: [], defaultModelKey: null },
    imageModelSettings: { models: [] },
    videoModelSettings: { models: [] },
    integrationsSettings: { integrations: [], backends: [] },
    adobeBridge: {
      settings: { enabled: true, discoveryStatus: 'available' },
      adobeClients: [{
        adobeClientId: 'ps-1',
        hostApp: 'photoshop',
        hostVersion: '2026',
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
        connectedWorkbenchClientCount: 1,
        directories: [{ projectRelativePath: 'assets', name: 'assets', depth: 1 }]
      }],
      links: [{
        linkId: 'link-1',
        projectId: 'project-1',
        adobeClientId: 'ps-1',
        createdAt: '2026-06-18T00:00:01.000Z',
        status: 'active'
      }],
      transfers: []
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
    saveAdobeBridgeSettings: async () => undefined,
    linkAdobeBridgePhotoshop: async () => undefined,
    unlinkAdobeBridgePhotoshop: async () => undefined
  } as unknown as WorkbenchActions;
}
