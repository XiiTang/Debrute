// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AdobeBridgeStateView,
  unavailableWorkbenchTitleBarState,
  type WorkbenchApiClient,
  type WorkbenchEvent,
  type WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';

const apiState = vi.hoisted(() => ({
  api: undefined as WorkbenchApiClient | undefined,
  listeners: new Set<(event: WorkbenchEvent) => void>()
}));
const globalWithActFlag = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;
let hadPreviousActEnvironment = false;

vi.mock('./api/workbenchApiClient', () => ({
  createWorkbenchApiClient: () => {
    if (!apiState.api) {
      throw new Error('WorkbenchApp test API was not configured.');
    }
    return apiState.api;
  }
}));

describe('WorkbenchApp global preference events', () => {
  beforeEach(() => {
    vi.resetModules();
    apiState.listeners.clear();
    hadPreviousActEnvironment = 'IS_REACT_ACT_ENVIRONMENT' in globalWithActFlag;
    previousActEnvironment = globalWithActFlag.IS_REACT_ACT_ENVIRONMENT;
    globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = true;
    document.documentElement.removeAttribute('data-theme');
    document.body.innerHTML = '';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    apiState.listeners.clear();
    apiState.api = undefined;
    document.documentElement.removeAttribute('data-theme');
    if (hadPreviousActEnvironment && previousActEnvironment !== undefined) {
      globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    } else {
      delete globalWithActFlag.IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it('applies global preference events on the project-open surface', async () => {
    const { container, root } = await renderWorkbenchApp('/');

    expect(container.textContent).toContain('Open Project');

    await act(async () => {
      emitWorkbenchEvent({
        type: 'workbench.preferences.changed',
        preferences: { locale: 'zh-CN', themePreference: 'light' }
      });
    });

    expect(container.textContent).toContain('打开项目');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await unmount(root, container);
  });

  it('disables the Terminal panel before a project is open', async () => {
    const { container, root } = await renderWorkbenchApp('/');

    expect(requireButton(container, 'Terminal').disabled).toBe(true);

    await unmount(root, container);
  });

  it('loads global model settings before a project is open', async () => {
    const { container, root } = await renderWorkbenchApp('/');

    const settingsButton = requireButton(container, 'Settings');
    await act(async () => {
      settingsButton.click();
      await Promise.resolve();
    });

    const imageModelsButton = requireButton(container, 'Image Models');
    await act(async () => {
      imageModelsButton.click();
      await Promise.resolve();
    });

    expect(apiState.api!.openProject).not.toHaveBeenCalled();
    expect(apiState.api!.imageModelGetSettings).toHaveBeenCalled();
    expect(apiState.api!.videoModelGetSettings).toHaveBeenCalled();
    expect(apiState.api!.audioModelGetSettings).toHaveBeenCalled();
    expect(container.querySelector('.settings-page')?.textContent).toContain('image/openai/gpt-image-1');

    await unmount(root, container);
  });

  it('renders model settings load errors with retry before a project is open', async () => {
    const imageModelGetSettings = vi.fn()
      .mockRejectedValueOnce(new Error('Secrets config imageModelApiKeys values must be strings.'))
      .mockResolvedValueOnce(imageSettingsFixture());
    const { container, root } = await renderWorkbenchApp('/', {
      imageModelGetSettings
    } as Partial<WorkbenchApiClient>);

    const settingsButton = requireButton(container, 'Settings');
    await act(async () => {
      settingsButton.click();
      await Promise.resolve();
    });

    await act(async () => {
      requireButton(container, 'Image Models').click();
      await Promise.resolve();
    });

    expect(container.querySelector('.settings-page')?.textContent).toContain('Failed to load settings: Secrets config imageModelApiKeys values must be strings.');
    expect(container.querySelector('.settings-page')?.textContent).not.toContain('image/openai/gpt-image-1');

    await act(async () => {
      requireButton(container, 'Retry').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(imageModelGetSettings).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.settings-page')?.textContent).toContain('image/openai/gpt-image-1');

    await unmount(root, container);
  });

  it('applies global preference events after a project is open', async () => {
    const { container, root } = await renderWorkbenchApp('/projects/project-1');

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiState.api!.openProject).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(apiState.api!.imageModelGetSettings).toHaveBeenCalledTimes(1);
    expect(apiState.api!.videoModelGetSettings).toHaveBeenCalledTimes(1);
    expect(apiState.api!.audioModelGetSettings).toHaveBeenCalledTimes(1);
    expect(apiState.api!.integrationsListStatus).toHaveBeenCalledTimes(1);
    expect(apiState.api!.adobeBridgeGetState).toHaveBeenCalledTimes(2);

    await act(async () => {
      emitWorkbenchEvent({
        type: 'workbench.preferences.changed',
        preferences: { locale: 'zh-CN', themePreference: 'light' }
      });
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await unmount(root, container);
  });

  it('ignores stale Adobe Bridge startup failures after project state reloads', async () => {
    const staleStartupBridge = deferred<AdobeBridgeStateView>();
    const adobeBridgeGetState = vi.fn()
      .mockImplementationOnce(() => staleStartupBridge.promise)
      .mockResolvedValueOnce(adobeBridgeStateFixture({
        adobeClients: [{
          adobeClientId: 'photoshop-1',
          hostApp: 'photoshop',
          hostVersion: '2026',
          displayName: 'Photoshop Ready',
          documentCount: 1,
          activeDocumentTitle: 'Demo.psd',
          connectedAt: '2026-07-08T00:00:00.000Z',
          lastSeenAt: '2026-07-08T00:00:01.000Z'
        }]
      }));
    const { container, root } = await renderWorkbenchApp('/projects/project-1', {
      adobeBridgeGetState
    } as Partial<WorkbenchApiClient>);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(adobeBridgeGetState).toHaveBeenCalledTimes(2);

    await act(async () => {
      requireButton(container, 'Settings').click();
      await Promise.resolve();
    });
    await act(async () => {
      requireButton(container, 'Adobe Bridge').click();
      await Promise.resolve();
    });

    expect(container.querySelector('.settings-page')?.textContent).toContain('Photoshop Ready');

    await act(async () => {
      staleStartupBridge.reject(new Error('stale bridge failure'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.settings-page')?.textContent).not.toContain('Failed to load settings');
    expect(container.querySelector('.settings-page')?.textContent).toContain('Photoshop Ready');

    await unmount(root, container);
  });
});

async function renderWorkbenchApp(
  pathname: string,
  apiOverrides: Partial<WorkbenchApiClient> = {}
): Promise<{ container: HTMLDivElement; root: Root }> {
  window.history.replaceState({ preserved: true }, '', pathname);
  apiState.api = apiFixture(apiOverrides);
  const { WorkbenchApp } = await import('./WorkbenchApp');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<WorkbenchApp />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

async function unmount(root: Root, container: HTMLDivElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function emitWorkbenchEvent(event: WorkbenchEvent): void {
  for (const listener of apiState.listeners) {
    listener(event);
  }
}

function requireButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes(label) || candidate.getAttribute('aria-label') === label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${label} button.`);
  }
  return button;
}

function apiFixture(overrides: Partial<WorkbenchApiClient> = {}): WorkbenchApiClient {
  return {
    mode: 'web',
    clientId: 'test-client',
    workbenchPreferencesGet: vi.fn(async () => ({ locale: 'en', themePreference: 'dark' })),
    workbenchPreferencesSave: vi.fn(async (preferences) => preferences),
    onEvent: vi.fn((listener: (event: WorkbenchEvent) => void) => {
      apiState.listeners.add(listener);
      return () => apiState.listeners.delete(listener);
    }),
    getProductState: vi.fn(async () => ({
      productVersion: 'test',
      platform: 'darwin',
      cli: { status: 'ready', version: 'test', path: '/tmp/debrute', skillsVersion: 'test' },
      update: { type: 'idle', currentVersion: 'test', updateAvailable: false }
    })),
    checkProductUpdate: vi.fn(async () => ({
      productVersion: 'test',
      platform: 'darwin',
      cli: { status: 'ready', version: 'test', path: '/tmp/debrute', skillsVersion: 'test' },
      update: { type: 'idle', currentVersion: 'test', updateAvailable: false }
    })),
    applyProductUpdate: vi.fn(async () => ({
      applied: false,
      state: {
        productVersion: 'test',
        platform: 'darwin',
        cli: { status: 'ready', version: 'test', path: '/tmp/debrute', skillsVersion: 'test' },
        update: { type: 'idle', currentVersion: 'test', updateAvailable: false }
      }
    })),
    getDesktopPlatform: vi.fn(async () => 'darwin'),
    getWorkbenchTitleBarState: vi.fn(async () => unavailableWorkbenchTitleBarState()),
    integrationsListStatus: vi.fn(async () => ({ integrations: [], backends: [] })),
    integrationsRescan: vi.fn(async () => ({ integrations: [], backends: [] })),
    integrationsRunOperation: vi.fn(async () => ({
      ok: true,
      integrationId: 'imagemagick',
      operation: 'install',
      settings: { integrations: [], backends: [] }
    })),
    adobeBridgeGetState: vi.fn(async () => adobeBridgeStateFixture()),
    imageModelGetSettings: vi.fn(async () => imageSettingsFixture()),
    videoModelGetSettings: vi.fn(async () => ({ models: [] })),
    audioModelGetSettings: vi.fn(async () => ({ models: [] })),
    openProject: vi.fn(async () => ({
      projectId: 'project-1',
      projectRevision: 1,
      snapshot: snapshotFixture()
    })),
    openProjectFromPicker: vi.fn(async () => ({ opened: false })),
    readCanvasFeedback: vi.fn(async () => ({ entries: {} })),
    clearRecentProjectRoots: vi.fn(async () => ({ ok: true })),
    listTerminalSessions: vi.fn(async () => ({ sessions: [] })),
    ...overrides
  } as unknown as WorkbenchApiClient;
}

function imageSettingsFixture() {
  return {
    models: [{
      debruteModelId: 'image/openai/gpt-image-1',
      summary: 'OpenAI image generation.',
      supportsEditing: true,
      supportsTextRendering: true,
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultRequestModelId: 'gpt-image-1',
      baseUrlOverride: null,
      requestModelIdOverride: null,
      apiKeySet: false,
      apiKeyPreview: null
    }]
  };
}

function adobeBridgeStateFixture(overrides: Partial<AdobeBridgeStateView> = {}): AdobeBridgeStateView {
  return {
    settings: { enabled: true, discoveryStatus: 'available' },
    adobeClients: [],
    projects: [],
    links: [],
    transfers: [],
    ...overrides
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function snapshotFixture(): WorkbenchProjectSessionSnapshot {
  return {
    metadata: {
      project: {
        id: 'project-1',
        name: 'Demo',
        createdAt: '2026-06-28T00:00:00.000Z',
        updatedAt: '2026-06-28T00:00:00.000Z'
      }
    },
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
    health: {
      projectName: 'Demo',
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0, infos: 0 },
      runtimeDataLocation: 'project',
      checkedAt: '2026-06-28T00:00:00.000Z'
    },
    canvasRegistry: { status: 'ready', canvasOrder: [] }
  };
}
