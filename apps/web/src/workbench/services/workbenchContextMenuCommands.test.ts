import { describe, expect, it, vi } from 'vitest';
import type { ProjectPathEntry } from '@debrute/app-protocol';
import type { AcceptedProjectPathCommandScope } from './projectPathCommandIntake.js';
import { runProjectPathCommand } from './workbenchContextMenuCommands.js';
import type { WorkbenchContextMenuTarget } from '../shell/contextMenu.js';

describe('workbench context menu commands', () => {
  it('uses folded roots for Copy but explicit sorted entries for Copy Relative Paths', () => {
    const copyEntries = vi.fn();
    const copyText = vi.fn();
    const target = canvasTarget('folder/a.png', [
      { projectRelativePath: 'folder/b.png', kind: 'file' },
      { projectRelativePath: 'folder', kind: 'directory' },
      { projectRelativePath: 'folder/a.png', kind: 'file' }
    ]);
    run({ command: 'copy', target, explorerCommands: { copyEntries } });
    expect(copyEntries.mock.calls[0]?.[1]).toEqual([{ projectRelativePath: 'folder', kind: 'directory' }]);

    run({ command: 'copy-relative-path', target, copyText });
    expect(copyText).toHaveBeenCalledWith('folder\nfolder/a.png\nfolder/b.png');
  });

  it('copies every explicit absolute path returned by Runtime in stable selection order', async () => {
    const copyAbsolutePaths = vi.fn(async (_scope: AcceptedProjectPathCommandScope, entries: ProjectPathEntry[]) => (
      entries.map((entry: { projectRelativePath: string }) => `/project/${entry.projectRelativePath}`)
    ));
    const copyText = vi.fn();
    run({
      command: 'copy-path',
      target: canvasTarget('b.png', [
        { projectRelativePath: 'b.png', kind: 'file' },
        { projectRelativePath: 'a.png', kind: 'file' }
      ]),
      explorerCommands: { copyAbsolutePaths },
      copyText
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(copyAbsolutePaths.mock.calls[0]?.[1].map((entry) => entry.projectRelativePath)).toEqual(['a.png', 'b.png']);
    expect(copyText).toHaveBeenCalledWith('/project/a.png\n/project/b.png');
  });

  it('uses the invocation entry for the one terminal and system reveal', () => {
    const openTerminalPanel = vi.fn();
    const revealEntry = vi.fn();
    const target = canvasTarget('folder/b.png', [
      { projectRelativePath: 'folder/a.png', kind: 'file' },
      { projectRelativePath: 'folder/b.png', kind: 'file' }
    ]);
    run({ command: 'open-terminal', target, openTerminalPanel });
    expect(openTerminalPanel).toHaveBeenCalledWith('folder');
    run({ command: 'reveal-in-system-file-manager', target, explorerCommands: { revealEntry } });
    expect(revealEntry.mock.calls[0]?.[1]).toMatchObject({ projectRelativePath: 'folder/b.png' });
  });

  it('confirms Trash and permanent deletion over the same effective batch', () => {
    const trashEntries = vi.fn();
    const deleteEntriesPermanently = vi.fn();
    const confirmTrash = vi.fn(() => true);
    const confirmPermanentDelete = vi.fn(() => true);
    const target = canvasTarget('folder', [
      { projectRelativePath: 'folder', kind: 'directory' },
      { projectRelativePath: 'folder/a.png', kind: 'file' }
    ]);
    run({ command: 'delete', target, explorerCommands: { trashEntries }, confirmTrash });
    run({
      command: 'delete-permanently',
      target,
      explorerCommands: { deleteEntriesPermanently },
      confirmPermanentDelete
    });
    const expected = [{ projectRelativePath: 'folder', kind: 'directory' }];
    expect(confirmTrash).toHaveBeenCalledWith({ entries: expected });
    expect(confirmPermanentDelete).toHaveBeenCalledWith({ entries: expected });
    expect(trashEntries.mock.calls[0]?.[1]).toEqual(expected);
    expect(deleteEntriesPermanently.mock.calls[0]?.[1]).toEqual(expected);
  });

  it('pastes only into the explicit Canvas directory invocation target', () => {
    const pasteEntries = vi.fn();
    const clipboard = {
      operation: 'copy' as const,
      entries: [{ projectRelativePath: 'source.png', kind: 'file' as const }]
    };
    run({
      command: 'paste',
      target: canvasTarget('assets', [{ projectRelativePath: 'assets', kind: 'directory' }]),
      fileClipboard: clipboard,
      explorerCommands: { pasteEntries }
    });
    expect(pasteEntries.mock.calls[0]?.[1]).toEqual({
      clipboard,
      targetDirectoryProjectRelativePath: 'assets'
    });

    run({
      command: 'paste',
      target: canvasTarget('assets/file.png', [{ projectRelativePath: 'assets/file.png', kind: 'file' }]),
      fileClipboard: clipboard,
      explorerCommands: { pasteEntries }
    });
    expect(pasteEntries).toHaveBeenCalledTimes(1);
  });

  it('resets exactly the selected Canvas nodes, preserves selection, and centers the invocation after confirmation', async () => {
    const resetCanvasNodeLayouts = vi.fn(() => Promise.resolve({
      projectId: 'project-1',
      projectRevision: 2,
      resetCount: 2
    }));
    const setSelection = vi.fn();
    const setCamera = vi.fn();
    const runtime = {
      setSelection,
      getSnapshot: () => ({ surfaceSize: { width: 400, height: 300 }, camera: { x: 0, y: 0, z: 2 } }),
      camera: { setCamera }
    };
    run({
      command: 'reset-auto-layout',
      target: canvasTarget('b.png', [
        { projectRelativePath: 'b.png', kind: 'file' },
        { projectRelativePath: 'a.png', kind: 'file' }
      ]),
      activeProjection: {
        canvasId: 'canvas-1',
        nodes: [node('a.png'), node('b.png')],
        edges: [],
        diagnostics: []
      },
      activeCanvasRuntime: runtime,
      resetCanvasNodeLayouts,
      getProjectSnapshot: () => ({
        projections: [{
          canvasId: 'canvas-1',
          nodes: [node('a.png'), { ...node('b.png'), x: 100, y: 200 }],
          edges: [],
          diagnostics: []
        }]
      } as never)
    });
    expect(resetCanvasNodeLayouts).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      nodePaths: ['a.png', 'b.png']
    });
    expect(setSelection).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(setCamera).toHaveBeenCalledWith({ x: -200, y: -370, z: 2 });
  });

  it('does not partially reset a selection with a target absent from the current Projection', () => {
    const resetCanvasNodeLayouts = vi.fn();
    run({
      command: 'reset-auto-layout',
      target: canvasTarget('a.png', [
        { projectRelativePath: 'a.png', kind: 'file' },
        { projectRelativePath: 'removed.png', kind: 'file' }
      ]),
      activeProjection: {
        canvasId: 'canvas-1',
        nodes: [node('a.png')],
        edges: [],
        diagnostics: []
      },
      resetCanvasNodeLayouts
    });

    expect(resetCanvasNodeLayouts).not.toHaveBeenCalled();
  });
});

function run(overrides: {
  command: Parameters<typeof runProjectPathCommand>[0]['command'];
  target: WorkbenchContextMenuTarget;
  explorerCommands?: Partial<Parameters<typeof runProjectPathCommand>[0]['explorerCommands']>;
  copyText?: Parameters<typeof runProjectPathCommand>[0]['copyText'];
  openTerminalPanel?: Parameters<typeof runProjectPathCommand>[0]['openTerminalPanel'];
  confirmTrash?: Parameters<typeof runProjectPathCommand>[0]['confirmTrash'];
  confirmPermanentDelete?: Parameters<typeof runProjectPathCommand>[0]['confirmPermanentDelete'];
  activeProjection?: Parameters<typeof runProjectPathCommand>[0]['activeProjection'];
  activeCanvasRuntime?: unknown;
  resetCanvasNodeLayouts?: Parameters<typeof runProjectPathCommand>[0]['resetCanvasNodeLayouts'];
  fileClipboard?: Parameters<typeof runProjectPathCommand>[0]['fileClipboard'];
  getProjectSnapshot?: Parameters<typeof runProjectPathCommand>[0]['getProjectSnapshot'];
}): void {
  const noop = () => undefined;
  runProjectPathCommand({
    scope: {
      projectId: 'project-1',
      generation: 1,
      canSubmit: () => true,
      isCurrent: () => true
    } as AcceptedProjectPathCommandScope,
    command: overrides.command,
    contextMenu: { target: overrides.target, position: { x: 0, y: 0 } },
    activeProjection: overrides.activeProjection,
    activeCanvasRuntime: overrides.activeCanvasRuntime as Parameters<typeof runProjectPathCommand>[0]['activeCanvasRuntime'],
    fileClipboard: overrides.fileClipboard,
    resetCanvasNodeLayouts: overrides.resetCanvasNodeLayouts ?? (() => undefined),
    openTerminalPanel: overrides.openTerminalPanel ?? noop,
    sendProjectFileToPhotoshop: () => undefined,
    explorerCommands: {
      beginCreateFile: noop,
      beginCreateDirectory: noop,
      beginRename: noop,
      copyEntries: noop,
      cutEntries: noop,
      pasteEntries: noop,
      copyAbsolutePaths: async () => undefined,
      revealEntry: noop,
      trashEntries: noop,
      deleteEntriesPermanently: noop,
      ...overrides.explorerCommands
    },
    copyText: overrides.copyText ?? noop,
    notify: noop,
    startNotification: () => noop,
    photoshopLabels: { sending: () => '', sent: () => '', failed: () => '' },
    closeContextMenu: noop,
    openInspectorPanel: noop,
    confirmTrash: overrides.confirmTrash ?? (() => true),
    confirmPermanentDelete: overrides.confirmPermanentDelete ?? (() => true),
    getProjectSnapshot: overrides.getProjectSnapshot ?? (() => undefined),
    confirmMoveOverwrite: () => true,
    errorLabels: { copyPathFailed: '', resetAutoLayoutFailed: '' }
  });
}

function canvasTarget(
  invocationPath: string,
  selectedEntries: WorkbenchContextMenuTarget['selectedEntries']
): WorkbenchContextMenuTarget {
  return {
    source: 'canvas',
    invocationEntry: selectedEntries.find((entry) => entry.projectRelativePath === invocationPath)!,
    selectedEntries
  };
}

function node(path: string) {
  return {
    projectRelativePath: path,
    nodeKind: 'file' as const,
    mediaKind: 'image' as const,
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    z: 0,
    layoutMode: 'manual' as const,
    availability: {
      state: 'available' as const,
      size: 10,
      mimeType: 'image/png',
      fileUrl: `/files/${path}`,
      revision: 'rev'
    }
  };
}
