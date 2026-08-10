import { describe, expect, it, vi } from 'vitest';
import type { DebruteGlobalSettingsView } from '@debrute/app-protocol';
import { createWorkbenchGlobalProjection } from '../workbench/services/WorkbenchGlobalProjection.js';
import { holdWorkbenchThemeUntilCommit } from './workbenchBootstrapTheme.js';

describe('Workbench bootstrap theme', () => {
  it('keeps ordered Global theme events applied until React takes ownership', () => {
    const projection = createWorkbenchGlobalProjection();
    projection.acceptSnapshot({ revision: 4, settings: settingsFixture('light') });
    const applied: string[] = [];
    const reveal = vi.fn();
    const complete = holdWorkbenchThemeUntilCommit({
      projection,
      apply: (theme) => applied.push(theme),
      reveal
    });

    projection.acceptEvent({
      type: 'globalSettings.changed',
      revision: 5,
      settings: settingsFixture('dark')
    });
    complete();

    expect(applied.at(-1)).toBe('dark');
    expect(reveal).toHaveBeenCalledOnce();
  });
});

function settingsFixture(themePreference: 'light' | 'dark'): DebruteGlobalSettingsView {
  return {
    workbench: { locale: 'en', themePreference },
    canvas: {
      hierarchyEdgesVisible: true,
      textAppearance: {
        fontId: 'noto-sans-mono-cjk-sc',
        fontSizePx: 12,
        lineHeightRatio: 1.4,
        fontWeight: 400,
        letterSpacingPx: 0,
        ligatures: true
      }
    },
    chrome: { recentProjectRoots: [] },
    plugins: { photoshop: { enabled: false } },
    feedback: { catalog: [], actionBar: [] },
    models: { image: [], video: [], audio: [] }
  };
}
