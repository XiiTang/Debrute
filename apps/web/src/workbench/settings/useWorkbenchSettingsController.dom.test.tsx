import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type {
  CanvasTextAppearance,
  DebruteGlobalSettingsView,
  WorkbenchApiClient
} from '@debrute/app-protocol';
import { createWorkbenchGlobalProjection } from '../services/WorkbenchGlobalProjection.js';
import { useCanvasGlobalSettingsController } from '../services/useCanvasGlobalSettingsController.js';
import {
  useWorkbenchSettingsController,
  type WorkbenchSettingsController
} from './useWorkbenchSettingsController.js';

describe('useWorkbenchSettingsController', { tags: ['settings'] }, () => {
  it('presents changes immediately while serializing and coalescing saves', async () => {
    const saves: Array<ReturnType<typeof deferred<{ ok: true }>>> = [];
    const globalSettingsSave = vi.fn(() => {
      const save = deferred<{ ok: true }>();
      saves.push(save);
      return save.promise;
    });
    const rendered = await renderController(globalSettingsSave);

    let first!: Promise<void>;
    let second!: Promise<void>;
    let third!: Promise<void>;
    await act(async () => {
      first = saveAppearance(rendered.current, appearanceFixture(13));
      second = saveAppearance(rendered.current, appearanceFixture(14));
      third = saveAppearance(rendered.current, appearanceFixture(15));
      await Promise.resolve();
    });

    expectCanvasFontSize(rendered.current, 15);
    expect(savedFontSizes(globalSettingsSave)).toEqual([13]);

    await act(async () => {
      saves[0]!.resolve({ ok: true });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(savedFontSizes(globalSettingsSave)).toEqual([13, 15]);
    expectCanvasFontSize(rendered.current, 15);

    await act(async () => {
      saves[1]!.resolve({ ok: true });
      await Promise.all([first, second, third]);
    });

    expectCanvasFontSize(rendered.current, 15);
    await rendered.unmount();
  });

  it('keeps the submitted value after the response until a matching event arrives', async () => {
    const save = deferred<{ ok: true }>();
    const globalSettingsSave = vi.fn(() => save.promise);
    const rendered = await renderController(globalSettingsSave);

    let pending!: Promise<void>;
    await act(async () => {
      pending = saveAppearance(rendered.current, appearanceFixture(13));
      save.resolve({ ok: true });
      await pending;
    });

    await act(async () => {
      acceptAppearance(rendered.projection, appearanceFixture(14));
    });
    expectCanvasFontSize(rendered.current, 13);

    await act(async () => {
      acceptAppearance(rendered.projection, appearanceFixture(13));
    });
    expectCanvasFontSize(rendered.current, 13);

    await act(async () => {
      acceptAppearance(rendered.projection, appearanceFixture(16));
    });
    expectCanvasFontSize(rendered.current, 16);
    await rendered.unmount();
  });

  it('lets later Runtime events win when confirmation precedes the save response', async () => {
    const save = deferred<{ ok: true }>();
    const rendered = await renderController(vi.fn(() => save.promise));

    let pending!: Promise<void>;
    await act(async () => {
      pending = saveAppearance(rendered.current, appearanceFixture(13));
      acceptAppearance(rendered.projection, appearanceFixture(13));
      await Promise.resolve();
    });
    expectCanvasFontSize(rendered.current, 13);

    await act(async () => {
      save.resolve({ ok: true });
      await pending;
      acceptAppearance(rendered.projection, appearanceFixture(16));
    });

    expectCanvasFontSize(rendered.current, 16);
    await rendered.unmount();
  });

  it('retires an older awaiting confirmation when a newer submission is confirmed first', async () => {
    const secondSave = deferred<{ ok: true }>();
    let saveCount = 0;
    const globalSettingsSave = vi.fn(() => {
      saveCount += 1;
      return saveCount === 1
        ? Promise.resolve({ ok: true as const })
        : secondSave.promise;
    });
    const rendered = await renderController(globalSettingsSave);

    await act(async () => {
      await saveAppearance(rendered.current, appearanceFixture(13));
    });
    expectCanvasFontSize(rendered.current, 13);

    let pending!: Promise<void>;
    await act(async () => {
      pending = saveAppearance(rendered.current, appearanceFixture(14));
      acceptAppearance(rendered.projection, appearanceFixture(14));
      await Promise.resolve();
    });
    await act(async () => {
      secondSave.resolve({ ok: true });
      await pending;
      acceptAppearance(rendered.projection, appearanceFixture(16));
    });

    expect(savedFontSizes(globalSettingsSave)).toEqual([13, 14]);
    expectCanvasFontSize(rendered.current, 16);
    await rendered.unmount();
  });

  it('rejects the current and coalesced saves and restores the latest accepted value after failure', async () => {
    const save = deferred<{ ok: true }>();
    const globalSettingsSave = vi.fn(() => save.promise);
    const rendered = await renderController(globalSettingsSave);

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = saveAppearance(rendered.current, appearanceFixture(13));
      second = saveAppearance(rendered.current, appearanceFixture(14));
      void first.catch(() => undefined);
      void second.catch(() => undefined);
      acceptAppearance(rendered.projection, appearanceFixture(11));
      await Promise.resolve();
    });
    expectCanvasFontSize(rendered.current, 14);

    const failure = new Error('save failed');
    await act(async () => {
      save.reject(failure);
      await Promise.allSettled([first, second]);
    });

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(savedFontSizes(globalSettingsSave)).toEqual([13]);
    expectCanvasFontSize(rendered.current, 11);
    await rendered.unmount();
  });

  it('does not save a fully idle value that already matches the accepted projection', async () => {
    const globalSettingsSave = vi.fn(async () => ({ ok: true as const }));
    const rendered = await renderController(globalSettingsSave);

    await act(async () => {
      await saveAppearance(rendered.current, appearanceFixture(12));
    });

    expect(globalSettingsSave).not.toHaveBeenCalled();
    expectCanvasFontSize(rendered.current, 12);
    await rendered.unmount();
  });

  it('returns Integration diagnostics while Runtime owns Activity reporting', async () => {
    const integrationsRunOperation = vi.fn(async () => ({
      ok: false,
      integrationId: 'imagemagick' as const,
      operation: 'install' as const,
      diagnostic: {
        errorKind: 'nonzero_exit' as const,
        stderrTail: 'secret raw command output'
      }
    }));
    const rendered = await renderController(
      vi.fn(async () => ({ ok: true as const })),
      { integrationsRunOperation }
    );

    let result;
    await act(async () => {
      result = await rendered.current.actions.runIntegrationOperation({
        integrationId: 'imagemagick',
        operation: 'install'
      });
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      integrationId: 'imagemagick',
      operation: 'install'
    }));
    await rendered.unmount();
  });

  it('exposes the ordered Photoshop resource to Settings without local connection state', async () => {
    const rendered = await renderController(vi.fn(async () => ({ ok: true as const })));

    expect(rendered.current.photoshop).toEqual({
      status: 'ready',
      value: { status: 'off', transferActive: false, sessions: [] }
    });
    await act(async () => {
      rendered.projection.acceptEvent({
        type: 'photoshop.state.changed',
        revision: 1,
        state: { status: 'waiting', transferActive: false, sessions: [] }
      });
    });
    expect(rendered.current.photoshop).toEqual({
      status: 'ready',
      value: { status: 'waiting', transferActive: false, sessions: [] }
    });
    await rendered.unmount();
  });
});

async function renderController(
  globalSettingsSave: WorkbenchApiClient['globalSettingsSave'],
  options: {
    integrationsRunOperation?: WorkbenchApiClient['integrationsRunOperation'];
  } = {}
): Promise<{
  readonly current: WorkbenchSettingsController;
  projection: ReturnType<typeof createWorkbenchGlobalProjection>;
  unmount(): Promise<void>;
}> {
  const projection = createWorkbenchGlobalProjection();
  projection.acceptSnapshot({ revision: 0, settings: settingsFixture() });
  projection.acceptEvent({
    type: 'integrations.changed',
    revision: 0,
    integrations: { integrations: [], backends: [] }
  });
  projection.acceptEvent({
    type: 'photoshop.state.changed',
    revision: 0,
    state: { status: 'off', transferActive: false, sessions: [] }
  });
  const api = {
    globalSettingsSave,
    integrationsRescan: vi.fn(async () => ({ ok: true as const })),
    integrationsRunOperation: options.integrationsRunOperation ?? vi.fn(),
    checkProductUpdate: vi.fn(),
    applyProductUpdate: vi.fn(),
    revealModelApiKey: vi.fn()
  } as unknown as WorkbenchApiClient;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current!: WorkbenchSettingsController;

  function Probe(): null {
    const canvasGlobalSettings = useCanvasGlobalSettingsController({
      api,
      globalProjection: projection
    });
    current = useWorkbenchSettingsController({
      api,
      globalProjection: projection,
      canvasGlobalSettings
    });
    return null;
  }

  await act(async () => {
    root.render(<Probe />);
  });
  return {
    get current() {
      return current;
    },
    projection,
    unmount: () => unmount(root, container)
  };
}

function saveAppearance(
  controller: WorkbenchSettingsController,
  appearance: CanvasTextAppearance
): Promise<void> {
  return controller.actions.saveGlobalSettings({ canvas: { textAppearance: appearance } });
}

function acceptAppearance(
  projection: ReturnType<typeof createWorkbenchGlobalProjection>,
  appearance: CanvasTextAppearance
): void {
  const state = projection.getState();
  if (state.status === 'uninitialized') throw new Error('Expected initialized Global projection.');
  projection.acceptEvent({
    type: 'globalSettings.changed',
    revision: state.revision + 1,
    settings: settingsFixture(appearance)
  });
}

function expectCanvasFontSize(controller: WorkbenchSettingsController, fontSizePx: number): void {
  expect(controller.canvasTextAppearance.fontSizePx).toBe(fontSizePx);
  expect(controller.globalSettings.status).toBe('ready');
  if (controller.globalSettings.status === 'ready') {
    expect(controller.globalSettings.value.canvas.textAppearance.fontSizePx).toBe(fontSizePx);
  }
}

function savedFontSizes(save: ReturnType<typeof vi.fn>): number[] {
  return save.mock.calls.map(([input]) => (
    (input as { canvas: { textAppearance: CanvasTextAppearance } }).canvas.textAppearance.fontSizePx
  ));
}

async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function settingsFixture(
  appearance: CanvasTextAppearance = appearanceFixture(12)
): DebruteGlobalSettingsView {
  return {
    workbench: { locale: 'en', themePreference: 'dark' },
    canvas: { hierarchyEdgesVisible: true, textAppearance: appearance },
    chrome: { recentProjectRoots: [] },
    plugins: { photoshop: { enabled: false } },
    models: { image: [], video: [], audio: [] }
  };
}

function appearanceFixture(fontSizePx: number): CanvasTextAppearance {
  return {
    fontId: 'noto-sans-mono-cjk-sc',
    fontSizePx,
    lineHeightRatio: 1.4,
    fontWeight: 400,
    letterSpacingPx: 0,
    ligatures: true
  };
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
