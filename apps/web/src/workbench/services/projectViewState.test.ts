import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLOATING_PANEL_STATE } from '../shell/floatingPanels';
import {
  projectViewStateStorageKey,
  restoreProjectViewState,
  saveProjectViewState
} from './projectViewState';

describe('projectViewState', () => {
  it('saves and restores the complete current Project view state', () => {
    const storage = storageFixture();
    saveProjectViewState({
      storage,
      projectId: 'project-a',
      state: { activeCanvasId: 'canvas-2', floatingPanels: DEFAULT_FLOATING_PANEL_STATE }
    });

    expect(storage.setItem).toHaveBeenCalledWith(
      'debrute:project-view:project-a',
      JSON.stringify({ activeCanvasId: 'canvas-2', floatingPanels: DEFAULT_FLOATING_PANEL_STATE })
    );
    expect(restoreProjectViewState({ storage, projectId: 'project-a' })).toEqual({
      status: 'ready',
      state: { activeCanvasId: 'canvas-2', floatingPanels: DEFAULT_FLOATING_PANEL_STATE }
    });
  });

  it('distinguishes a first open from an invalid saved state', () => {
    const storage = storageFixture();

    expect(projectViewStateStorageKey('project-a')).toBe('debrute:project-view:project-a');
    expect(restoreProjectViewState({ storage, projectId: 'project-a' })).toEqual({ status: 'absent' });
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('accepts a complete snapshot without an active Canvas', () => {
    const storage = storageFixture();
    storage.setItem(projectViewStateStorageKey('project-a'), JSON.stringify({
      floatingPanels: DEFAULT_FLOATING_PANEL_STATE
    }));

    expect(restoreProjectViewState({ storage, projectId: 'project-a' })).toEqual({
      status: 'ready',
      state: { floatingPanels: DEFAULT_FLOATING_PANEL_STATE }
    });
  });

  it.each([
    ['malformed JSON', '{'],
    ['a missing floating-panel snapshot', JSON.stringify({ activeCanvasId: 'canvas-2' })],
    ['an unknown top-level field', JSON.stringify({
      activeCanvasId: 'canvas-2',
      floatingPanels: DEFAULT_FLOATING_PANEL_STATE,
      unexpectedField: 'sidebar'
    })],
    ['a missing panel', JSON.stringify({
      floatingPanels: {
        panels: {
          explorer: DEFAULT_FLOATING_PANEL_STATE.panels.explorer,
          inspector: DEFAULT_FLOATING_PANEL_STATE.panels.inspector,
          settings: DEFAULT_FLOATING_PANEL_STATE.panels.settings
        }
      }
    })],
    ['an unknown panel', JSON.stringify({
      floatingPanels: {
        panels: {
          ...DEFAULT_FLOATING_PANEL_STATE.panels,
          unexpectedPanel: DEFAULT_FLOATING_PANEL_STATE.panels.explorer
        }
      }
    })],
    ['an unknown layout field', JSON.stringify({
      floatingPanels: {
        panels: {
          ...DEFAULT_FLOATING_PANEL_STATE.panels,
          explorer: {
            ...DEFAULT_FLOATING_PANEL_STATE.panels.explorer,
            docked: true
          }
        }
      }
    })],
    ['a non-boolean open field', JSON.stringify({
      floatingPanels: {
        panels: {
          ...DEFAULT_FLOATING_PANEL_STATE.panels,
          explorer: {
            ...DEFAULT_FLOATING_PANEL_STATE.panels.explorer,
            open: 'yes'
          }
        }
      }
    })],
    ['a non-finite geometry field', JSON.stringify({
      floatingPanels: {
        panels: {
          ...DEFAULT_FLOATING_PANEL_STATE.panels,
          explorer: {
            ...DEFAULT_FLOATING_PANEL_STATE.panels.explorer,
            width: 320
          }
        }
      }
    }).replace('"width":320', '"width":1e999')]
  ])('rejects and removes %s instead of salvaging it', (_label, raw) => {
    const storage = storageFixture();
    const key = projectViewStateStorageKey('project-a');
    storage.setItem(key, raw);

    expect(restoreProjectViewState({ storage, projectId: 'project-a' })).toEqual({ status: 'invalid' });
    expect(storage.removeItem).toHaveBeenCalledWith(key);
    expect(storage.getItem(key)).toBeNull();
  });
});

function storageFixture() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    })
  };
}
