// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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

  it('applies global preference events after a project is open', async () => {
    const { container, root } = await renderWorkbenchApp('/projects/project-1');

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiState.api!.openProject).toHaveBeenCalledWith({ projectId: 'project-1' });

    await act(async () => {
      emitWorkbenchEvent({
        type: 'workbench.preferences.changed',
        preferences: { locale: 'zh-CN', themePreference: 'light' }
      });
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await unmount(root, container);
  });
});

async function renderWorkbenchApp(pathname: string): Promise<{ container: HTMLDivElement; root: Root }> {
  window.history.replaceState({ debruteDaemonToken: 'secret' }, '', pathname);
  apiState.api = apiFixture();
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

function apiFixture(): WorkbenchApiClient {
  return {
    mode: 'web',
    clientId: 'test-client',
    workbenchPreferencesGet: vi.fn(async () => ({ locale: 'en', themePreference: 'dark' })),
    workbenchPreferencesSave: vi.fn(async (preferences) => preferences),
    onEvent: vi.fn((listener: (event: WorkbenchEvent) => void) => {
      apiState.listeners.add(listener);
      return () => apiState.listeners.delete(listener);
    }),
    getDesktopPlatform: vi.fn(async () => 'darwin'),
    getWorkbenchTitleBarState: vi.fn(async () => unavailableWorkbenchTitleBarState()),
    integrationsListStatus: vi.fn(async () => ({ integrations: [] })),
    adobeBridgeGetState: vi.fn(async () => ({ settings: { enabled: true }, clients: [], links: [], transfers: [] })),
    imageModelGetSettings: vi.fn(async () => ({ models: [] })),
    videoModelGetSettings: vi.fn(async () => ({ models: [] })),
    openProject: vi.fn(async () => ({
      projectId: 'project-1',
      projectRevision: 1,
      snapshot: snapshotFixture()
    })),
    openProjectFromPicker: vi.fn(async () => ({ opened: false })),
    readCanvasFeedback: vi.fn(async () => ({ entries: {} })),
    clearRecentProjectRoots: vi.fn(async () => ({ ok: true })),
    listTerminalSessions: vi.fn(async () => ({ sessions: [] }))
  } as unknown as WorkbenchApiClient;
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
