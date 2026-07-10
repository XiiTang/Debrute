// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkbenchTitleBarState,
  type AdobeBridgeStateView,
  type DebruteGlobalSettingsView,
  type ImageModelSettingsView,
  unavailableWorkbenchTitleBarState,
  type WorkbenchApiClient,
  type WorkbenchEvent,
  type WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import {
  createCanvasEditorRuntime,
  type CanvasEditorRuntime
} from './canvas/runtime/CanvasEditorRuntime';

const apiState = vi.hoisted(() => ({
  api: undefined as WorkbenchApiClient | undefined,
  listeners: new Set<(event: WorkbenchEvent) => void>()
}));
const canvasRuntimeState = vi.hoisted(() => ({
  runtime: undefined as CanvasEditorRuntime | undefined
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
    window.sessionStorage.clear();
    delete window.debruteShell;
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
    vi.doUnmock('./canvas/CanvasEditor');
    apiState.listeners.clear();
    apiState.api = undefined;
    canvasRuntimeState.runtime?.dispose();
    canvasRuntimeState.runtime = undefined;
    document.documentElement.removeAttribute('data-theme');
    delete window.debruteShell;
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
        type: 'globalSettings.changed',
        settings: globalSettingsFixture({
          workbench: { locale: 'zh-CN', themePreference: 'light', defaultFrontend: 'browser' }
        })
      });
    });

    expect(container.textContent).toContain('打开项目');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(apiState.api!.onEvent).toHaveBeenCalledTimes(1);

    await unmount(root, container);
  });

  it('disables the Terminal panel before a project is open', async () => {
    const { container, root } = await renderWorkbenchApp('/');

    expect(requireButton(container, 'Terminal').disabled).toBe(true);

    await unmount(root, container);
  });

  it('reports native window state failures and leaves only maximize unavailable', async () => {
    window.debruteShell = {
      getNativeWindowState: vi.fn().mockRejectedValue(new Error('native state unavailable'))
    };
    const { container, root } = await renderWorkbenchApp('/', {
      getWorkbenchTitleBarState: vi.fn(async () => buildWorkbenchTitleBarState({
        platform: 'win32',
        host: 'desktop',
        recentProjectRoots: []
      }))
    });

    expect(container.textContent).toContain('Window state failed: native state unavailable');
    expect(requireButton(container, 'Minimize window').disabled).toBe(false);
    expect(requireButton(container, 'Maximize window').disabled).toBe(true);
    expect(requireButton(container, 'Close window').disabled).toBe(false);

    await unmount(root, container);
  });

  it('loads global model settings before a project is open', async () => {
    const { container, root } = await renderWorkbenchApp('/');

    const settingsButton = requireButton(container, 'Settings');
    await act(async () => {
      settingsButton.click();
      await Promise.resolve();
    });

    expect(container.querySelectorAll('.settings-directory-group')).toHaveLength(3);
    expect(container.querySelector('.settings-page')?.querySelectorAll('h2')).toHaveLength(1);

    const imageModelsButton = requireButton(container, 'Image Models');
    await act(async () => {
      imageModelsButton.click();
      await Promise.resolve();
    });

    expect(apiState.api!.openProject).not.toHaveBeenCalled();
    expect(apiState.api!.globalSettingsGet).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.settings-page')?.textContent).toContain('image/openai/gpt-image-1');

    await unmount(root, container);
  });

  it('renders model settings load errors with retry before a project is open', async () => {
    const globalSettingsGet = vi.fn()
      .mockRejectedValueOnce(new Error('Secrets config imageModelApiKeys values must be strings.'))
      .mockResolvedValueOnce(globalSettingsFixture());
    const { container, root } = await renderWorkbenchApp('/', {
      globalSettingsGet
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

    expect(globalSettingsGet).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.settings-page')?.textContent).toContain('image/openai/gpt-image-1');

    await unmount(root, container);
  });

  it('loads Adobe live state once when the initial route opens a project', async () => {
    const adobeBridgeGetState = vi.fn(async () => adobeBridgeStateFixture());
    const { container, root } = await renderWorkbenchApp('/projects/project-1', { adobeBridgeGetState });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiState.api!.openProject).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(apiState.api!.globalSettingsGet).toHaveBeenCalledTimes(1);
    expect(adobeBridgeGetState).toHaveBeenCalledTimes(1);

    await unmount(root, container);
  });

  it('keeps one Workbench event subscription when the initial project opens', async () => {
    const { container, root } = await renderWorkbenchApp('/projects/project-1');

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiState.api!.openProject).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(apiState.api!.onEvent).toHaveBeenCalledTimes(1);
    expect(apiState.listeners.size).toBe(1);

    await unmount(root, container);
    expect(apiState.listeners.size).toBe(0);
  });

  it('loads title-bar state once for the opened project', async () => {
    const getWorkbenchTitleBarState = vi.fn(async (_input: Parameters<WorkbenchApiClient['getWorkbenchTitleBarState']>[0]) => unavailableWorkbenchTitleBarState());
    const { container, root } = await renderWorkbenchApp('/projects/project-1', { getWorkbenchTitleBarState });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getWorkbenchTitleBarState.mock.calls.filter(([input]) => input?.projectId === 'project-1')).toHaveLength(1);

    await unmount(root, container);
  });

  it('does not let an older title-bar response replace the current project title', async () => {
    const { container, root, olderRequest } = await renderOverlappingTitleBarRequests();

    olderRequest.resolve(titleBarState('Project A'));
    await act(async () => {
      await olderRequest.promise;
      await Promise.resolve();
    });

    expect(container.querySelector('.workbench-titlebar__title')?.textContent).toBe('Project B');
    await unmount(root, container);
  });

  it('does not let an older title-bar failure replace the current project title', async () => {
    const { container, root, olderRequest } = await renderOverlappingTitleBarRequests();

    olderRequest.reject(new Error('old title-bar failure'));
    await act(async () => {
      await olderRequest.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(container.querySelector('.workbench-titlebar__title')?.textContent).toBe('Project B');
    expect(container.textContent).not.toContain('old title-bar failure');
    await unmount(root, container);
  });

  it('commits an opened project without waiting for Canvas feedback to load', async () => {
    const feedback = deferred<Awaited<ReturnType<WorkbenchApiClient['readCanvasFeedback']>>>();
    const { container, root } = await renderWorkbenchApp('/projects/project-1', {
      readCanvasFeedback: vi.fn(() => feedback.promise)
    });

    expect(container.textContent).toContain('Opened project: Demo');

    feedback.resolve({ entries: {}, updatedAt: '2026-07-10T00:00:00.000Z' });
    await act(async () => {
      await feedback.promise;
      await Promise.resolve();
    });
    await unmount(root, container);
  });

  it('notifies when selection-driven stack-order synchronization fails', async () => {
    canvasRuntimeState.runtime = createCanvasEditorRuntime();
    vi.doMock('./canvas/CanvasEditor', async () => {
      const { useEffect } = await import('react');
      return {
        CanvasEditor: ({ onRuntimeChange }: { onRuntimeChange(runtime: CanvasEditorRuntime | undefined): void }) => {
          useEffect(() => {
            onRuntimeChange(canvasRuntimeState.runtime);
            return () => onRuntimeChange(undefined);
          }, [onRuntimeChange]);
          return null;
        }
      };
    });
    const failure = new Error('stack-order write failed');
    const bringCanvasNodeToFront = vi.fn().mockRejectedValue(failure);
    const projectSnapshot = stackOrderSnapshotFixture();
    const { container, root } = await renderWorkbenchApp('/projects/project-1', {
      openProject: vi.fn(async () => ({
        projectId: 'project-1',
        projectRevision: 1,
        snapshot: projectSnapshot
      })),
      bringCanvasNodeToFront
    } as Partial<WorkbenchApiClient>);

    await act(async () => {
      canvasRuntimeState.runtime!.setSelection({ kind: 'node', projectRelativePath: 'flow/a.png' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bringCanvasNodeToFront).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      projectRelativePath: 'flow/a.png'
    });
    expect(container.textContent).toContain('Bring node to front failed: stack-order write failed');

    await unmount(root, container);
  });

  it('reloads Adobe live state only through explicit retry after load failure', async () => {
    const adobeBridgeGetState = vi.fn()
      .mockRejectedValueOnce(new Error('bridge unavailable'))
      .mockResolvedValueOnce(adobeBridgeStateFixture());
    const { container, root } = await renderWorkbenchApp('/', { adobeBridgeGetState });

    await act(async () => {
      requireButton(container, 'Settings').click();
      await Promise.resolve();
    });
    await act(async () => {
      requireButton(container, 'Adobe Bridge').click();
      await Promise.resolve();
    });
    expect(adobeBridgeGetState).toHaveBeenCalledTimes(1);

    await act(async () => {
      requireButton(container, 'Retry').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(adobeBridgeGetState).toHaveBeenCalledTimes(2);

    await unmount(root, container);
  });

  it('shows an authoritative Adobe link event without a stale request error', async () => {
    const { link, container, root } = await startPendingAdobeLink();

    await act(async () => {
      emitWorkbenchEvent({
        type: 'adobeBridge.state.changed',
        state: adobeBridgeStateWithPhotoshopClient({
          links: [{
            linkId: 'link-1',
            projectId: 'project-1',
            adobeClientId: 'photoshop-1',
            createdAt: '2026-07-10T00:00:00.000Z',
            status: 'active'
          }]
        })
      });
      link.reject(new Error('stale link failure'));
      await link.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requireButton(container, 'Disconnect').disabled).toBe(false);
    expect(container.querySelector('.adobe-bridge-settings-page .db-form-error')).toBeNull();
    await unmount(root, container);
  });

  it('shows a current Adobe link error after an unrelated Adobe event', async () => {
    const { link, container, root } = await startPendingAdobeLink();

    await act(async () => {
      emitWorkbenchEvent({
        type: 'adobeBridge.state.changed',
        state: adobeBridgeStateWithPhotoshopClient({
          settings: { enabled: true, discoveryStatus: 'unavailable' }
        })
      });
      link.reject(new Error('Photoshop link failed'));
      await link.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requireButton(container, 'Connect').disabled).toBe(false);
    expect(container.querySelector('.adobe-bridge-settings-page .db-form-error')?.textContent)
      .toBe('Photoshop link failed');
    await unmount(root, container);
  });

  it('does not roll a newer settings event back when an older save fails', async () => {
    const { save, container, root } = await startPendingDefaultFrontendSave();

    await act(async () => {
      emitWorkbenchEvent({
        type: 'globalSettings.changed',
        settings: globalSettingsFixture({
          workbench: { locale: 'zh-CN', themePreference: 'light', defaultFrontend: 'runtime-only' }
        })
      });
      save.reject(new Error('save failed'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(container.textContent).toContain('通用');

    await unmount(root, container);
  });

  it('does not replace a newer settings event when an older save succeeds', async () => {
    const { save, container, root } = await startPendingDefaultFrontendSave();

    await act(async () => {
      emitWorkbenchEvent({
        type: 'globalSettings.changed',
        settings: globalSettingsFixture({
          workbench: { locale: 'zh-CN', themePreference: 'light', defaultFrontend: 'runtime-only' }
        })
      });
      save.resolve(globalSettingsFixture({
        workbench: { locale: 'en', themePreference: 'dark', defaultFrontend: 'browser' }
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(container.textContent).toContain('通用');

    await unmount(root, container);
  });
});

async function startPendingDefaultFrontendSave(): Promise<{
  save: ReturnType<typeof deferred<DebruteGlobalSettingsView>>;
  container: HTMLDivElement;
  root: Root;
}> {
  const save = deferred<DebruteGlobalSettingsView>();
  const globalSettingsSave = vi.fn(() => save.promise);
  const { container, root } = await renderWorkbenchApp('/', { globalSettingsSave });

  await act(async () => {
    requireButton(container, 'Settings').click();
    await Promise.resolve();
  });
  const defaultFrontend = Array.from(container.querySelectorAll('select'))
    .find((select) => select.textContent?.includes('Runtime only'));
  if (!(defaultFrontend instanceof HTMLSelectElement)) {
    throw new Error('Expected default frontend select.');
  }
  await act(async () => {
    setSelectValue(defaultFrontend, 'browser');
    defaultFrontend.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(globalSettingsSave).toHaveBeenCalledTimes(1);

  return { save, container, root };
}

async function startPendingAdobeLink(): Promise<{
  link: ReturnType<typeof deferred<AdobeBridgeStateView>>;
  container: HTMLDivElement;
  root: Root;
}> {
  const link = deferred<AdobeBridgeStateView>();
  const { container, root } = await renderWorkbenchApp('/projects/project-1', {
    adobeBridgeGetState: vi.fn(async () => adobeBridgeStateWithPhotoshopClient()),
    adobeBridgeLinkPhotoshop: vi.fn(() => link.promise)
  });

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    requireButton(container, 'Settings').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  const adobeBridgeButton = await waitForButton(container, 'Adobe Bridge');
  await act(async () => {
    adobeBridgeButton.click();
    await Promise.resolve();
  });
  const connectButton = await waitForButton(container, 'Connect');
  await act(async () => {
    connectButton.click();
    await Promise.resolve();
  });

  return { link, container, root };
}

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

async function renderOverlappingTitleBarRequests(): Promise<{
  container: HTMLDivElement;
  root: Root;
  olderRequest: ReturnType<typeof deferred<ReturnType<typeof unavailableWorkbenchTitleBarState>>>;
}> {
  const olderRequest = deferred<ReturnType<typeof unavailableWorkbenchTitleBarState>>();
  const currentRequest = deferred<ReturnType<typeof unavailableWorkbenchTitleBarState>>();
  const getWorkbenchTitleBarState = vi.fn(async (input: Parameters<WorkbenchApiClient['getWorkbenchTitleBarState']>[0]) => {
    if (input.projectId === 'project-a') {
      return olderRequest.promise;
    }
    if (input.projectId === 'project-b') {
      return currentRequest.promise;
    }
    return unavailableWorkbenchTitleBarState();
  });
  const rendered = await renderWorkbenchApp('/', { getWorkbenchTitleBarState });

  for (const [projectId, projectRevision] of [['project-a', 1], ['project-b', 2]] as const) {
    await act(async () => {
      emitWorkbenchEvent({
        type: 'project.opened',
        projectId,
        projectRevision,
        snapshot: snapshotFixture()
      });
      await Promise.resolve();
    });
  }
  currentRequest.resolve(titleBarState('Project B'));
  await act(async () => {
    await currentRequest.promise;
    await Promise.resolve();
  });
  expect(rendered.container.querySelector('.workbench-titlebar__title')?.textContent).toBe('Project B');
  return { ...rendered, olderRequest };
}

function titleBarState(projectTitle: string): ReturnType<typeof unavailableWorkbenchTitleBarState> {
  return buildWorkbenchTitleBarState({
    platform: 'darwin',
    host: 'web',
    projectTitle,
    recentProjectRoots: []
  });
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
  const button = findButton(container, label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${label} button.`);
  }
  return button;
}

async function waitForButton(container: HTMLElement, label: string): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const button = findButton(container, label);
    if (button) {
      return button;
    }
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error(`Expected ${label} button.`);
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes(label) || candidate.getAttribute('aria-label') === label);
}

function apiFixture(overrides: Partial<WorkbenchApiClient> = {}): WorkbenchApiClient {
  return {
    mode: 'web',
    clientId: 'test-client',
    globalSettingsGet: vi.fn(async () => globalSettingsFixture()),
    globalSettingsSave: vi.fn(async () => globalSettingsFixture()),
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
    integrationsRescan: vi.fn(async () => ({ integrations: [], backends: [] })),
    integrationsRunOperation: vi.fn(async () => ({
      ok: true,
      integrationId: 'imagemagick',
      operation: 'install',
      settings: { integrations: [], backends: [] }
    })),
    adobeBridgeGetState: vi.fn(async () => adobeBridgeStateFixture()),
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

function globalSettingsFixture(overrides: Partial<DebruteGlobalSettingsView> = {}): DebruteGlobalSettingsView {
  return {
    workbench: { locale: 'en', themePreference: 'dark', defaultFrontend: 'electron' },
    chrome: { recentProjectRoots: [] },
    models: {
      image: imageSettingsFixture(),
      video: { models: [] },
      audio: { models: [] }
    },
    integrations: { integrations: [], backends: [] },
    adobeBridge: { enabled: true },
    ...overrides
  };
}

function imageSettingsFixture(): ImageModelSettingsView {
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

function adobeBridgeStateWithPhotoshopClient(overrides: Partial<AdobeBridgeStateView> = {}): AdobeBridgeStateView {
  return adobeBridgeStateFixture({
    adobeClients: [{
      adobeClientId: 'photoshop-1',
      hostApp: 'photoshop',
      hostVersion: '2026',
      displayName: 'Photoshop 2026',
      documentCount: 0,
      activeDocumentTitle: null,
      connectedAt: '2026-07-10T00:00:00.000Z',
      lastSeenAt: '2026-07-10T00:00:00.000Z'
    }],
    ...overrides
  });
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

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (!setter) {
    throw new Error('Expected HTMLSelectElement value setter.');
  }
  setter.call(select, value);
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

function stackOrderSnapshotFixture(): WorkbenchProjectSessionSnapshot {
  const snapshot = snapshotFixture();
  return {
    ...snapshot,
    canvases: [{
      id: 'canvas-1',
      name: 'Canvas 1',
      nodeElements: [
        {
          projectRelativePath: 'flow/a.png',
          nodeKind: 'file',
          mediaKind: 'image',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          z: 0
        },
        {
          projectRelativePath: 'flow/b.png',
          nodeKind: 'file',
          mediaKind: 'image',
          x: 120,
          y: 0,
          width: 100,
          height: 100,
          z: 1
        }
      ],
      annotations: [],
      preferences: { showDiagnostics: true }
    }],
    projections: [{
      canvasId: 'canvas-1',
      nodes: [],
      edges: [],
      diagnostics: []
    }],
    canvasRegistry: { status: 'ready', canvasOrder: ['canvas-1'] }
  };
}
