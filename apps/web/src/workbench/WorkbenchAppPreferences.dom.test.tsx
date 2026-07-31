import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DebruteShellApi,
  type DebruteGlobalSettingsView,
  type DebruteProductState,
  type ImageModelSettingRecord,
  type WorkbenchApiClient,
  type WorkbenchEvent,
  type WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import {
  createWorkbenchGlobalProjection,
  type WorkbenchGlobalProjectionWriter
} from './services/WorkbenchGlobalProjection.js';
import {
  createWorkbenchProjectProjection,
  type WorkbenchProjectProjection
} from './services/WorkbenchProjectProjection.js';

vi.mock('./canvas/CanvasTextRenderProfileContext.js', async () => {
  const { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } = await import('./canvas/CanvasTextRenderProfile.test-support.js');
  return {
    CanvasTextRenderProfileGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    CanvasTextRenderProfileProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useCanvasTextRenderProfile: () => DEFAULT_CANVAS_TEXT_RENDER_PROFILE
  };
});

type WorkbenchAppComponent = (typeof import('./WorkbenchApp'))['WorkbenchApp'];

const apiState = vi.hoisted(() => {
  const state = {
    api: undefined as WorkbenchApiClient | undefined,
    globalProjection: undefined as WorkbenchGlobalProjectionWriter | undefined,
    projectProjection: undefined as WorkbenchProjectProjection | undefined,
    listeners: new Set<(event: WorkbenchEvent) => void>(),
    connectionListeners: new Set<(error: Error) => void>()
  };
  const client = new Proxy({} as WorkbenchApiClient, {
    get(_target, property) {
      if (!state.api) {
        throw new Error('WorkbenchApp test API was not configured.');
      }
      if (property === 'projectProjection') {
        if (!state.projectProjection) {
          throw new Error('WorkbenchApp test Project Projection was not configured.');
        }
        return state.projectProjection;
      }
      if (property === 'globalProjection') {
        if (!state.globalProjection) {
          throw new Error('WorkbenchApp test Global Projection was not configured.');
        }
        return state.globalProjection;
      }
      const value = Reflect.get(state.api, property, state.api);
      if (property === 'openProject' && typeof value === 'function') {
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, state.api, args) as Record<string, unknown>;
          if (
            state.projectProjection
            && typeof result.projectId === 'string'
            && typeof result.projectRevision === 'number'
            && result.snapshot
            && result.workingCopies
          ) {
            state.projectProjection.acceptBoundProject(result as never);
          }
          return result;
        };
      }
      return value;
    }
  });
  return Object.assign(state, { client });
});
let WorkbenchApp: WorkbenchAppComponent;

describe('WorkbenchApp preferences and project behavior', () => {
  const canvasGetContextDescriptor = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    'getContext'
  );

  beforeAll(async () => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => null
    });
    apiState.api = apiFixture();
    vi.resetModules();
    ({ WorkbenchApp } = await import('./WorkbenchApp'));
  }, 30_000);

  afterAll(() => {
    if (canvasGetContextDescriptor) {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', canvasGetContextDescriptor);
    } else {
      Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext');
    }
  });

  beforeEach(() => {
    apiState.globalProjection = createWorkbenchGlobalProjection();
    apiState.globalProjection.acceptSnapshot({ revision: 0, settings: globalSettingsFixture() });
    apiState.globalProjection.acceptEvent({
      type: 'integrations.changed',
      revision: 0,
      integrations: { integrations: [], backends: [] }
    });
    apiState.globalProjection.acceptEvent({
      type: 'product.changed',
      revision: 0,
      product: productStateFixture()
    });
    apiState.globalProjection.acceptEvent({
      type: 'photoshop.state.changed',
      revision: 0,
      state: { sessions: [] }
    });
    apiState.projectProjection = createWorkbenchProjectProjection();
    apiState.listeners.clear();
    apiState.connectionListeners.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.setProperty('--db-text', '#ffffff');
    document.documentElement.style.setProperty('--db-text-muted', 'rgb(255 255 255 / 72%)');
    window.sessionStorage.clear();
    delete window.debruteShell;
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
    apiState.globalProjection = undefined;
    apiState.projectProjection = undefined;
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.removeProperty('--db-text');
    document.documentElement.style.removeProperty('--db-text-muted');
    delete window.debruteShell;
  });

  describe('global preference events', { tags: ['settings'] }, () => {
    it('applies global preference events on the project-open surface', async () => {
      const { container, root } = await renderWorkbenchApp('/');

      expect(container.textContent).toContain('Open Project');

      await act(async () => {
        emitWorkbenchEvent({
          type: 'globalSettings.changed', revision: 1,
          settings: globalSettingsFixture({
            workbench: { locale: 'zh-CN', themePreference: 'light' }
          })
        });
      });

      expect(container.textContent).toContain('打开项目');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(apiState.api!.onEvent).toHaveBeenCalledTimes(1);

      await act(async () => {
        requireButton(container, '设置').click();
      });
      await waitForButton(container, '通用');
      expect(container.querySelector('.settings-panel')?.textContent).toContain('通用');

      await unmount(root, container);
    });
  });

  it('does not retain fields from a previous API fixture', async () => {
    const first = await renderWorkbenchApp('/', {
      firstFixtureOnly: true
    } as Partial<WorkbenchApiClient>);
    expect((apiState.client as WorkbenchApiClient & { firstFixtureOnly?: boolean }).firstFixtureOnly)
      .toBe(true);
    await unmount(first.root, first.container);

    const second = await renderWorkbenchApp('/');
    expect((apiState.client as WorkbenchApiClient & { firstFixtureOnly?: boolean }).firstFixtureOnly)
      .toBeUndefined();
    await unmount(second.root, second.container);
  });

  it('delegates the Desktop Project-open surface to the native picker', async () => {
    const executeNativeMenuCommand = vi.fn(async () => ({ ok: true as const }));
    window.debruteShell = shellApiFixture({ executeNativeMenuCommand });
    const { container, root } = await renderWorkbenchApp('/');

    await act(async () => {
      requireButton(container, 'Open Project').click();
      await Promise.resolve();
    });

    expect(executeNativeMenuCommand).toHaveBeenCalledWith({ commandId: 'project.open-picker' });
    expect(apiState.api!.chooseProjectRoot).not.toHaveBeenCalled();
    await unmount(root, container);
  });

  it('keeps the current Project admitted while the Web selector is open and cancelled', async () => {
    const selection = deferred<string | undefined>();
    const chooseProjectRoot = vi.fn(() => selection.promise);
    const openProject = vi.fn(async () => ({
      projectId: 'project-1',
      projectRevision: 1,
      snapshot: stackOrderSnapshotFixture(),
      workingCopies: emptyWorkingCopies()
    }));
    const addProjectPathToCanvasMap = vi.fn(async () => ({
      projectId: 'project-1',
      projectRevision: 2,
      canvasId: 'canvas-1',
      projectRelativePath: 'flow/new.png'
    }));
    const { container, root } = await renderWorkbenchApp('/projects/project-1', {
      chooseProjectRoot,
      openProject,
      addProjectPathToCanvasMap
    });

    await act(async () => {
      requireButton(container, 'File').click();
      await Promise.resolve();
    });
    await act(async () => {
      requireButton(container, 'Open Project').click();
      await Promise.resolve();
    });

    expect(chooseProjectRoot).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="workbench-project-opening"]')).toBeNull();

    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        getData: () => JSON.stringify([{
          kind: 'file',
          projectRelativePath: 'flow/new.png'
        }])
      }
    });
    await act(async () => {
      container.querySelector('[data-testid="canvas-surface"]')?.dispatchEvent(drop);
      await Promise.resolve();
    });

    expect(addProjectPathToCanvasMap).toHaveBeenCalledTimes(1);

    await act(async () => {
      selection.resolve(undefined);
      await Promise.resolve();
    });

    expect(openProject).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Demo');
    await unmount(root, container);
  });

  it('disables the Terminal panel before a project is open', async () => {
    const { container, root } = await renderWorkbenchApp('/');

    expect(requireButton(container, 'Terminal').disabled).toBe(true);

    await unmount(root, container);
  });

  it('requests a shallow Project directory when Explorer expands it', async () => {
    const snapshot = snapshotFixture();
    snapshot.files = [{ projectRelativePath: 'assets', kind: 'directory' }];
    const loadProjectDirectory = vi.fn(async () => ({
      projectId: 'project-1',
      projectRevision: 2,
      snapshot
    }));
    const { container, root } = await renderWorkbenchApp('/projects/project-1', {
      openProject: vi.fn(async () => ({
        projectId: 'project-1',
        projectRevision: 1,
        snapshot,
        workingCopies: emptyWorkingCopies()
      })),
      loadProjectDirectory
    });

    await act(async () => {
      requireButton(container, 'Explorer').click();
      await Promise.resolve();
    });
    await waitForButton(container, 'assets');
    await act(async () => {
      requireButton(container, 'assets').click();
      await Promise.resolve();
    });

    expect(loadProjectDirectory).toHaveBeenCalledWith('assets');
    await unmount(root, container);
  });

  it('reports native window state failures without inventing Windows controls on macOS', async () => {
    window.debruteShell = shellApiFixture({
      getNativeWindowState: vi.fn().mockRejectedValue(new Error('native state unavailable'))
    });
    const { container, root } = await renderWorkbenchApp('/');

    expect(container.textContent).toContain('Window state failed: native state unavailable');
    expect(findButton(container, 'Minimize window')).toBeUndefined();
    expect(findButton(container, 'Maximize window')).toBeUndefined();
    expect(findButton(container, 'Close window')).toBeUndefined();

    await unmount(root, container);
  });

  describe('global model settings', { tags: ['settings'] }, () => {
    it('renders global model settings from the initial connection snapshot before a project is open', async () => {
      const { container, root } = await renderWorkbenchApp('/');

      const settingsButton = requireButton(container, 'Settings');
      await act(async () => {
        settingsButton.click();
        await Promise.resolve();
      });
      await waitForButton(container, 'Image Models');

      expect(container.querySelectorAll('.settings-directory-group')).toHaveLength(3);
      expect(container.querySelector('.settings-page')?.querySelectorAll('h2')).toHaveLength(1);

      const imageModelsButton = requireButton(container, 'Image Models');
      await act(async () => {
        imageModelsButton.click();
        await Promise.resolve();
      });

      expect(apiState.api!.openProject).not.toHaveBeenCalled();
      expect(container.querySelector('.settings-page')?.textContent).toContain('image/openai/gpt-image-1');

      await unmount(root, container);
    });
  });

  it('replaces the Project-scoped event subscription when the initial generation opens', async () => {
    const { container, root } = await renderWorkbenchApp('/projects/project-1');

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiState.api!.openProject).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(apiState.api!.onEvent).toHaveBeenCalledTimes(2);
    expect(apiState.listeners.size).toBe(1);

    await unmount(root, container);
    expect(apiState.listeners.size).toBe(0);
  });

  it('opens the Project with defaults after rejecting an invalid saved view state', async () => {
    window.sessionStorage.setItem('debrute:project-view:project-1', JSON.stringify({
      activeCanvasId: 'canvas-1',
      unexpectedField: 'sidebar'
    }));

    const { container, root } = await renderWorkbenchApp('/projects/project-1');

    expect(container.textContent).toContain('Saved view state for Demo was invalid and has been reset.');
    expect(container.textContent).toContain('Opened project: Demo');
    expect(JSON.parse(window.sessionStorage.getItem('debrute:project-view:project-1')!)).toEqual({
      floatingPanels: expect.any(Object)
    });

    await unmount(root, container);
  });

  it('keeps the Project visible behind a blocking dialog when another Workbench preempts it', async () => {
    const { container, root } = await renderWorkbenchApp('/projects/project-1', {
      openProject: vi.fn(async () => ({
        projectId: 'project-1',
        projectRevision: 1,
        snapshot: stackOrderSnapshotFixture(),
        workingCopies: emptyWorkingCopies()
      }))
    });
    await act(async () => {
      await Promise.resolve();
      detachCurrentProject();
    });

    const dialogLayer = container.querySelector('[data-testid="workbench-detached-dialog-layer"]');
    const dialog = dialogLayer?.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('active in another Workbench');
    expect(dialog?.hasAttribute('aria-modal')).toBe(false);
    expect(dialogLayer?.getAttribute('role')).toBe('presentation');
    expect(container.querySelector('[data-testid="canvas-surface"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="canvas-layer"]')?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('[data-testid="floating-bar-layer"]')?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('[data-testid="panel-layer"]')?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('[data-testid="workbench-titlebar"]')?.hasAttribute('inert')).toBe(false);
    expect(container.textContent).toContain('Demo');
    await unmount(root, container);
  });

  it('keeps the last accepted Project visible when its connection fails', async () => {
    const { container, root } = await renderWorkbenchApp('/projects/project-1', {
      openProject: vi.fn(async () => ({
        projectId: 'project-1',
        projectRevision: 1,
        snapshot: stackOrderSnapshotFixture(),
        workingCopies: emptyWorkingCopies()
      }))
    });

    await act(async () => {
      endCurrentConnection(new Error('revision gap'));
      await Promise.resolve();
    });

    const dialogLayer = container.querySelector('[data-testid="workbench-connection-ended-dialog-layer"]');
    const dialog = dialogLayer?.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('revision gap');
    expect(dialog?.hasAttribute('aria-modal')).toBe(false);
    expect(container.querySelector('[data-testid="canvas-surface"]')).not.toBeNull();
    expect(container.textContent).toContain('Demo');
    await unmount(root, container);
  });

  it('opens an explicitly requested Desktop Project without a destination confirmation surface', async () => {
    const openProject = vi.fn<WorkbenchApiClient['openProject']>(async () => ({
      projectId: 'project-1',
      projectRevision: 1,
      snapshot: snapshotFixture(),
      workingCopies: emptyWorkingCopies()
    }));
    const { container, root } = await renderWorkbenchApp('/projects/project-1', { openProject });

    expect(openProject).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(findButton(container, 'Open Here')).toBeUndefined();
    expect(container.textContent).toContain('Demo');
    await unmount(root, container);
  });

  it('keeps a detached Open Here failure inside the blocking dialog', async () => {
    const openProject = vi.fn<WorkbenchApiClient['openProject']>()
      .mockResolvedValueOnce({
        projectId: 'project-1',
        projectRevision: 1,
        snapshot: snapshotFixture(),
        workingCopies: emptyWorkingCopies()
      })
      .mockRejectedValueOnce(new Error('takeover failed'));
    const { container, root } = await renderWorkbenchApp('/projects/project-1', { openProject });

    await act(async () => {
      detachCurrentProject();
      await Promise.resolve();
    });
    await act(async () => {
      requireButton(container, 'Open Here').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const dialog = container.querySelector('[data-testid="workbench-detached-dialog-layer"]');
    const error = dialog?.querySelector('[role="alert"]');
    expect(error?.textContent).toContain('Open project failed: takeover failed');
    expect(error?.previousElementSibling?.textContent).toContain('Open Here');
    expect(openProject).toHaveBeenLastCalledWith({ projectId: 'project-1' });
    expect(container.querySelector('[data-testid="canvas-layer"]')?.hasAttribute('inert')).toBe(true);
    await unmount(root, container);
  });

  it('recreates Project-scoped presentation when a new binding generation is accepted', async () => {
    const { container, root } = await renderWorkbenchApp('/projects/project-1');
    await act(async () => {
      requireButton(container, 'Terminal').click();
    });
    expect(container.querySelector('[data-testid="floating-panel-terminal"]')).not.toBeNull();

    const secondSnapshot = snapshotFixture();
    secondSnapshot.metadata.project = {
      ...secondSnapshot.metadata.project,
      id: 'project-2',
      name: 'Second Project'
    };
    await act(async () => {
      apiState.projectProjection?.acceptBoundProject({
        projectId: 'project-2',
        projectRevision: 1,
        snapshot: secondSnapshot,
        workingCopies: emptyWorkingCopies()
      });
    });

    expect(container.querySelector('[data-testid="floating-panel-terminal"]')).toBeNull();
    expect(container.querySelector('.workbench-titlebar__title')?.textContent).toBe('Second Project');
    await unmount(root, container);
  });

  it('derives current Project title and recent roots locally from ordered state', async () => {
    const { container, root } = await renderWorkbenchApp('/projects/project-1');

    await act(async () => {
      emitWorkbenchEvent({
        type: 'recentProjects.changed', revision: 1,
        recentProjects: [{ projectId: 'current', projectRoot: '/projects/current' }]
      });
      await Promise.resolve();
    });
    await act(async () => {
      requireButton(container, 'File').click();
    });
    await act(async () => {
      requireButton(container, 'Open Recent').click();
    });

    expect(container.querySelector('.workbench-titlebar__title')?.textContent).toBe('Demo');
    expect(container.textContent).toContain('/projects/current');
    await unmount(root, container);
  });

  it('keeps the first opened project when recent projects change before React effects flush', async () => {
    const opening = deferred<Awaited<ReturnType<WorkbenchApiClient['openProject']>>>();
    const { container, root } = await renderWorkbenchApp('/open?path=%2Ftmp%2Ffirst-open', {
      openProject: vi.fn(() => opening.promise)
    });

    await act(async () => {
      opening.resolve({
        projectId: 'project-1',
        projectRevision: 1,
        snapshot: snapshotFixture(),
        workingCopies: emptyWorkingCopies()
      });
      await opening.promise;
      await Promise.resolve();
      await Promise.resolve();
      emitWorkbenchEvent({
        type: 'recentProjects.changed', revision: 1,
        recentProjects: [{ projectId: 'first-open', projectRoot: '/tmp/first-open' }]
      });
    });

    expect(window.location.pathname).toBe('/projects/project-1');
    expect(container.textContent).toContain('Opened project: Demo');
    expect(container.textContent).not.toContain('No project open');
    expect(requireButton(container, 'Terminal').disabled).toBe(false);
    await unmount(root, container);
  });

  it('opens the initial Project once during the StrictMode effect probe', async () => {
    const openProject = vi.fn(async () => ({
      projectId: 'project-1',
      projectRevision: 1,
      snapshot: snapshotFixture(),
      workingCopies: emptyWorkingCopies()
    }));
    const StrictWorkbenchApp: WorkbenchAppComponent = (props) => (
      <React.StrictMode>
        <WorkbenchApp {...props} />
      </React.StrictMode>
    );

    const { container, root } = await renderWorkbenchApp(
      '/open?path=%2Ftmp%2Fstrict-open',
      { openProject },
      StrictWorkbenchApp
    );

    expect(openProject).toHaveBeenCalledOnce();
    expect(openProject).toHaveBeenCalledWith({ projectRoot: '/tmp/strict-open' });
    expect(container.textContent).toContain('Opened project: Demo');
    expect(container.textContent?.match(/Opened project: Demo/g)).toHaveLength(1);
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

  describe('global settings save races', { tags: ['settings'] }, () => {
    it('keeps an acknowledged Canvas Text Appearance while Settings is closed and reopened before confirmation', async () => {
      const globalSettingsSave = vi.fn(async () => ({ ok: true as const }));
      const { container, root } = await renderWorkbenchApp('/', { globalSettingsSave });

      await act(async () => {
        requireButton(container, 'Settings').click();
        await Promise.resolve();
      });
      await waitForButton(container, 'Appearance');
      await act(async () => {
        requireButton(container, 'Appearance').click();
      });

      const fontSize = requireInputForLabel(container, 'Font size');
      await act(async () => {
        setInputValue(fontSize, '13');
        fontSize.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(globalSettingsSave).toHaveBeenCalledOnce();

      await act(async () => {
        requireButton(container, 'Close Settings').click();
      });
      expect(container.querySelector('[data-testid="floating-panel-settings"]')).toBeNull();

      await act(async () => {
        requireButton(container, 'Settings').click();
        await Promise.resolve();
      });
      await waitForButton(container, 'Appearance');
      await act(async () => {
        requireButton(container, 'Appearance').click();
      });

      expect(requireInputForLabel(container, 'Font size').value).toBe('13');
      await unmount(root, container);
    });

    it('does not roll a newer settings event back when an older save fails', async () => {
      const { save, container, root } = await startPendingLocaleSave();

      await act(async () => {
        emitWorkbenchEvent({
          type: 'globalSettings.changed', revision: 1,
          settings: globalSettingsFixture({
            workbench: { locale: 'zh-CN', themePreference: 'light' }
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

    it('does not replace a newer settings event when the save is acknowledged', async () => {
      const { save, container, root } = await startPendingLocaleSave();

      await act(async () => {
        emitWorkbenchEvent({
          type: 'globalSettings.changed', revision: 1,
          settings: globalSettingsFixture({
            workbench: { locale: 'zh-CN', themePreference: 'light' }
          })
        });
        save.resolve({ ok: true });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(container.textContent).toContain('通用');

      await unmount(root, container);
    });
  });

  it('installs an available Product directly from the title bar', async () => {
    const applyProductUpdate = vi.fn(async () => ({ ok: true as const }));
    const { container, root } = await renderWorkbenchApp('/', { applyProductUpdate });

    await act(async () => {
      emitWorkbenchEvent({
        type: 'product.changed',
        revision: 1,
        product: {
          ...productStateFixture(),
          update: {
            type: 'available',
            currentVersion: '0.2.0',
            updateVersion: '0.3.0'
          }
        }
      });
    });
    await act(async () => {
      requireButton(container, 'Update 0.3.0').click();
      await Promise.resolve();
    });

    expect(applyProductUpdate).toHaveBeenCalledOnce();
    await unmount(root, container);
  });

  it('replaces the Workbench with a global blocking surface during installation', async () => {
    const { container, root } = await renderWorkbenchApp('/');

    await act(async () => {
      emitWorkbenchEvent({
        type: 'product.changed',
        revision: 1,
        product: {
          ...productStateFixture(),
          update: {
            type: 'preparing',
            currentVersion: '0.2.0',
            updateVersion: '0.3.0',
            stage: 'closing_new_work'
          }
        }
      });
    });

    expect(container.querySelector('[data-testid="workbench-product-update-blocking"]')).not.toBeNull();
    expect(container.textContent).toContain('Preparing the complete Debrute update');
    expect(findButton(container, 'Update 0.3.0')).toBeUndefined();
    await unmount(root, container);
  });
});

async function startPendingLocaleSave(): Promise<{
  save: ReturnType<typeof deferred<{ ok: true }>>;
  container: HTMLDivElement;
  root: Root;
}> {
  const save = deferred<{ ok: true }>();
  const globalSettingsSave = vi.fn(() => save.promise);
  const { container, root } = await renderWorkbenchApp('/', { globalSettingsSave });

  await act(async () => {
    requireButton(container, 'Settings').click();
    await Promise.resolve();
  });
  await waitForButton(container, 'General');
  const locale = Array.from(container.querySelectorAll('select'))
    .find((select) => select.textContent?.includes('Simplified Chinese'));
  if (!(locale instanceof HTMLSelectElement)) {
    throw new Error('Expected language select.');
  }
  await act(async () => {
    setSelectValue(locale, 'zh-CN');
    locale.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(globalSettingsSave).toHaveBeenCalledTimes(1);

  return { save, container, root };
}

async function renderWorkbenchApp(
  pathname: string,
  apiOverrides: Partial<WorkbenchApiClient> = {},
  App = WorkbenchApp
): Promise<{ container: HTMLDivElement; root: Root }> {
  window.history.replaceState({ preserved: true }, '', pathname);
  apiState.api = apiFixture(apiOverrides);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <App
        api={apiState.client as Parameters<WorkbenchAppComponent>[0]['api']}
      />
    );
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
  if ('projectId' in event && 'projectRevision' in event) {
    apiState.projectProjection?.acceptProjectEvent(event);
  } else {
    const projection = apiState.globalProjection?.getState();
    if (projection && projection.status !== 'uninitialized') {
      event = { ...event, revision: projection.revision + 1 };
      apiState.globalProjection?.acceptEvent(event);
    }
  }
  for (const listener of apiState.listeners) {
    listener(event);
  }
}

function detachCurrentProject(): void {
  const state = apiState.projectProjection?.getState();
  if (state && state.status === 'bound') {
    apiState.projectProjection?.detachProject(state.projectId);
  }
}

function endCurrentConnection(error: Error): void {
  apiState.globalProjection?.endConnection(error);
  apiState.projectProjection?.endConnection(error);
  for (const listener of apiState.connectionListeners) {
    listener(error);
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const button = findButton(container, label);
    if (button) {
      return button;
    }
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  throw new Error(`Expected ${label} button.`);
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes(label) || candidate.getAttribute('aria-label') === label);
}

function emptyWorkingCopies() {
  return { text: {}, feedback: {} };
}

function apiFixture(overrides: Partial<WorkbenchApiClient> = {}): WorkbenchApiClient {
  return {
    globalSettingsSave: vi.fn(async () => ({ ok: true as const })),
    onEvent: vi.fn((listener: (event: WorkbenchEvent) => void) => {
      apiState.listeners.add(listener);
      return () => apiState.listeners.delete(listener);
    }),
    onConnectionEnded: vi.fn((listener: (error: Error) => void) => {
      apiState.connectionListeners.add(listener);
      return () => apiState.connectionListeners.delete(listener);
    }),
    checkProductUpdate: vi.fn(async () => ({ ok: true as const })),
    applyProductUpdate: vi.fn(async () => ({ ok: true as const })),
    integrationsRescan: vi.fn(async () => ({ ok: true as const })),
    integrationsRunOperation: vi.fn(async () => ({
      ok: true,
      integrationId: 'imagemagick',
      operation: 'install'
    })),
    openProject: vi.fn(async () => ({
      projectId: 'project-1',
      projectRevision: 1,
      snapshot: snapshotFixture(),
      workingCopies: emptyWorkingCopies()
    })),
    chooseProjectRoot: vi.fn(async () => undefined),
    readCanvasFeedback: vi.fn(async () => ({ entries: {} })),
    putTextWorkingCopy: vi.fn(async (_projectId, value) => value),
    clearTextWorkingCopy: vi.fn(async () => undefined),
    putFeedbackWorkingCopy: vi.fn(async (_projectId, value) => value),
    clearFeedbackWorkingCopy: vi.fn(async () => undefined),
    clearRecentProjectRoots: vi.fn(async () => ({ ok: true })),
    subscribeTerminalSessions: vi.fn(() => ({ close: vi.fn() })),
    ...overrides
  } as unknown as WorkbenchApiClient;
}

function productStateFixture(): DebruteProductState {
  return {
    productVersion: 'test',
    platform: 'darwin',
    cli: {
      status: 'ready',
      version: 'test',
      path: '/tmp/debrute',
      skillsVersion: 'test',
      skillsRoot: '/tmp/debrute-skills'
    },
    update: { type: 'up_to_date', currentVersion: 'test' }
  };
}

function globalSettingsFixture(overrides: Partial<DebruteGlobalSettingsView> = {}): DebruteGlobalSettingsView {
  return {
    workbench: { locale: 'en', themePreference: 'dark' },
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
    models: {
      image: imageSettingsFixture(),
      video: [],
      audio: []
    },
    ...overrides
  };
}

function imageSettingsFixture(): ImageModelSettingRecord[] {
  return [{
    debruteModelId: 'image/openai/gpt-image-1',
    summary: 'OpenAI image generation.',
    supportsEditing: true,
    supportsTextRendering: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultRequestModelId: 'gpt-image-1',
    baseUrlOverride: null,
    requestModelIdOverride: null,
    apiKeySet: false
  }];
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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) {
    throw new Error('Expected HTMLInputElement value setter.');
  }
  setter.call(input, value);
}

function requireInputForLabel(container: HTMLElement, label: string): HTMLInputElement {
  const field = Array.from(container.querySelectorAll<HTMLElement>('.db-field')).find((candidate) => (
    candidate.querySelector('.db-field__label')?.textContent === label
  ));
  const input = field?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Expected input for ${label}.`);
  }
  return input;
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
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-06-28T00:00:00.000Z'
    },
    canvasRegistry: { status: 'ready', canvasOrder: [] }
  };
}

function shellApiFixture(overrides: Partial<DebruteShellApi>): DebruteShellApi {
  return {
    getNativeWindowState: async () => ({ maximized: false }),
    minimizeNativeWindow: async () => ({ maximized: false }),
    toggleMaximizeNativeWindow: async () => ({ maximized: true }),
    closeNativeWindow: async () => ({ ok: true }),
    executeNativeMenuCommand: async () => ({ ok: true }),
    takeDesktopLaunchTicket: async () => undefined,
    onNativeWindowStateChanged: () => () => undefined,
    onNativeEditCommand: () => () => undefined,
    getDroppedFilePath: () => undefined,
    ...overrides
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
