import { describe, expect, it, vi } from 'vitest';
import type { ProjectPathEntry } from '@debrute/app-protocol';
import type { AcceptedProjectPathCommandScope } from './projectPathCommandIntake.js';
import { runProjectPathCommand } from './workbenchContextMenuCommands.js';
import type { WorkbenchContextMenuTarget } from '../shell/contextMenu.js';

describe('workbench context menu commands', () => {
  it('uses folded roots for Copy but explicit sorted entries for Copy Relative Paths', () => {
    const copyEntries = vi.fn();
    const cutEntries = vi.fn();
    const copyProjectPathsToSystemClipboard = vi.fn(async () => ({ ok: true as const }));
    const target = canvasTarget('folder/a.png', [
      { projectRelativePath: 'folder/b.png', kind: 'file', availability: 'available' },
      { projectRelativePath: 'folder', kind: 'directory', availability: 'available' },
      { projectRelativePath: 'folder/a.png', kind: 'file', availability: 'available' }
    ]);
    run({ command: 'copy', target, explorerCommands: { copyEntries } });
    expect(copyEntries.mock.calls[0]?.[1]).toEqual([{ projectRelativePath: 'folder', kind: 'directory' }]);
    run({ command: 'cut', target, explorerCommands: { cutEntries } });
    expect(cutEntries.mock.calls[0]?.[1]).toEqual([{ projectRelativePath: 'folder', kind: 'directory' }]);

    run({ command: 'copy-relative-path', target, copyProjectPathsToSystemClipboard });
    expect(copyProjectPathsToSystemClipboard).toHaveBeenCalledWith({
      format: 'relative',
      entries: [
        { projectRelativePath: 'folder', kind: 'directory' },
        { projectRelativePath: 'folder/a.png', kind: 'file' },
        { projectRelativePath: 'folder/b.png', kind: 'file' }
      ]
    });
  });

  it('asks Runtime to copy every explicit absolute path in stable selection order', () => {
    const copyProjectPathsToSystemClipboard = vi.fn(async () => ({ ok: true as const }));
    run({
      command: 'copy-path',
      target: canvasTarget('b.png', [
        { projectRelativePath: 'b.png', kind: 'file', availability: 'available' },
        { projectRelativePath: 'a.png', kind: 'file', availability: 'available' }
      ]),
      copyProjectPathsToSystemClipboard
    });

    expect(copyProjectPathsToSystemClipboard).toHaveBeenCalledWith({
      format: 'absolute',
      entries: [
        { projectRelativePath: 'a.png', kind: 'file' },
        { projectRelativePath: 'b.png', kind: 'file' }
      ]
    });
  });

  it('reports a concise Runtime system clipboard failure without attempting a Web clipboard fallback', async () => {
    const notify = vi.fn();
    run({
      command: 'copy-relative-path',
      target: canvasTarget('a.png', [{ projectRelativePath: 'a.png', kind: 'file' }]),
      copyProjectPathsToSystemClipboard: async () => {
        throw new Error('native clipboard unavailable');
      },
      notify
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(notify).toHaveBeenCalledWith({
      kind: 'canvas-operation-failed',
      operation: 'copy-path'
    });
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

  it('dispatches Reveal in Canvas for the Explorer invocation entry', () => {
    const revealInCanvas = vi.fn();
    run({
      command: 'reveal-in-canvas',
      target: {
        source: 'explorer',
        invocationEntry: {
          pathEntry: { projectRelativePath: 'folder/a.png', kind: 'file' }
        },
        selectedEntries: [{
          pathEntry: { projectRelativePath: 'folder/a.png', kind: 'file' }
        }]
      },
      revealInCanvas
    });
    expect(revealInCanvas).toHaveBeenCalledWith('folder/a.png');
  });

  it('confirms Trash and permanent deletion over the same effective batch', () => {
    const trashEntries = vi.fn();
    const deleteEntriesPermanently = vi.fn();
    const confirmTrash = vi.fn(() => true);
    const confirmPermanentDelete = vi.fn(() => true);
    const target = canvasTarget('folder', [
      { projectRelativePath: 'folder', kind: 'directory', availability: 'available' },
      { projectRelativePath: 'folder/a.png', kind: 'file', availability: 'available' }
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

  it('resets exactly the selected Canvas nodes and preserves selection', async () => {
    const resetCanvasNodeLayouts = vi.fn(async () => undefined);
    const setSelection = vi.fn();
    const runtime = {
      setSelection,
      getSnapshot: () => ({ surfaceSize: { width: 400, height: 300 }, camera: { x: 0, y: 0, z: 2 } }),
      camera: { setCamera: vi.fn() }
    };
    run({
      command: 'reset-auto-layout',
      target: canvasTarget('b.png', [
        { projectRelativePath: 'b.png', kind: 'file' },
        { projectRelativePath: 'a.png', kind: 'file' }
      ]),
      canvasProjection: {
        nodes: [node('a.png'), node('b.png')],
        edges: [],
        diagnostics: []
      },
      canvasRuntime: runtime,
      resetCanvasNodeLayouts
    });
    expect(resetCanvasNodeLayouts).toHaveBeenCalledWith(['a.png', 'b.png']);
    expect(setSelection).not.toHaveBeenCalled();
  });

  it('does not partially reset a selection with a target absent from the current Projection', () => {
    const resetCanvasNodeLayouts = vi.fn();
    run({
      command: 'reset-auto-layout',
      target: canvasTarget('a.png', [
        { projectRelativePath: 'a.png', kind: 'file' },
        { projectRelativePath: 'removed.png', kind: 'file' }
      ]),
      canvasProjection: {
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
  copyProjectPathsToSystemClipboard?: Parameters<typeof runProjectPathCommand>[0]['copyProjectPathsToSystemClipboard'];
  openTerminalPanel?: Parameters<typeof runProjectPathCommand>[0]['openTerminalPanel'];
  confirmTrash?: Parameters<typeof runProjectPathCommand>[0]['confirmTrash'];
  confirmPermanentDelete?: Parameters<typeof runProjectPathCommand>[0]['confirmPermanentDelete'];
  canvasProjection?: Parameters<typeof runProjectPathCommand>[0]['canvasProjection'];
  canvasRuntime?: unknown;
  resetCanvasNodeLayouts?: Parameters<typeof runProjectPathCommand>[0]['resetCanvasNodeLayouts'];
  fileClipboard?: Parameters<typeof runProjectPathCommand>[0]['fileClipboard'];
  getProjectSnapshot?: Parameters<typeof runProjectPathCommand>[0]['getProjectSnapshot'];
  revealInCanvas?: Parameters<typeof runProjectPathCommand>[0]['revealInCanvas'];
  notify?: (input: Parameters<Parameters<typeof runProjectPathCommand>[0]['activities']['report']>[0]) => void;
}): void {
  const noop = () => undefined;
  runProjectPathCommand({
    scope: {
      bindingId: 'project-1',
      generation: 1,
      canSubmit: () => true,
      isCurrent: () => true
    } as AcceptedProjectPathCommandScope,
    command: overrides.command,
    contextMenu: { target: overrides.target, position: { x: 0, y: 0 } },
    canvasProjection: overrides.canvasProjection,
    canvasRuntime: overrides.canvasRuntime as Parameters<typeof runProjectPathCommand>[0]['canvasRuntime'],
    revealInCanvas: overrides.revealInCanvas ?? noop,
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
      revealEntry: noop,
      trashEntries: noop,
      deleteEntriesPermanently: noop,
      ...overrides.explorerCommands
    },
    copyProjectPathsToSystemClipboard: overrides.copyProjectPathsToSystemClipboard ?? (async () => ({ ok: true })),
    activities: {
      report: (input) => (overrides.notify ?? noop)(input)
    },
    closeContextMenu: noop,
    openInspectorPanel: noop,
    confirmTrash: overrides.confirmTrash ?? (() => true),
    confirmPermanentDelete: overrides.confirmPermanentDelete ?? (() => true),
    getProjectSnapshot: overrides.getProjectSnapshot ?? (() => undefined),
    confirmMoveOverwrite: () => true
  });
}

function canvasTarget(
  invocationPath: string,
  selectedEntries: Array<ProjectPathEntry & {
    availability?: 'available' | 'missing' | 'unreadable';
  }>
): WorkbenchContextMenuTarget {
  const candidates = selectedEntries.map((entry) => ({
    pathEntry: {
      projectRelativePath: entry.projectRelativePath,
      kind: entry.kind,
      ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes })
    },
    ...(entry.availability === undefined ? {} : { availability: entry.availability })
  }));
  return {
    source: 'canvas',
    invocationEntry: candidates.find((candidate) => (
      candidate.pathEntry.projectRelativePath === invocationPath
    ))!,
    selectedEntries: candidates
  };
}

function node(path: string) {
  return {
    projectRelativePath: path,
    displayName: path,
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
