import { describe, expect, it, vi } from 'vitest';
import type { AcceptedProjectPathCommandScope } from './projectPathCommandIntake.js';
import { createProjectPathCommandRouter } from './projectPathCommandRouter.js';

describe('ProjectPathCommandRouter', () => {
  it('disables menu commands when the shared intake cannot accept work', () => {
    const router = createProjectPathCommandRouter({
      commandIntake: { canAccept: () => false, tryAccept: () => undefined },
      commandEffects: {
        sendProjectFileToPhotoshop: () => undefined,
        resetCanvasNodeLayouts: () => undefined
      },
      openTerminalPanel: vi.fn(),
      menuContext: { projection: undefined },
      commandContext: {
        activeProjection: undefined,
        activeCanvasRuntime: undefined,
        fileClipboard: undefined,
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
          deleteEntriesPermanently: vi.fn()
        },
        copyText: vi.fn(),
        notify: vi.fn(),
        startNotification: () => vi.fn(),
        getProjectSnapshot: () => undefined,
        photoshopLabels: { sending: () => '', sent: () => '', failed: () => '' },
        closeContextMenu: vi.fn(),
        openInspectorPanel: vi.fn(),
        confirmTrash: () => true,
        confirmPermanentDelete: () => true,
        confirmMoveOverwrite: () => true,
        errorLabels: { copyPathFailed: '', resetAutoLayoutFailed: '' }
      }
    });
    const items = router.contextMenuItems({
      source: 'canvas',
      invocationEntry: { projectRelativePath: 'a.png', kind: 'file' },
      selectedEntries: [{ projectRelativePath: 'a.png', kind: 'file' }]
    });
    expect(items.filter((item) => item.kind === 'action').every((item) => item.disabled)).toBe(true);
  });

  it('passes its one accepted Project scope unchanged to a batch file command', () => {
    const acceptedScope = {
      projectId: 'project-1',
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
        resetCanvasNodeLayouts: () => undefined
      },
      openTerminalPanel: vi.fn(),
      menuContext: { projection: undefined },
      commandContext: {
        activeProjection: undefined,
        activeCanvasRuntime: undefined,
        fileClipboard: undefined,
        explorerCommands: {
          beginCreateFile: vi.fn(),
          beginCreateDirectory: vi.fn(),
          beginRename: vi.fn(),
          copyEntries,
          cutEntries: vi.fn(),
          pasteEntries: vi.fn(),
          copyAbsolutePaths: vi.fn(),
          revealEntry: vi.fn(),
          trashEntries: vi.fn(),
          deleteEntriesPermanently: vi.fn()
        },
        copyText: vi.fn(),
        notify: vi.fn(),
        startNotification: () => vi.fn(),
        getProjectSnapshot: () => undefined,
        photoshopLabels: { sending: () => '', sent: () => '', failed: () => '' },
        closeContextMenu: vi.fn(),
        openInspectorPanel: vi.fn(),
        confirmTrash: () => true,
        confirmPermanentDelete: () => true,
        confirmMoveOverwrite: () => true,
        errorLabels: { copyPathFailed: '', resetAutoLayoutFailed: '' }
      }
    });
    const target = {
      source: 'canvas' as const,
      invocationEntry: { projectRelativePath: 'a.png', kind: 'file' as const },
      selectedEntries: [{ projectRelativePath: 'a.png', kind: 'file' as const }]
    };

    router.run('copy', { target, position: { x: 0, y: 0 } });

    expect(copyEntries).toHaveBeenCalledOnce();
    expect(copyEntries.mock.calls[0]?.[0]).toBe(acceptedScope);
  });
});
