import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { DebruteGlobalSettingsView } from '@debrute/app-protocol';
import { createWorkbenchGlobalProjection } from './WorkbenchGlobalProjection.js';
import {
  useWorkbenchPresentationController,
  type WorkbenchPresentationController
} from './useWorkbenchPresentationController.js';

describe('useWorkbenchPresentationController', () => {
  it('applies ordered Runtime settings while the Settings feature is absent', async () => {
    const projection = createWorkbenchGlobalProjection();
    projection.acceptSnapshot({ revision: 2, settings: settingsFixture('en', 'dark') });
    const renderedThemes: string[] = [];
    const probe = await renderController(projection, (controller) => {
      renderedThemes.push(
        `${controller.settings.workbench.themePreference}:${controller.resolvedTheme}`
      );
    });

    expect(probe.current.locale).toBe('en');
    expect(probe.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    await act(async () => {
      projection.acceptEvent({
        type: 'globalSettings.changed',
        revision: 3,
        settings: settingsFixture('zh-CN', 'light')
      });
    });

    expect(probe.current.locale).toBe('zh-CN');
    expect(probe.current.getCurrentI18n().locale).toBe('zh-CN');
    expect(probe.current.resolvedTheme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(renderedThemes).not.toContain('light:dark');
    await probe.unmount();
  });
});

async function renderController(
  globalProjection: ReturnType<typeof createWorkbenchGlobalProjection>,
  onRender: (controller: WorkbenchPresentationController) => void = () => undefined
): Promise<{
  readonly current: WorkbenchPresentationController;
  unmount(): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let current!: WorkbenchPresentationController;

  function Probe(): null {
    const controller = useWorkbenchPresentationController({ globalProjection });
    onRender(controller);
    useEffect(() => {
      current = controller;
    }, [controller]);
    current = controller;
    return null;
  }

  await act(async () => {
    root.render(<Probe />);
  });
  return {
    get current() {
      return current;
    },
    unmount: () => unmount(root, container)
  };
}

async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function settingsFixture(
  locale: 'en' | 'zh-CN',
  themePreference: 'dark' | 'light'
): DebruteGlobalSettingsView {
  return {
    workbench: { locale, themePreference, defaultFrontend: 'desktop' },
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
    models: { image: [], video: [], audio: [] }
  };
}
