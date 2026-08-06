import { describe, expect, it, vi } from 'vitest';
import type { AcceptedProjectPathCommandScope } from './projectPathCommandIntake.js';
import { createProjectPathCommandRouter } from './projectPathCommandRouter.js';

describe('ProjectPathCommandRouter', () => {
  it('disables menu commands when the shared intake cannot accept work', () => {
    const router = createProjectPathCommandRouter({
      commandIntake: { canAccept: () => false, tryAccept: () => undefined },
      commandEffects: {
        sendProjectFileToPhotoshop: () => undefined,
        copyProjectPathsToSystemClipboard: () => undefined
      },
      openTerminalPanel: vi.fn(),
      menuContext: { projection: undefined },
      commandContext: {
        activeProjection: undefined,
        activeCanvasRuntime: undefined,
        revealInCanvas: vi.fn(),
        fileClipboard: undefined,
        explorerCommands: {
          beginCreateFile: vi.fn(),
          beginCreateDirectory: vi.fn(),
          beginRename: vi.fn(),
          copyEntries: vi.fn(),
          cutEntries: vi.fn(),
          pasteEntries: vi.fn(),
          revealEntry: vi.fn(),
          trashEntries: vi.fn(),
          deleteEntriesPermanently: vi.fn()
        },
        activities: { report: vi.fn() },
        getProjectSnapshot: () => undefined,
        resetCanvasNodeLayouts: () => undefined,
        closeContextMenu: vi.fn(),
        openInspectorPanel: vi.fn(),
        confirmTrash: () => true,
        confirmPermanentDelete: () => true,
        confirmMoveOverwrite: () => true,
      }
    });
    const items = router.contextMenuItems({
      source: 'canvas',
      invocationEntry: { pathEntry: { projectRelativePath: 'a.png', kind: 'file' } },
      selectedEntries: [{ pathEntry: { projectRelativePath: 'a.png', kind: 'file' } }]
    });
    expect(items.filter((item) => item.kind === 'action').every((item) => item.disabled)).toBe(true);
  });

  it('passes its one accepted Project scope unchanged to a batch file command', () => {
    const acceptedScope = {
      bindingId: 'project-1',
      generation: 7,
      canSubmit: () => true,
      isCurrent: () => true
    } as AcceptedProjectPathCommandScope;
    const copyEntries = vi.fn();
    const router = createProjectPathCommandRouter({
      commandIntake: {
        canAccept: () => true,
        tryAccept: () => acceptedScope
      },
      commandEffects: {
        sendProjectFileToPhotoshop: () => undefined,
        copyProjectPathsToSystemClipboard: () => undefined
      },
      openTerminalPanel: vi.fn(),
      menuContext: { projection: undefined },
      commandContext: {
        activeProjection: undefined,
        activeCanvasRuntime: undefined,
        revealInCanvas: vi.fn(),
        fileClipboard: undefined,
        explorerCommands: {
          beginCreateFile: vi.fn(),
          beginCreateDirectory: vi.fn(),
          beginRename: vi.fn(),
          copyEntries,
          cutEntries: vi.fn(),
          pasteEntries: vi.fn(),
          revealEntry: vi.fn(),
          trashEntries: vi.fn(),
          deleteEntriesPermanently: vi.fn()
        },
        activities: { report: vi.fn() },
        getProjectSnapshot: () => undefined,
        resetCanvasNodeLayouts: () => undefined,
        closeContextMenu: vi.fn(),
        openInspectorPanel: vi.fn(),
        confirmTrash: () => true,
        confirmPermanentDelete: () => true,
        confirmMoveOverwrite: () => true,
      }
    });
    const target = {
      source: 'canvas' as const,
      invocationEntry: { pathEntry: { projectRelativePath: 'a.png', kind: 'file' as const } },
      selectedEntries: [{ pathEntry: { projectRelativePath: 'a.png', kind: 'file' as const } }]
    };

    router.run('copy', { target, position: { x: 0, y: 0 } });

    expect(copyEntries).toHaveBeenCalledOnce();
    expect(copyEntries.mock.calls[0]?.[0]).toBe(acceptedScope);
  });

  it('drops a late Project-scoped Activity report after its accepted scope is retired', async () => {
    let current = true;
    let rejectClipboard!: (error: Error) => void;
    const clipboard = new Promise<never>((_resolve, reject) => {
      rejectClipboard = reject;
    });
    const report = vi.fn();
    const acceptedScope = {
      bindingId: 'project-1',
      generation: 7,
      canSubmit: () => current,
      isCurrent: () => current
    } as AcceptedProjectPathCommandScope;
    const router = createProjectPathCommandRouter({
      commandIntake: {
        canAccept: () => current,
        tryAccept: () => current ? acceptedScope : undefined
      },
      commandEffects: {
        sendProjectFileToPhotoshop: () => undefined,
        copyProjectPathsToSystemClipboard: () => clipboard
      },
      openTerminalPanel: vi.fn(),
      menuContext: { projection: undefined },
      commandContext: {
        activeProjection: undefined,
        activeCanvasRuntime: undefined,
        revealInCanvas: vi.fn(),
        fileClipboard: undefined,
        explorerCommands: {
          beginCreateFile: vi.fn(),
          beginCreateDirectory: vi.fn(),
          beginRename: vi.fn(),
          copyEntries: vi.fn(),
          cutEntries: vi.fn(),
          pasteEntries: vi.fn(),
          revealEntry: vi.fn(),
          trashEntries: vi.fn(),
          deleteEntriesPermanently: vi.fn()
        },
        activities: { report },
        getProjectSnapshot: () => undefined,
        resetCanvasNodeLayouts: () => undefined,
        closeContextMenu: vi.fn(),
        openInspectorPanel: vi.fn(),
        confirmTrash: () => true,
        confirmPermanentDelete: () => true,
        confirmMoveOverwrite: () => true,
      }
    });
    const target = {
      source: 'canvas' as const,
      invocationEntry: { pathEntry: { projectRelativePath: 'a.png', kind: 'file' as const } },
      selectedEntries: [{ pathEntry: { projectRelativePath: 'a.png', kind: 'file' as const } }]
    };

    router.run('copy-path', { target, position: { x: 0, y: 0 } });
    current = false;
    rejectClipboard(new Error('old Project clipboard failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(report).not.toHaveBeenCalled();
  });
});
