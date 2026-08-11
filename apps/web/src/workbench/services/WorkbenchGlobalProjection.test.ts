import { describe, expect, it } from 'vitest';
import type {
  DebruteGlobalSettingsView,
  PhotoshopStateView
} from '@debrute/app-protocol';
import { createWorkbenchGlobalProjection } from './WorkbenchGlobalProjection';

describe('WorkbenchGlobalProjection', () => {
  it('retains initial resources before any presentation subscribes', () => {
    const projection = createWorkbenchGlobalProjection();
    const settings = settingsFixture();

    projection.acceptSnapshot({ revision: 4, settings });
    projection.acceptEvent({
      type: 'product.changed',
      revision: 4,
      product: null
    });
    projection.acceptEvent({
      type: 'photoshop.state.changed',
      revision: 4,
      state: photoshopFixture()
    });
    expect(projection.getState()).toEqual({
      status: 'active',
      revision: 4,
      settings,
      photoshop: { status: 'ready', value: photoshopFixture() },
      product: { status: 'ready', value: null }
    });
  });

  it('accepts one contiguous revision for every later Global change', () => {
    const projection = createWorkbenchGlobalProjection();
    projection.acceptSnapshot({ revision: 7, settings: settingsFixture() });

    projection.acceptEvent({
      type: 'globalSettings.changed',
      revision: 8,
      settings: settingsFixture('zh-CN')
    });
    projection.acceptEvent({
      type: 'recentProjects.changed',
      revision: 9,
      recentProjectRoots: ['/project-one']
    });

    const state = projection.getState();
    expect(state).toMatchObject({
      status: 'active',
      revision: 9,
      settings: {
        workbench: { locale: 'zh-CN' },
        chrome: { recentProjectRoots: ['/project-one'] }
      }
    });
  });

  it('fails closed on a Global revision gap and retains the last accepted projection', () => {
    const projection = createWorkbenchGlobalProjection();
    projection.acceptSnapshot({ revision: 3, settings: settingsFixture() });

    expect(() => projection.acceptEvent({
      type: 'globalSettings.changed',
      revision: 5,
      settings: settingsFixture('zh-CN')
    })).toThrow('Expected Global revision 4, received 5.');

    expect(projection.getState()).toMatchObject({
      status: 'failed',
      revision: 3,
      settings: { workbench: { locale: 'en' } },
      error: { message: 'Expected Global revision 4, received 5.' }
    });
  });

  it('hydrates Photoshop state only through its ordered event', () => {
    const projection = createWorkbenchGlobalProjection();
    projection.acceptSnapshot({ revision: 10, settings: settingsFixture() });
    projection.acceptEvent({
      type: 'photoshop.state.changed',
      revision: 10,
      state: photoshopFixture()
    });
    expect(projection.getState()).toMatchObject({
      status: 'active',
      revision: 10,
      photoshop: { status: 'ready' }
    });
  });
});

function settingsFixture(locale: 'en' | 'zh-CN' = 'en'): DebruteGlobalSettingsView {
  return {
    workbench: { locale, themePreference: 'dark' },
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

function photoshopFixture(): PhotoshopStateView {
  return {
    status: 'off',
    transferActive: false,
    sessions: []
  };
}
