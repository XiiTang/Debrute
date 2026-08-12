import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExplorerController } from '../project-explorer/useProjectExplorerController';
import { createWorkbenchFocusCommandRouter } from './workbenchFocusCommandRouter';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('WorkbenchFocusCommandRouter', () => {
  it('recognizes only the exact Explorer root as the Explorer owner', () => {
    const root = document.createElement('div');
    root.tabIndex = 0;
    const input = document.createElement('input');
    root.append(input);
    document.body.append(root);
    const router = createWorkbenchFocusCommandRouter(fixture({ getExplorerRoot: () => root }));

    root.focus();
    expect(router.captureOwner()).toBe('explorer');
    input.focus();
    expect(router.captureOwner()).toBe('other');
  });

  it('keeps inline input copy and paste native by declining other-owned commands', () => {
    const router = createWorkbenchFocusCommandRouter(fixture());

    expect(router.dispatch('copy', 'other')).toBe(false);
    expect(router.dispatch('paste', 'other')).toBe(false);
  });

  it('routes Explorer selection commands directly to its Controller', () => {
    const explorer = explorerFixture();
    const router = createWorkbenchFocusCommandRouter(fixture({
      getExplorerController: () => explorer
    }));

    expect(router.dispatch('select-all', 'explorer')).toBe(true);
    expect(explorer.handleEditCommand).toHaveBeenCalledWith('select-all');
  });
});

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    getRuntime: () => undefined,
    getProjection: () => undefined,
    getCanvasRoot: () => null,
    getExplorerRoot: () => null,
    getProjectPathRouter: () => undefined,
    getExplorerController: () => undefined,
    ...overrides
  };
}

function explorerFixture(): ProjectExplorerController {
  const selection = { selectedPaths: [], focusedPath: null, anchorPath: null };
  return {
    state: {
      acceptedProjectRevision: 1,
      selection,
      expanded: new Set(),
      clipboard: undefined,
      edit: undefined
    },
    selection,
    fileClipboard: undefined,
    inlineEdit: undefined,
    setSelection: vi.fn(),
    toggleDirectory: vi.fn(),
    beginCreate: vi.fn(),
    beginRename: vi.fn(),
    setClipboard: vi.fn(),
    paste: vi.fn(),
    transfer: vi.fn(),
    deleteEntries: vi.fn(),
    reveal: vi.fn(),
    externalDrop: vi.fn(),
    updateEditValue: vi.fn(),
    submitEdit: vi.fn(async () => undefined),
    cancelEdit: vi.fn(),
    handleEditCommand: vi.fn(),
    ensureDirectoryLoaded: vi.fn(async () => undefined)
  };
}
