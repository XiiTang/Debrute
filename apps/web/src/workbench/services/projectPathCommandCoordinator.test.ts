import { describe, expect, it, vi } from 'vitest';
import { createProjectPathCommandCoordinator } from './projectPathCommandCoordinator';

describe('Project Path Command coordinator', () => {
  it('disables and refuses commands once Project switching begins', () => {
    const closeContextMenu = vi.fn();
    const confirmPermanentDelete = vi.fn(() => true);
    const deleteEntriesPermanently = vi.fn();
    const coordinator = createProjectPathCommandCoordinator({
      canStartCommand: () => false,
      isCurrentScope: () => true,
      menuContext: {
        projection: undefined,
        canSelectCanvasNode: false,
        canRevealInCanvas: false,
        fileClipboard: undefined,
        adobeBridgeEnabled: false
      },
      commandContext: {
        activeProjection: undefined,
        activeCanvasRuntime: undefined,
        fileClipboard: undefined,
        actions: {} as never,
        explorerCommands: {
          beginCreateFile: vi.fn(),
          beginCreateDirectory: vi.fn(),
          beginRename: vi.fn(),
          copyEntries: vi.fn(),
          cutEntries: vi.fn(),
          pasteEntries: vi.fn(),
          copyAbsolutePaths: vi.fn(),
          revealEntry: vi.fn(),
          trashEntries: vi.fn(),
          deleteEntriesPermanently
        },
        copyText: vi.fn(),
        notify: vi.fn(),
        closeContextMenu,
        openInspectorPanel: vi.fn(),
        confirmPermanentDelete,
        getProjectSnapshot: () => undefined,
        confirmMoveOverwrite: vi.fn(() => true),
        errorLabels: {
          copyPathFailed: 'Copy Path failed',
          resetAutoLayoutFailed: 'Reset auto layout failed'
        }
      }
    });
    const target = {
      source: 'explorer' as const,
      targetKind: 'item' as const,
      paths: [{ projectRelativePath: 'brief.md', kind: 'file' as const }],
      primaryPath: 'brief.md',
      targetDirectoryPath: ''
    };

    expect(coordinator.contextMenuItems(target).every((item) => (
      item.kind === 'separator' || item.disabled === true
    ))).toBe(true);
    coordinator.run('delete-permanently', {
      target,
      position: { x: 0, y: 0 }
    });

    expect(confirmPermanentDelete).not.toHaveBeenCalled();
    expect(deleteEntriesPermanently).not.toHaveBeenCalled();
    expect(closeContextMenu).toHaveBeenCalledOnce();
  });

  it('suppresses asynchronous success and failure follow-up after the command Project scope is replaced', async () => {
    let currentScope = true;
    let resolvePaths!: (paths: string[]) => void;
    let rejectPaths!: (error: Error) => void;
    let requestCount = 0;
    const copyText = vi.fn();
    const notify = vi.fn();
    const coordinator = createProjectPathCommandCoordinator({
      canStartCommand: () => true,
      isCurrentScope: () => currentScope,
      menuContext: {
        projection: undefined,
        canSelectCanvasNode: false,
        canRevealInCanvas: false,
        fileClipboard: undefined,
        adobeBridgeEnabled: false
      },
      commandContext: {
        activeProjection: undefined,
        activeCanvasRuntime: undefined,
        fileClipboard: undefined,
        actions: {} as never,
        explorerCommands: {
          beginCreateFile: vi.fn(),
          beginCreateDirectory: vi.fn(),
          beginRename: vi.fn(),
          copyEntries: vi.fn(),
          cutEntries: vi.fn(),
          pasteEntries: vi.fn(),
          copyAbsolutePaths: () => requestCount++ === 0
            ? new Promise((resolve) => { resolvePaths = resolve; })
            : new Promise((_resolve, reject) => { rejectPaths = reject; }),
          revealEntry: vi.fn(),
          trashEntries: vi.fn(),
          deleteEntriesPermanently: vi.fn()
        },
        copyText,
        notify,
        closeContextMenu: vi.fn(),
        openInspectorPanel: vi.fn(),
        confirmPermanentDelete: vi.fn(() => true),
        getProjectSnapshot: () => undefined,
        confirmMoveOverwrite: vi.fn(() => true),
        errorLabels: {
          copyPathFailed: 'Copy Path failed',
          resetAutoLayoutFailed: 'Reset auto layout failed'
        }
      }
    });

    coordinator.run('copy-path', {
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'brief.md', kind: 'file' }],
        primaryPath: 'brief.md',
        targetDirectoryPath: ''
      },
      position: { x: 0, y: 0 }
    });
    currentScope = false;
    resolvePaths(['/projects/a/brief.md']);
    await Promise.resolve();
    await Promise.resolve();

    expect(copyText).not.toHaveBeenCalled();

    currentScope = true;
    coordinator.run('copy-path', {
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'brief.md', kind: 'file' }],
        primaryPath: 'brief.md',
        targetDirectoryPath: ''
      },
      position: { x: 0, y: 0 }
    });
    currentScope = false;
    rejectPaths(new Error('old Project path failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(notify).not.toHaveBeenCalled();
  });
});
