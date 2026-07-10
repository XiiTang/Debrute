// @vitest-environment jsdom

import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdobeBridgeStateView,
  DebruteGlobalSettingsView,
  IntegrationSettingsView,
  RunIntegrationOperationResult,
  WorkbenchApiClient,
  WorkbenchLocale
} from '@debrute/app-protocol';
import {
  useWorkbenchSettingsController,
  type WorkbenchSettingsController
} from './useWorkbenchSettingsController';

const globalWithAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
  previousActEnvironment = globalWithAct.IS_REACT_ACT_ENVIRONMENT;
  globalWithAct.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (previousActEnvironment === undefined) {
    delete globalWithAct.IS_REACT_ACT_ENVIRONMENT;
  } else {
    globalWithAct.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

describe('useWorkbenchSettingsController', () => {
  it('loads global settings and Adobe Bridge state as explicit resources', async () => {
    const api = apiFixture();
    const probe = await renderController(api);

    expect(probe.current.globalSettings.status).toBe('ready');
    expect(probe.current.adobeBridge.status).toBe('ready');
    expect(api.globalSettingsGet).toHaveBeenCalledTimes(1);
    expect(api.adobeBridgeGetState).toHaveBeenCalledTimes(1);
    await probe.unmount();
  });

  it('applies a newer settings event and ignores an older save result', async () => {
    const save = deferred<DebruteGlobalSettingsView>();
    const api = apiFixture({ globalSettingsSave: vi.fn(() => save.promise) });
    const probe = await renderController(api);

    let pending!: Promise<void>;
    await act(async () => {
      pending = probe.current.actions.saveGlobalSettings({ workbench: { defaultFrontend: 'browser' } });
      probe.current.applyEvent({
        type: 'globalSettings.changed',
        settings: settingsFixture({ locale: 'zh-CN', themePreference: 'light', defaultFrontend: 'runtime-only' })
      });
      save.resolve(settingsFixture({ locale: 'en', themePreference: 'dark', defaultFrontend: 'browser' }));
      await pending;
    });

    expect(probe.current.locale).toBe('zh-CN');
    expect(probe.current.resolvedTheme).toBe('light');
    expect(probe.current.globalSettings).toMatchObject({
      status: 'ready',
      value: { workbench: { defaultFrontend: 'runtime-only' } }
    });
    await probe.unmount();
  });

  it('exposes the new locale synchronously after applying a settings event', async () => {
    const probe = await renderController(apiFixture());

    await act(async () => {
      probe.current.applyEvent({
        type: 'globalSettings.changed',
        settings: settingsFixture({ locale: 'zh-CN', themePreference: 'light', defaultFrontend: 'browser' })
      });
      expect(probe.current.getCurrentI18n().locale).toBe('zh-CN');
    });

    await probe.unmount();
  });

  it('keeps a newer Adobe event when an older link response resolves', async () => {
    const link = deferred<AdobeBridgeStateView>();
    const api = apiFixture({ adobeBridgeLinkPhotoshop: vi.fn(() => link.promise) });
    const probe = await renderController(api);
    const eventState = adobeBridgeFixture('Event project');

    let pending!: Promise<void>;
    await act(async () => {
      pending = probe.current.actions.linkAdobeBridgePhotoshop({ adobeClientId: 'photoshop-1' });
      probe.current.applyEvent({ type: 'adobeBridge.state.changed', state: eventState });
      link.resolve(adobeBridgeFixture('Stale link project'));
      await pending;
    });

    expect(probe.current.adobeBridge).toMatchObject({
      status: 'ready',
      value: { projects: [{ projectName: 'Event project' }] }
    });
    await probe.unmount();
  });

  it('suppresses an older Adobe link rejection after a newer linked event', async () => {
    const link = deferred<AdobeBridgeStateView>();
    const api = apiFixture({ adobeBridgeLinkPhotoshop: vi.fn(() => link.promise) });
    const probe = await renderController(api);
    const eventState = linkedAdobeBridgeFixture();

    let pending!: Promise<void>;
    await act(async () => {
      pending = probe.current.actions.linkAdobeBridgePhotoshop({ adobeClientId: 'photoshop-1' });
      probe.current.applyEvent({ type: 'adobeBridge.state.changed', state: eventState });
      link.reject(new Error('stale link failure'));
      await expect(pending).resolves.toBeUndefined();
    });

    expect(probe.current.adobeBridge).toMatchObject({
      status: 'ready',
      value: { links: [{ adobeClientId: 'photoshop-1', status: 'active' }] }
    });
    await probe.unmount();
  });

  it('does not suppress a client rejection when another client starts a link command', async () => {
    const firstLink = deferred<AdobeBridgeStateView>();
    const secondLink = deferred<AdobeBridgeStateView>();
    const api = apiFixture({
      adobeBridgeLinkPhotoshop: vi.fn((linkInput) => (
        linkInput.adobeClientId === 'photoshop-a' ? firstLink.promise : secondLink.promise
      ))
    });
    const probe = await renderController(api);

    const firstPending = probe.current.actions.linkAdobeBridgePhotoshop({ adobeClientId: 'photoshop-a' });
    const secondPending = probe.current.actions.linkAdobeBridgePhotoshop({ adobeClientId: 'photoshop-b' });
    firstLink.reject(new Error('Photoshop A link failed'));

    await expect(firstPending).rejects.toThrow('Photoshop A link failed');
    secondLink.resolve(adobeBridgeFixture('Second client result'));
    await secondPending;
    await probe.unmount();
  });

  it('does not suppress a client rejection after an unrelated Adobe event', async () => {
    const link = deferred<AdobeBridgeStateView>();
    const api = apiFixture({ adobeBridgeLinkPhotoshop: vi.fn(() => link.promise) });
    const probe = await renderController(api);
    const eventState: AdobeBridgeStateView = {
      ...adobeBridgeFixture(),
      settings: { enabled: true, discoveryStatus: 'unavailable' }
    };

    const pending = probe.current.actions.linkAdobeBridgePhotoshop({ adobeClientId: 'photoshop-a' });
    await act(async () => {
      probe.current.applyEvent({ type: 'adobeBridge.state.changed', state: eventState });
      link.reject(new Error('Photoshop A link failed'));
      await expect(pending).rejects.toThrow('Photoshop A link failed');
    });

    expect(probe.current.adobeBridge).toMatchObject({
      status: 'ready',
      value: { settings: { discoveryStatus: 'unavailable' }, links: [] }
    });
    await probe.unmount();
  });

  it('does not confirm a client command when an event links another client', async () => {
    const link = deferred<AdobeBridgeStateView>();
    const api = apiFixture({ adobeBridgeLinkPhotoshop: vi.fn(() => link.promise) });
    const probe = await renderController(api);
    const eventState: AdobeBridgeStateView = {
      ...adobeBridgeFixture(),
      links: [{
        linkId: 'link-b',
        projectId: 'project-1',
        adobeClientId: 'photoshop-b',
        createdAt: '2026-07-10T00:00:00.000Z',
        status: 'active'
      }]
    };

    const pending = probe.current.actions.linkAdobeBridgePhotoshop({ adobeClientId: 'photoshop-a' });
    await act(async () => {
      probe.current.applyEvent({ type: 'adobeBridge.state.changed', state: eventState });
      link.reject(new Error('Photoshop A link failed'));
      await expect(pending).rejects.toThrow('Photoshop A link failed');
    });

    expect(probe.current.adobeBridge).toMatchObject({
      status: 'ready',
      value: { links: [{ adobeClientId: 'photoshop-b', status: 'active' }] }
    });
    await probe.unmount();
  });

  it('does not confirm a command when the same client links another project', async () => {
    const link = deferred<AdobeBridgeStateView>();
    const api = apiFixture({ adobeBridgeLinkPhotoshop: vi.fn(() => link.promise) });
    const probe = await renderController(api, 'project-1');
    const eventState: AdobeBridgeStateView = {
      ...adobeBridgeFixture(),
      links: [{
        linkId: 'link-project-2',
        projectId: 'project-2',
        adobeClientId: 'photoshop-a',
        createdAt: '2026-07-10T00:00:00.000Z',
        status: 'active'
      }]
    };

    const pending = probe.current.actions.linkAdobeBridgePhotoshop({ adobeClientId: 'photoshop-a' });
    await act(async () => {
      probe.current.applyEvent({ type: 'adobeBridge.state.changed', state: eventState });
      link.reject(new Error('Project 1 link failed'));
      await expect(pending).rejects.toThrow('Project 1 link failed');
    });

    expect(probe.current.adobeBridge).toMatchObject({
      status: 'ready',
      value: { links: [{ projectId: 'project-2', adobeClientId: 'photoshop-a', status: 'active' }] }
    });
    await probe.unmount();
  });

  it('suppresses an old project rejection after the controller switches projects', async () => {
    const link = deferred<AdobeBridgeStateView>();
    const api = apiFixture({ adobeBridgeLinkPhotoshop: vi.fn(() => link.promise) });
    const probe = await renderController(api, 'project-1');

    const pending = probe.current.actions.linkAdobeBridgePhotoshop({ adobeClientId: 'photoshop-a' });
    await probe.rerender('project-2');
    link.reject(new Error('Old project link failed'));

    await expect(pending).resolves.toBeUndefined();
    await probe.unmount();
  });

  it('suppresses a rejection replaced by a newer command for the same client', async () => {
    const firstLink = deferred<AdobeBridgeStateView>();
    const secondLink = deferred<AdobeBridgeStateView>();
    const adobeBridgeLinkPhotoshop = vi.fn()
      .mockImplementationOnce(() => firstLink.promise)
      .mockImplementationOnce(() => secondLink.promise);
    const probe = await renderController(apiFixture({ adobeBridgeLinkPhotoshop }));

    const firstPending = probe.current.actions.linkAdobeBridgePhotoshop({ adobeClientId: 'photoshop-a' });
    const secondPending = probe.current.actions.linkAdobeBridgePhotoshop({ adobeClientId: 'photoshop-a' });
    firstLink.reject(new Error('replaced link failure'));
    await expect(firstPending).resolves.toBeUndefined();

    secondLink.resolve(adobeBridgeFixture('Current command result'));
    await secondPending;
    await probe.unmount();
  });

  it('suppresses an unlink rejection after an event removes the original active link', async () => {
    const unlink = deferred<AdobeBridgeStateView>();
    const api = apiFixture({
      adobeBridgeGetState: vi.fn(async () => linkedAdobeBridgeFixture()),
      adobeBridgeUnlinkPhotoshop: vi.fn(() => unlink.promise)
    });
    const probe = await renderController(api);

    let pending!: Promise<void>;
    await act(async () => {
      pending = probe.current.actions.unlinkAdobeBridgePhotoshop('photoshop-1');
      probe.current.applyEvent({ type: 'adobeBridge.state.changed', state: adobeBridgeFixture() });
      unlink.reject(new Error('stale unlink failure'));
      await expect(pending).resolves.toBeUndefined();
    });

    expect(probe.current.adobeBridge).toMatchObject({ status: 'ready', value: { links: [] } });
    await probe.unmount();
  });

  it('keeps a newer settings event when an older integration rescan resolves', async () => {
    const rescan = deferred<IntegrationSettingsView>();
    const api = apiFixture({ integrationsRescan: vi.fn(() => rescan.promise) });
    const probe = await renderController(api);

    let pending!: Promise<IntegrationSettingsView>;
    await act(async () => {
      pending = probe.current.actions.rescanIntegrations();
      probe.current.applyEvent({
        type: 'globalSettings.changed',
        settings: settingsWithIntegrationSummary('Event settings')
      });
      rescan.resolve(integrationSettingsFixture('Stale rescan'));
      await pending;
    });

    expect(readyGlobalSettings(probe).integrations.integrations[0]?.summary).toBe('Event settings');
    await probe.unmount();
  });

  it('keeps a newer settings save when an older integration operation resolves', async () => {
    const operation = deferred<RunIntegrationOperationResult>();
    const save = deferred<DebruteGlobalSettingsView>();
    const api = apiFixture({
      integrationsRunOperation: vi.fn(() => operation.promise),
      globalSettingsSave: vi.fn(() => save.promise)
    });
    const probe = await renderController(api);

    let pendingOperation!: Promise<RunIntegrationOperationResult>;
    let pendingSave!: Promise<void>;
    await act(async () => {
      pendingOperation = probe.current.actions.runIntegrationOperation({
        integrationId: 'ffmpeg',
        operation: 'update'
      });
      pendingSave = probe.current.actions.saveGlobalSettings({ workbench: { defaultFrontend: 'browser' } });
      save.resolve(settingsWithIntegrationSummary('Saved settings'));
      await pendingSave;
      operation.resolve({
        ok: true,
        integrationId: 'ffmpeg',
        operation: 'update',
        settings: integrationSettingsFixture('Stale operation')
      });
      await pendingOperation;
    });

    expect(readyGlobalSettings(probe).integrations.integrations[0]?.summary).toBe('Saved settings');
    await probe.unmount();
  });
});

function ControllerProbe({
  api,
  projectId,
  onValue
}: {
  api: WorkbenchApiClient;
  projectId: string | undefined;
  onValue(value: WorkbenchSettingsController): void;
}): null {
  const controller = useWorkbenchSettingsController({ api, projectId, notify: vi.fn() });
  useEffect(() => onValue(controller), [controller, onValue]);
  return null;
}

async function renderController(api: WorkbenchApiClient, initialProjectId = 'project-1'): Promise<{
  readonly current: WorkbenchSettingsController;
  rerender(projectId: string | undefined): Promise<void>;
  unmount(): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current!: WorkbenchSettingsController;
  const onValue = (value: WorkbenchSettingsController) => { current = value; };
  const render = async (projectId: string | undefined) => {
    await act(async () => {
      root.render(<ControllerProbe api={api} projectId={projectId} onValue={onValue} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  await render(initialProjectId);
  return {
    get current() { return current; },
    rerender: render,
    unmount: () => unmount(root, container)
  };
}

function apiFixture(overrides: Partial<WorkbenchApiClient> = {}): WorkbenchApiClient {
  return {
    globalSettingsGet: vi.fn(async () => settingsFixture()),
    globalSettingsSave: vi.fn(async () => settingsFixture()),
    adobeBridgeGetState: vi.fn(async () => adobeBridgeFixture()),
    getProductState: vi.fn(),
    checkProductUpdate: vi.fn(),
    applyProductUpdate: vi.fn(),
    integrationsRescan: vi.fn(async () => ({ integrations: [], backends: [] })),
    integrationsRunOperation: vi.fn(),
    adobeBridgeLinkPhotoshop: vi.fn(async () => adobeBridgeFixture()),
    adobeBridgeUnlinkPhotoshop: vi.fn(async () => adobeBridgeFixture()),
    ...overrides
  } as unknown as WorkbenchApiClient;
}

function settingsFixture(workbench: {
  locale: WorkbenchLocale;
  themePreference: 'system' | 'dark' | 'light';
  defaultFrontend: 'electron' | 'browser' | 'runtime-only';
} = {
  locale: 'en',
  themePreference: 'dark',
  defaultFrontend: 'electron'
}): DebruteGlobalSettingsView {
  return {
    workbench,
    chrome: { recentProjectRoots: [] },
    models: { image: { models: [] }, video: { models: [] }, audio: { models: [] } },
    integrations: { integrations: [], backends: [] },
    adobeBridge: { enabled: true }
  };
}

function adobeBridgeFixture(projectName?: string): AdobeBridgeStateView {
  return {
    settings: { enabled: true, discoveryStatus: 'available' },
    adobeClients: [],
    projects: projectName ? [{
      projectId: projectName.toLowerCase().replaceAll(' ', '-'),
      projectName,
      projectRevision: 1,
      connectedWorkbenchClientCount: 1,
      directories: []
    }] : [],
    links: [],
    transfers: []
  };
}

function linkedAdobeBridgeFixture(): AdobeBridgeStateView {
  return {
    ...adobeBridgeFixture(),
    links: [{
      linkId: 'link-1',
      projectId: 'project-1',
      adobeClientId: 'photoshop-1',
      createdAt: '2026-07-10T00:00:00.000Z',
      status: 'active'
    }]
  };
}

function settingsWithIntegrationSummary(summary: string): DebruteGlobalSettingsView {
  return {
    ...settingsFixture(),
    integrations: integrationSettingsFixture(summary)
  };
}

function integrationSettingsFixture(summary: string): IntegrationSettingsView {
  return {
    backends: [],
    integrations: [{
      integrationId: 'ffmpeg',
      displayName: 'FFmpeg',
      description: 'Video and audio processing toolkit.',
      category: 'media',
      status: 'ready',
      summary,
      binaries: []
    }]
  };
}

function readyGlobalSettings(probe: { readonly current: WorkbenchSettingsController }): DebruteGlobalSettingsView {
  if (probe.current.globalSettings.status !== 'ready') {
    throw new Error(`Expected ready global settings, got ${probe.current.globalSettings.status}.`);
  }
  return probe.current.globalSettings.value;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function unmount(root: Root, container: HTMLDivElement): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}
