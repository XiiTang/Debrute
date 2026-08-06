import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLOATING_PANEL_STATE } from '../shell/floatingPanels';
import {
  restoreProjectViewState,
  saveProjectViewState
} from './projectViewState';

describe('projectViewState', () => {
  it('saves and restores the complete current Project view state', () => {
    const storage = storageFixture();
    saveProjectViewState({
      storage,
      canonicalRoot: 'project-a',
      state: { floatingPanels: DEFAULT_FLOATING_PANEL_STATE }
    });

    expect(restoreProjectViewState({ storage, canonicalRoot: 'project-a' }))
      .toEqual({ floatingPanels: DEFAULT_FLOATING_PANEL_STATE });
  });

  it('returns no state on first open', () => {
    const storage = storageFixture();

    expect(restoreProjectViewState({ storage, canonicalRoot: 'project-a' })).toBeUndefined();
  });

  it('does not protect malformed storage JSON', () => {
    const storage = storageFixture('{');
    expect(() => restoreProjectViewState({ storage, canonicalRoot: 'project-a' })).toThrow();
  });
});

function storageFixture(initialValue?: string) {
  const values = new Map<string, string>();
  let initial = initialValue;
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? initial ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    })
  };
}
