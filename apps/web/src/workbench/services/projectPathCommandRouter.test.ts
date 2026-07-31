import { describe, expect, it, vi } from 'vitest';
import { createProjectPathCommandRouter } from './projectPathCommandRouter.js';
import type {
  AcceptedProjectPathCommandScope,
  ProjectPathCommandIntake
} from './projectPathCommandIntake.js';

describe('Project Path Command router', () => {
  it('derives Reveal in Canvas availability from the menu host live readiness', () => {
    const router = createProjectPathCommandRouter({
      commandIntake: commandIntake(() => true, () => true),
      commandEffects: commandEffectsFixture(),
      openTerminalPanel: vi.fn(),
      menuContext: {
        projection: {
          canvasId: 'canvas-1',
          nodes: [{
            projectRelativePath: 'brief.md',
            nodeKind: 'file',
            mediaKind: 'text',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            z: 0,
            availability: {
              state: 'available',
              fileUrl: '/brief.md',
              revision: '1',
              size: 1,
              mimeType: 'text/markdown'
            }
          }],
          edges: [],
          diagnostics: []
        },
        canSelectCanvasNode: true,
        fileClipboard: undefined,
        photoshop: undefined
      },
      commandContext: commandContextFixture()
    });
    const target = projectFileTarget();

    expect(revealItem(router.contextMenuItems(target, false))?.disabled).toBe(true);
    expect(revealItem(router.contextMenuItems(target, true))?.disabled).toBe(false);
  });

  it('disables and refuses commands once Project switching begins', () => {
    const closeContextMenu = vi.fn();
    const confirmPermanentDelete = vi.fn(() => true);
    const deleteEntriesPermanently = vi.fn();
    const router = createProjectPathCommandRouter({
      commandIntake: commandIntake(() => false, () => true),
      commandEffects: commandEffectsFixture(),
      openTerminalPanel: vi.fn(),
      menuContext: {
        projection: undefined,
        canSelectCanvasNode: false,
        fileClipboard: undefined,
        photoshop: undefined
      },
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
          deleteEntriesPermanently
        },
        copyText: vi.fn(),
        notify: vi.fn(),
        startNotification: () => vi.fn(),
        photoshopLabels: photoshopLabelsFixture(),
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

    expect(router.contextMenuItems(target, false).every((item) => (
      item.kind === 'separator'
        || (item.kind === 'action' ? item.disabled === true : item.targets.length === 0)
    ))).toBe(true);
    router.run('delete-permanently', {
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
    const router = createProjectPathCommandRouter({
      commandIntake: commandIntake(() => true, () => currentScope),
      commandEffects: commandEffectsFixture(),
      openTerminalPanel: vi.fn(),
      menuContext: {
        projection: undefined,
        canSelectCanvasNode: false,
        fileClipboard: undefined,
        photoshop: undefined
      },
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
          copyAbsolutePaths: () => requestCount++ === 0
            ? new Promise((resolve) => { resolvePaths = resolve; })
            : new Promise((_resolve, reject) => { rejectPaths = reject; }),
          revealEntry: vi.fn(),
          trashEntries: vi.fn(),
          deleteEntriesPermanently: vi.fn()
        },
        copyText,
        notify,
        startNotification: () => vi.fn(),
        photoshopLabels: photoshopLabelsFixture(),
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

    router.run('copy-path', {
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
    router.run('copy-path', {
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

  it('does not update a Photoshop command notification after its Project scope is replaced', async () => {
    let currentScope = true;
    let resolveSend!: (result: {
      commandId: string;
      documentTitle: string;
      fileName: string;
    }) => void;
    const updateNotification = vi.fn();
    const startNotification = vi.fn(() => updateNotification);
    const router = createProjectPathCommandRouter({
      commandIntake: commandIntake(() => true, () => currentScope),
      commandEffects: {
        ...commandEffectsFixture(),
        sendProjectFileToPhotoshop: () => new Promise((resolve) => {
          resolveSend = resolve;
        })
      },
      openTerminalPanel: vi.fn(),
      menuContext: {
        projection: undefined,
        canSelectCanvasNode: false,
        fileClipboard: undefined,
        photoshop: undefined
      },
      commandContext: {
        ...commandContextFixture(),
        startNotification
      }
    });

    router.run('send-to-photoshop', {
      target: projectFileTarget(),
      position: { x: 0, y: 0 }
    }, {
      pluginSessionId: 'session-1',
      documentId: 42,
      title: 'Poster.psd'
    });

    expect(startNotification).toHaveBeenCalledWith('Sending brief.md to Poster.psd');
    currentScope = false;
    resolveSend({
      commandId: 'command-1',
      documentTitle: 'Poster.psd',
      fileName: 'brief.md'
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(updateNotification).not.toHaveBeenCalled();
  });

  it('passes the one Router-accepted scope unchanged to Explorer commands', () => {
    const acceptedScope = {
      projectId: 'project-1',
      generation: 1,
      canSubmit: () => true,
      isCurrent: () => true
    } as AcceptedProjectPathCommandScope;
    const copyEntries = vi.fn();
    const router = createProjectPathCommandRouter({
      commandIntake: {
        canAccept: () => true,
        tryAccept: () => acceptedScope
      },
      commandEffects: commandEffectsFixture(),
      openTerminalPanel: vi.fn(),
      menuContext: {
        projection: undefined,
        canSelectCanvasNode: false,
        fileClipboard: undefined,
        photoshop: undefined
      },
      commandContext: {
        ...commandContextFixture(),
        explorerCommands: {
          ...commandContextFixture().explorerCommands,
          copyEntries
        }
      }
    });

    router.run('copy', {
      target: projectFileTarget(),
      position: { x: 0, y: 0 }
    });

    expect(copyEntries).toHaveBeenCalledOnce();
    expect(copyEntries.mock.calls[0]?.[0]).toBe(acceptedScope);
  });
});

function commandContextFixture() {
  return {
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
    photoshopLabels: photoshopLabelsFixture(),
    closeContextMenu: vi.fn(),
    openInspectorPanel: vi.fn(),
    confirmPermanentDelete: vi.fn(() => true),
    getProjectSnapshot: () => undefined,
    confirmMoveOverwrite: vi.fn(() => true),
    errorLabels: {
      copyPathFailed: 'Copy Path failed',
      resetAutoLayoutFailed: 'Reset auto layout failed'
    }
  };
}

function photoshopLabelsFixture() {
  return {
    sending: (path: string, title: string) => `Sending ${path} to ${title}`,
    sent: (path: string, title: string) => `Sent ${path} to ${title}`,
    failed: (message: string) => `Failed: ${message}`
  };
}

function projectFileTarget() {
  return {
    source: 'explorer' as const,
    targetKind: 'item' as const,
    paths: [{ projectRelativePath: 'brief.md', kind: 'file' as const }],
    primaryPath: 'brief.md',
    targetDirectoryPath: ''
  };
}

function revealItem(items: ReturnType<ReturnType<typeof createProjectPathCommandRouter>['contextMenuItems']>) {
  return items.find((item): item is Extract<(typeof items)[number], { kind: 'action' }> => (
    item.kind === 'action' && item.command === 'reveal-in-canvas'
  ));
}

function commandIntake(
  canAccept: () => boolean,
  isCurrent: () => boolean
): ProjectPathCommandIntake {
  return {
    canAccept,
    tryAccept: () => canAccept()
      ? ({
          projectId: 'project-1',
          generation: 1,
          canSubmit: canAccept,
          isCurrent
        } as AcceptedProjectPathCommandScope)
      : undefined
  };
}

function commandEffectsFixture() {
  return {
    sendProjectFileToPhotoshop: vi.fn(() => undefined),
    resetCanvasNodeLayouts: vi.fn(() => undefined)
  };
}
