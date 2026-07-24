import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLOATING_PANEL_STATE } from '../shell/floatingPanels';
import {
  loadProjectViewState,
  projectViewStateStorageKey,
  saveProjectViewState
} from './projectViewState';

describe('projectViewState', () => {
  it('keys active canvas by Project id in document sessionStorage', () => {
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
    expect(loadProjectViewState({
      storage,
      projectId: 'project-a'
    })).toEqual({ activeCanvasId: 'canvas-2', floatingPanels: DEFAULT_FLOATING_PANEL_STATE });
  });

  it('returns an empty state when no view state is saved', () => {
    const storage = storageFixture();
    storage.getItem.mockReturnValue(null);

    expect(projectViewStateStorageKey('project-a')).toBe('debrute:project-view:project-a');
    expect(loadProjectViewState({ storage, projectId: 'project-a' })).toEqual({});
  });
});

function storageFixture() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    })
  };
}
