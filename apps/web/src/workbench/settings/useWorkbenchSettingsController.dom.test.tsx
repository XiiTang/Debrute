import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
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

describe('useWorkbenchSettingsController', { tags: ['settings'] }, () => {
  it('starts from the bootstrapped Global settings without probing Adobe Bridge', async () => {
    const api = apiFixture();
    const initialSettings = settingsFixture({
      locale: 'zh-CN',
      themePreference: 'light',
      defaultFrontend: 'browser'
    });
    const probe = await renderController(api, 'project-1', initialSettings);

    expect(probe.current.globalSettings).toEqual({ status: 'ready', value: initialSettings });
    expect(probe.current.locale).toBe('zh-CN');
    expect(probe.current.resolvedTheme).toBe('light');
    expect(probe.current.adobeBridge.status).toBe('loading');
    expect(api.adobeBridgeGetState).not.toHaveBeenCalled();
    await act(async () => {
      probe.current.applyEvent({ type: 'adobeBridge.state.changed', state: adobeBridgeFixture() });
    });

    expect(probe.current.adobeBridge.status).toBe('ready');
    await probe.unmount();
  });

  it('turns an initial Adobe Bridge resource failure into retryable error state', async () => {
    const probe = await renderController(apiFixture());

    await act(async () => {
      probe.current.applyEvent({
        type: 'adobeBridge.state.failed',
        error: { code: 'adobe_bridge_state_invalid', message: 'bridge state unavailable' }
      });
    });

    expect(probe.current.adobeBridge).toEqual({
      status: 'error',
      message: 'bridge state unavailable'
    });
    await probe.unmount();
  });

  it('keeps command acknowledgement separate from the settings event', async () => {
    const save = deferred<{ ok: true }>();
    const api = apiFixture({ globalSettingsSave: vi.fn(() => save.promise) });
    const probe = await renderController(api);

    let pending!: Promise<void>;
    await act(async () => {
      pending = probe.current.actions.saveGlobalSettings({ workbench: { defaultFrontend: 'browser' } });
      probe.current.applyEvent({
        type: 'globalSettings.changed',
        settings: settingsFixture({ locale: 'zh-CN', themePreference: 'light', defaultFrontend: 'runtime-only' })
      });
      save.resolve({ ok: true });
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

  it('applies Canvas text appearance immediately and coalesces unsent complete values', async () => {
    const firstSave = deferred<{ ok: true }>();
    const latestSave = deferred<{ ok: true }>();
    const globalSettingsSave = vi.fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => latestSave.promise);
    const probe = await renderController(apiFixture({ globalSettingsSave }));
    await act(async () => {
      probe.current.applyEvent({ type: 'globalSettings.changed', settings: settingsFixture() });
    });

    const first = {
      ...settingsFixture().canvas.textAppearance,
      fontSizePx: 13
    };
    const superseded = { ...first, fontSizePx: 14 };
    const latest = { ...first, fontSizePx: 15 };
    let firstPending!: Promise<void>;
    let supersededPending!: Promise<void>;
    let latestPending!: Promise<void>;
    await act(async () => {
      firstPending = probe.current.actions.saveGlobalSettings({ canvas: { textAppearance: first } });
      supersededPending = probe.current.actions.saveGlobalSettings({ canvas: { textAppearance: superseded } });
      latestPending = probe.current.actions.saveGlobalSettings({ canvas: { textAppearance: latest } });
    });

    expect(readyGlobalSettings(probe).canvas.textAppearance).toEqual(latest);
    expect(globalSettingsSave).toHaveBeenCalledTimes(1);
    expect(globalSettingsSave).toHaveBeenNthCalledWith(1, { canvas: { textAppearance: first } });

    await act(async () => {
      probe.current.applyEvent({
        type: 'globalSettings.changed',
        settings: { ...settingsFixture(), canvas: { textAppearance: first } }
      });
      firstSave.resolve({ ok: true });
      await firstPending;
    });
    expect(globalSettingsSave).toHaveBeenCalledTimes(2);
    expect(globalSettingsSave).toHaveBeenNthCalledWith(2, { canvas: { textAppearance: latest } });

    await act(async () => {
      probe.current.applyEvent({
        type: 'globalSettings.changed',
        settings: { ...settingsFixture(), canvas: { textAppearance: latest } }
      });
      latestSave.resolve({ ok: true });
      await Promise.all([supersededPending, latestPending]);
    });
    expect(readyGlobalSettings(probe).canvas.textAppearance).toEqual(latest);
    await probe.unmount();
  });

  it('returns Canvas text appearance to the latest Runtime-confirmed value after save failure', async () => {
    const save = deferred<{ ok: true }>();
    const probe = await renderController(apiFixture({
      globalSettingsSave: vi.fn(() => save.promise)
    }));
    const confirmed = settingsFixture();
    await act(async () => {
      probe.current.applyEvent({ type: 'globalSettings.changed', settings: confirmed });
    });
    const changed = { ...confirmed.canvas.textAppearance, fontWeight: 600 };
    let pending!: Promise<void>;
    await act(async () => {
      pending = probe.current.actions.saveGlobalSettings({ canvas: { textAppearance: changed } });
    });
    expect(readyGlobalSettings(probe).canvas.textAppearance).toEqual(changed);

    await act(async () => {
      save.reject(new Error('settings unavailable'));
      await expect(pending).rejects.toThrow('settings unavailable');
    });
    expect(readyGlobalSettings(probe).canvas.textAppearance).toEqual(
      confirmed.canvas.textAppearance
    );
    await probe.unmount();
  });

  it('returns the exact API key from the explicit reveal command', async () => {
    const revealModelApiKey = vi.fn(async () => ({ apiKey: '  密钥🔑  ' }));
    const probe = await renderController(apiFixture({ revealModelApiKey }));

    await expect(
      probe.current.actions.revealModelApiKey('image/openai/gpt-image-1')
    ).resolves.toBe('  密钥🔑  ');
    expect(revealModelApiKey).toHaveBeenCalledWith('image/openai/gpt-image-1');

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
      pending = probe.current.actions.linkAdobeBridgePhotoshop({ pluginInstanceId: 'photoshop-1' });
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
      pending = probe.current.actions.linkAdobeBridgePhotoshop({ pluginInstanceId: 'photoshop-1' });
      probe.current.applyEvent({ type: 'adobeBridge.state.changed', state: eventState });
      link.reject(new Error('stale link failure'));
      await expect(pending).resolves.toBeUndefined();
    });

    expect(probe.current.adobeBridge).toMatchObject({
      status: 'ready',
      value: { links: [{ pluginInstanceId: 'photoshop-1', status: 'active' }] }
    });
    await probe.unmount();
  });

  it('does not suppress a client rejection when another client starts a link command', async () => {
    const firstLink = deferred<AdobeBridgeStateView>();
    const secondLink = deferred<AdobeBridgeStateView>();
    const api = apiFixture({
      adobeBridgeLinkPhotoshop: vi.fn((linkInput) => (
        linkInput.pluginInstanceId === 'photoshop-a' ? firstLink.promise : secondLink.promise
      ))
    });
    const probe = await renderController(api);

    await act(async () => {
      const firstPending = probe.current.actions.linkAdobeBridgePhotoshop({ pluginInstanceId: 'photoshop-a' });
      const secondPending = probe.current.actions.linkAdobeBridgePhotoshop({ pluginInstanceId: 'photoshop-b' });
      firstLink.reject(new Error('Photoshop A link failed'));
      await expect(firstPending).rejects.toThrow('Photoshop A link failed');
      secondLink.resolve(adobeBridgeFixture('Second client result'));
      await secondPending;
    });
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

    const pending = probe.current.actions.linkAdobeBridgePhotoshop({ pluginInstanceId: 'photoshop-a' });
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
        pluginInstanceId: 'photoshop-b',
        createdAt: '2026-07-10T00:00:00.000Z',
        status: 'active'
      }]
    };

    const pending = probe.current.actions.linkAdobeBridgePhotoshop({ pluginInstanceId: 'photoshop-a' });
    await act(async () => {
      probe.current.applyEvent({ type: 'adobeBridge.state.changed', state: eventState });
      link.reject(new Error('Photoshop A link failed'));
      await expect(pending).rejects.toThrow('Photoshop A link failed');
    });

    expect(probe.current.adobeBridge).toMatchObject({
      status: 'ready',
      value: { links: [{ pluginInstanceId: 'photoshop-b', status: 'active' }] }
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
        pluginInstanceId: 'photoshop-a',
        createdAt: '2026-07-10T00:00:00.000Z',
        status: 'active'
      }]
    };

    const pending = probe.current.actions.linkAdobeBridgePhotoshop({ pluginInstanceId: 'photoshop-a' });
    await act(async () => {
      probe.current.applyEvent({ type: 'adobeBridge.state.changed', state: eventState });
      link.reject(new Error('Project 1 link failed'));
      await expect(pending).rejects.toThrow('Project 1 link failed');
    });

    expect(probe.current.adobeBridge).toMatchObject({
      status: 'ready',
      value: { links: [{ projectId: 'project-2', pluginInstanceId: 'photoshop-a', status: 'active' }] }
    });
    await probe.unmount();
  });

  it('suppresses an old project rejection after the controller switches projects', async () => {
    const link = deferred<AdobeBridgeStateView>();
    const api = apiFixture({ adobeBridgeLinkPhotoshop: vi.fn(() => link.promise) });
    const probe = await renderController(api, 'project-1');

    const pending = probe.current.actions.linkAdobeBridgePhotoshop({ pluginInstanceId: 'photoshop-a' });
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

    await act(async () => {
      const firstPending = probe.current.actions.linkAdobeBridgePhotoshop({ pluginInstanceId: 'photoshop-a' });
      const secondPending = probe.current.actions.linkAdobeBridgePhotoshop({ pluginInstanceId: 'photoshop-a' });
      firstLink.reject(new Error('replaced link failure'));
      await expect(firstPending).resolves.toBeUndefined();
      secondLink.resolve(adobeBridgeFixture('Current command result'));
      await secondPending;
    });
    await probe.unmount();
  });

  it('suppresses an unlink rejection after an event removes the original active link', async () => {
    const unlink = deferred<AdobeBridgeStateView>();
    const api = apiFixture({
      adobeBridgeUnlinkPhotoshop: vi.fn(() => unlink.promise)
    });
    const probe = await renderController(api);
    await act(async () => {
      probe.current.applyEvent({ type: 'adobeBridge.state.changed', state: linkedAdobeBridgeFixture() });
    });

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

  it('applies integration state only from an integrations event', async () => {
    const rescan = deferred<{ ok: true }>();
    const api = apiFixture({ integrationsRescan: vi.fn(() => rescan.promise) });
    const probe = await renderController(api);
    await act(async () => {
      probe.current.applyEvent({
        type: 'integrations.changed',
        integrations: integrationSettingsFixture('Initial settings')
      });
    });

    let pending!: Promise<void>;
    await act(async () => {
      pending = probe.current.actions.rescanIntegrations();
      probe.current.applyEvent({
        type: 'integrations.changed',
        integrations: integrationSettingsFixture('Event settings')
      });
      rescan.resolve({ ok: true });
      await pending;
    });

    expect(readyIntegrations(probe).integrations[0]?.summary).toBe('Event settings');
    await probe.unmount();
  });

  it('keeps integration operation diagnostics separate from event-owned state', async () => {
    const operation = deferred<RunIntegrationOperationResult>();
    const api = apiFixture({
      integrationsRunOperation: vi.fn(() => operation.promise)
    });
    const probe = await renderController(api);
    await act(async () => {
      probe.current.applyEvent({
        type: 'integrations.changed',
        integrations: integrationSettingsFixture('Initial settings')
      });
    });

    let pendingOperation!: Promise<RunIntegrationOperationResult>;
    await act(async () => {
      pendingOperation = probe.current.actions.runIntegrationOperation({
        integrationId: 'ffmpeg',
        operation: 'update'
      });
      probe.current.applyEvent({
        type: 'integrations.changed',
        integrations: integrationSettingsFixture('Settled event')
      });
      operation.resolve({
        ok: true,
        integrationId: 'ffmpeg',
        operation: 'update'
      });
      await pendingOperation;
    });

    expect(readyIntegrations(probe).integrations[0]?.summary).toBe('Settled event');
    await probe.unmount();
  });
});

function ControllerProbe({
  api,
  initialGlobalSettings,
  projectId,
  onValue
}: {
  api: WorkbenchApiClient;
  initialGlobalSettings: DebruteGlobalSettingsView;
  projectId: string | undefined;
  onValue(value: WorkbenchSettingsController): void;
}): null {
  const controller = useWorkbenchSettingsController({
    api,
    initialGlobalSettings,
    projectId,
    notify: vi.fn()
  });
  useEffect(() => onValue(controller), [controller, onValue]);
  return null;
}

async function renderController(
  api: WorkbenchApiClient,
  initialProjectId = 'project-1',
  initialGlobalSettings = settingsFixture()
): Promise<{
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
      root.render(
        <ControllerProbe
          api={api}
          initialGlobalSettings={initialGlobalSettings}
          projectId={projectId}
          onValue={onValue}
        />
      );
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
    globalSettingsSave: vi.fn(async () => ({ ok: true as const })),
    adobeBridgeGetState: vi.fn(async () => adobeBridgeFixture()),
    checkProductUpdate: vi.fn(async () => ({ ok: true as const })),
    applyProductUpdate: vi.fn(async () => ({ ok: true as const })),
    integrationsRescan: vi.fn(async () => ({ ok: true as const })),
    integrationsRunOperation: vi.fn(),
    adobeBridgeLinkPhotoshop: vi.fn(async () => adobeBridgeFixture()),
    adobeBridgeUnlinkPhotoshop: vi.fn(async () => adobeBridgeFixture()),
    ...overrides
  } as unknown as WorkbenchApiClient;
}

function settingsFixture(workbench: {
  locale: WorkbenchLocale;
  themePreference: 'system' | 'dark' | 'light';
  defaultFrontend: 'desktop' | 'browser' | 'runtime-only';
} = {
  locale: 'en',
  themePreference: 'dark',
  defaultFrontend: 'desktop'
}): DebruteGlobalSettingsView {
  return {
    workbench,
    canvas: {
      textAppearance: {
        fontId: 'noto-sans-mono-cjk-sc',
        fontSizePx: 12,
        lineHeightRatio: 1.4,
        fontWeight: 400,
        letterSpacingPx: 0,
        ligatures: true
      }
    },
    chrome: { recentProjects: [] },
    models: { image: [], video: [], audio: [] },
    adobeBridge: { enabled: true }
  };
}

function adobeBridgeFixture(projectName?: string): AdobeBridgeStateView {
  return {
    settings: { enabled: true, discoveryStatus: 'available' },
    pairedPlugins: [],
    clients: [],
    projects: projectName ? [{
      projectId: projectName.toLowerCase().replaceAll(' ', '-'),
      projectName,
      projectRevision: 1,
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
      pluginInstanceId: 'photoshop-1',
      createdAt: '2026-07-10T00:00:00.000Z',
      status: 'active'
    }]
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

function readyIntegrations(probe: { readonly current: WorkbenchSettingsController }): IntegrationSettingsView {
  if (probe.current.integrations.status !== 'ready') {
    throw new Error(`Expected ready integrations, got ${probe.current.integrations.status}.`);
  }
  return probe.current.integrations.value;
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
