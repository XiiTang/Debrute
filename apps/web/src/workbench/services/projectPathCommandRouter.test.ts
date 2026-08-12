import { describe, expect, it, vi } from 'vitest';
import type { ProjectExplorerController } from '../project-explorer/useProjectExplorerController';
import type { ProjectCommandGate } from './projectCommandGate';
import { createProjectPathCommandRouter } from './projectPathCommandRouter';

describe('ProjectPathCommandRouter', () => {
  it('closes the menu once and routes Explorer copy through the Controller', () => {
    const explorer = explorerFixture();
    const closeContextMenu = vi.fn();
    const router = createProjectPathCommandRouter(routerInput({ explorer, closeContextMenu }));
    const target = {
      source: 'explorer' as const,
      invocation: { projectRelativePath: 'a.png', kind: 'file' as const },
      selection: [{ projectRelativePath: 'a.png', kind: 'file' as const }]
    };

    router.run('copy', { target, position: { x: 1, y: 2 } });

    expect(closeContextMenu).toHaveBeenCalledTimes(1);
    expect(explorer.setClipboard).toHaveBeenCalledWith('copy', target.selection);
  });

  it('keeps terminal requests generation-local by storing only the cwd', () => {
    const openTerminalPanel = vi.fn();
    const router = createProjectPathCommandRouter(routerInput({ openTerminalPanel }));
    router.run('open-terminal', {
      target: {
        source: 'canvas',
        invocation: { projectRelativePath: 'dir/a.png', kind: 'file' },
        selection: [{ projectRelativePath: 'dir/a.png', kind: 'file' }]
      },
      position: { x: 0, y: 0 }
    });

    expect(openTerminalPanel).toHaveBeenCalledWith('dir');
  });

  it('disables Project actions when the command gate is unavailable', () => {
    const router = createProjectPathCommandRouter(routerInput({
      commandGate: { available: () => false, accept: () => undefined }
    }));
    const items = router.contextMenuItems({
      source: 'explorer',
      invocation: { projectRelativePath: 'a.png', kind: 'file' },
      selection: [{ projectRelativePath: 'a.png', kind: 'file' }]
    });

    expect(items.filter((item) => item.kind === 'action').every((item) => item.disabled)).toBe(true);
  });
});

function routerInput(overrides: Record<string, unknown> = {}) {
  return {
    commandGate: {
      available: () => true,
      accept: () => undefined
    } satisfies ProjectCommandGate,
    api: {
      copyProjectPathsToSystemClipboard: vi.fn(),
      sendProjectFileToPhotoshop: vi.fn()
    },
    projection: undefined,
    explorer: explorerFixture(),
    photoshop: undefined,
    activities: { report: vi.fn() },
    closeContextMenu: vi.fn(),
    openTerminalPanel: vi.fn(),
    revealInCanvas: vi.fn(),
    inspectEntries: vi.fn(),
    openInspectorPanel: vi.fn(),
    resetCanvasNodeLayouts: vi.fn(async () => undefined),
    confirmTrash: vi.fn(() => true),
    confirmPermanentDelete: vi.fn(() => true),
    ...overrides
  };
}

function explorerFixture(): ProjectExplorerController {
  return {
    state: {
      acceptedProjectRevision: 1,
      selection: { selectedPaths: [], focusedPath: null, anchorPath: null },
      expanded: new Set(),
      clipboard: undefined,
      edit: undefined
    },
    selection: { selectedPaths: [], focusedPath: null, anchorPath: null },
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
