import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type {
  CanvasTextAppearance,
  DebruteGlobalSettingsView,
  SaveDebruteGlobalSettingsInput
} from '@debrute/app-protocol';
import { createWorkbenchGlobalProjection } from './WorkbenchGlobalProjection.js';
import {
  useCanvasGlobalSettingsController,
  type CanvasGlobalSettingsController,
  type CanvasGlobalSettingsPatch
} from './useCanvasGlobalSettingsController.js';

describe('useCanvasGlobalSettingsController', { tags: ['settings'] }, () => {
  it('applies rapid mixed-field changes immediately and serializes the latest values', async () => {
    const saves: Array<ReturnType<typeof deferred<{ ok: true }>>> = [];
    const globalSettingsSave = vi.fn(() => {
      const save = deferred<{ ok: true }>();
      saves.push(save);
      return save.promise;
    });
    const rendered = await renderController({ globalSettingsSave });

    let hide!: Promise<void>;
    let show!: Promise<void>;
    let changeText!: Promise<void>;
    await act(async () => {
      hide = rendered.current.save({ hierarchyEdgesVisible: false });
      show = rendered.current.save({ hierarchyEdgesVisible: true });
      changeText = rendered.current.save({ textAppearance: appearanceFixture(13) });
      await Promise.resolve();
    });

    expect(rendered.current.settings).toEqual({
      hierarchyEdgesVisible: true,
      textAppearance: appearanceFixture(13)
    });
    expect(savedCanvasPatches(globalSettingsSave)).toEqual([
      { hierarchyEdgesVisible: false }
    ]);

    await act(async () => {
      rendered.acceptSettings({ hierarchyEdgesVisible: false });
      saves[0]!.resolve({ ok: true });
      await hide;
      await Promise.resolve();
    });

    expect(savedCanvasPatches(globalSettingsSave)).toEqual([
      { hierarchyEdgesVisible: false },
      {
        hierarchyEdgesVisible: true,
        textAppearance: appearanceFixture(13)
      }
    ]);
    expect(rendered.current.settings).toEqual({
      hierarchyEdgesVisible: true,
      textAppearance: appearanceFixture(13)
    });

    await act(async () => {
      rendered.acceptSettings({
        hierarchyEdgesVisible: true,
        textAppearance: appearanceFixture(13)
      });
      saves[1]!.resolve({ ok: true });
      await Promise.all([show, changeText]);
    });

    expect(rendered.current.settings).toEqual({
      hierarchyEdgesVisible: true,
      textAppearance: appearanceFixture(13)
    });
    await rendered.unmount();
  });

  it('keeps an acknowledged optimistic value until its event and then follows later windows', async () => {
    const save = deferred<{ ok: true }>();
    const rendered = await renderController({
      globalSettingsSave: vi.fn(() => save.promise)
    });

    let pending!: Promise<void>;
    await act(async () => {
      pending = rendered.current.save({ hierarchyEdgesVisible: false });
      save.resolve({ ok: true });
      await pending;
    });
    expect(rendered.current.settings.hierarchyEdgesVisible).toBe(false);

    await act(async () => {
      rendered.acceptSettings({ hierarchyEdgesVisible: true });
    });
    expect(rendered.current.settings.hierarchyEdgesVisible).toBe(false);

    await act(async () => {
      rendered.acceptSettings({ hierarchyEdgesVisible: false });
    });
    expect(rendered.current.settings.hierarchyEdgesVisible).toBe(false);

    await act(async () => {
      rendered.acceptSettings({ hierarchyEdgesVisible: true });
    });
    expect(rendered.current.settings.hierarchyEdgesVisible).toBe(true);
    await rendered.unmount();
  });

  it('rolls a failed chain back to the latest Runtime value and reports once', async () => {
    const save = deferred<{ ok: true }>();
    const failure = new Error('save failed');
    const onSaveError = vi.fn();
    const globalSettingsSave = vi.fn(() => save.promise);
    const rendered = await renderController({ globalSettingsSave, onSaveError });

    let hide!: Promise<void>;
    let show!: Promise<void>;
    await act(async () => {
      hide = rendered.current.save({ hierarchyEdgesVisible: false });
      show = rendered.current.save({ hierarchyEdgesVisible: true });
      void hide.catch(() => undefined);
      void show.catch(() => undefined);
      rendered.acceptSettings({
        hierarchyEdgesVisible: false,
        textAppearance: appearanceFixture(11)
      });
      await Promise.resolve();
    });
    expect(rendered.current.settings.hierarchyEdgesVisible).toBe(true);

    await act(async () => {
      save.reject(failure);
      await Promise.allSettled([hide, show]);
    });

    await expect(hide).rejects.toBe(failure);
    await expect(show).rejects.toBe(failure);
    expect(globalSettingsSave).toHaveBeenCalledOnce();
    expect(rendered.current.settings).toEqual({
      hierarchyEdgesVisible: false,
      textAppearance: appearanceFixture(11)
    });
    expect(onSaveError).toHaveBeenCalledOnce();
    expect(onSaveError).toHaveBeenCalledWith(failure, { hierarchyEdgesVisible: true });
    await rendered.unmount();
  });

  it('does not save an idle value that already matches Runtime', async () => {
    const globalSettingsSave = vi.fn(async () => ({ ok: true as const }));
    const rendered = await renderController({ globalSettingsSave });

    await act(async () => {
      await rendered.current.save({ hierarchyEdgesVisible: true });
    });

    expect(globalSettingsSave).not.toHaveBeenCalled();
    await rendered.unmount();
  });
});

async function renderController(input: {
  globalSettingsSave(input: SaveDebruteGlobalSettingsInput): Promise<{ ok: true }>;
  onSaveError?: ((error: unknown, patch: CanvasGlobalSettingsPatch) => void) | undefined;
}): Promise<{
  readonly current: CanvasGlobalSettingsController;
  acceptSettings(patch: CanvasGlobalSettingsPatch): void;
  unmount(): Promise<void>;
}> {
  const projection = createWorkbenchGlobalProjection();
  let accepted = settingsFixture();
  projection.acceptSnapshot({ revision: 0, settings: accepted });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current!: CanvasGlobalSettingsController;

  function Probe(): null {
    current = useCanvasGlobalSettingsController({
      api: { globalSettingsSave: input.globalSettingsSave },
      globalProjection: projection,
      onSaveError: input.onSaveError
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
    acceptSettings(patch) {
      accepted = {
        ...accepted,
        canvas: { ...accepted.canvas, ...patch }
      };
      const state = projection.getState();
      if (state.status === 'uninitialized') {
        throw new Error('Expected initialized Global projection.');
      }
      projection.acceptEvent({
        type: 'globalSettings.changed',
        revision: state.revision + 1,
        settings: accepted
      });
    },
    unmount: () => unmount(root, container)
  };
}

function savedCanvasPatches(save: ReturnType<typeof vi.fn>): CanvasGlobalSettingsPatch[] {
  return save.mock.calls.map(([input]) => (
    (input as SaveDebruteGlobalSettingsInput).canvas ?? {}
  ));
}

async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function settingsFixture(): DebruteGlobalSettingsView {
  return {
    workbench: { locale: 'en', themePreference: 'dark' },
    canvas: {
      hierarchyEdgesVisible: true,
      textAppearance: appearanceFixture(12)
    },
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
