import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { WorkbenchContextMenuCommand } from '../shell/contextMenu';
import { runWorkbenchContextMenuCommand } from './workbenchContextMenuCommands';

describe('workbench context menu commands', () => {
  it('confirms permanent delete before deleting', () => {
    const deleteProjectPathsPermanently = vi.fn(async () => ({
      results: [],
      snapshot: snapshotFixture()
    }));
    runWorkbenchContextMenuCommand(commandInput({
      command: 'delete-permanently',
      actions: {
        deleteProjectPathsPermanently
      },
      confirmPermanentDelete: () => false
    }));

    expect(deleteProjectPathsPermanently).not.toHaveBeenCalled();
  });

  it('runs trash delete for the visible Delete command', () => {
    const trashProjectPaths = vi.fn(async () => ({
      results: [{
        sourceProjectRelativePath: 'briefs/concept.md',
        projectRelativePath: 'briefs/concept.md',
        kind: 'file' as const,
        status: 'ok' as const
      }],
      snapshot: snapshotFixture()
    }));
    runWorkbenchContextMenuCommand(commandInput({
      command: 'delete',
      actions: {
        trashProjectPaths
      }
    }));

    expect(trashProjectPaths).toHaveBeenCalledWith({
      entries: [{ projectRelativePath: 'briefs/concept.md', kind: 'file' }]
    });
  });

  it('does not run item commands for the Project Tree root target', () => {
    const setFileClipboard = vi.fn();
    const trashProjectPaths = vi.fn(async () => ({
      results: [],
      snapshot: snapshotFixture()
    }));

    runWorkbenchContextMenuCommand(commandInput({
      command: 'copy',
      target: rootTarget(),
      actions: {
        trashProjectPaths
      },
      setFileClipboard
    }));
    runWorkbenchContextMenuCommand(commandInput({
      command: 'delete',
      target: rootTarget(),
      actions: {
        trashProjectPaths
      },
      setFileClipboard
    }));

    expect(setFileClipboard).not.toHaveBeenCalled();
    expect(trashProjectPaths).not.toHaveBeenCalled();
  });

  it('copies daemon-returned absolute paths for Copy Path', async () => {
    const copiedText: string[] = [];
    const copyProjectAbsolutePaths = vi.fn(async () => ({
      paths: ['/tmp/debrute-project/briefs/concept.md', '/tmp/debrute-project/assets']
    }));

    runWorkbenchContextMenuCommand(commandInput({
      command: 'copy-path',
      actions: {
        copyProjectAbsolutePaths
      },
      target: {
        source: 'explorer',
        targetKind: 'selection',
        paths: [
          { projectRelativePath: 'briefs/concept.md', kind: 'file' },
          { projectRelativePath: 'assets', kind: 'directory' }
        ],
        primaryPath: 'briefs/concept.md',
        targetDirectoryPath: ''
      },
      copyText: (text) => {
        copiedText.push(text);
      }
    }));

    await Promise.resolve();

    expect(copyProjectAbsolutePaths).toHaveBeenCalledWith({
      entries: [
        { projectRelativePath: 'briefs/concept.md', kind: 'file' },
        { projectRelativePath: 'assets', kind: 'directory' }
      ]
    });
    expect(copiedText).toEqual(['/tmp/debrute-project/briefs/concept.md\n/tmp/debrute-project/assets']);
  });

  it('does not paste when the internal clipboard has no entries', async () => {
    const copyProjectPaths = vi.fn(async () => ({
      results: [],
      snapshot: snapshotFixture()
    }));

    runWorkbenchContextMenuCommand(commandInput({
      command: 'paste',
      actions: {
        copyProjectPaths
      },
      fileClipboard: {
        operation: 'copy',
        entries: []
      },
      target: rootTarget()
    }));

    await Promise.resolve();

    expect(copyProjectPaths).not.toHaveBeenCalled();
  });

  it('confirms and overwrites conflicting cut paste targets', async () => {
    const moveProjectPaths = vi.fn(async () => ({
      results: [{
        sourceProjectRelativePath: 'cover.png',
        projectRelativePath: 'assets/cover.png',
        kind: 'file' as const,
        status: 'ok' as const
      }],
      snapshot: snapshotFixture()
    }));
    const confirmMoveOverwrite = vi.fn(() => true);

    runWorkbenchContextMenuCommand(commandInput({
      command: 'paste',
      actions: {
        moveProjectPaths
      },
      fileClipboard: {
        operation: 'cut',
        entries: [{ projectRelativePath: 'cover.png', kind: 'file' }]
      },
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'assets', kind: 'directory' }],
        primaryPath: 'assets',
        targetDirectoryPath: 'assets'
      },
      snapshot: snapshotFixture({
        files: [
          { projectRelativePath: 'cover.png', kind: 'file' },
          { projectRelativePath: 'assets', kind: 'directory' },
          { projectRelativePath: 'assets/cover.png', kind: 'file' }
        ]
      }),
      confirmMoveOverwrite
    }));

    await Promise.resolve();
    await Promise.resolve();

    expect(confirmMoveOverwrite).toHaveBeenCalledWith({
      entries: [{ projectRelativePath: 'cover.png', kind: 'file' }],
      targetDirectoryProjectRelativePath: 'assets'
    });
    expect(moveProjectPaths).toHaveBeenCalledWith({
      entries: [{ projectRelativePath: 'cover.png', kind: 'file' }],
      targetDirectoryProjectRelativePath: 'assets',
      overwrite: true
    });
  });
});

function commandInput(overrides: {
  command: WorkbenchContextMenuCommand;
  actions: Partial<Parameters<typeof runWorkbenchContextMenuCommand>[0]['actions']>;
  target?: Parameters<typeof runWorkbenchContextMenuCommand>[0]['contextMenu'] extends infer T
    ? T extends { target: infer U }
      ? U
      : never
    : never;
  fileClipboard?: Parameters<typeof runWorkbenchContextMenuCommand>[0]['fileClipboard'];
  snapshot?: WorkbenchProjectSessionSnapshot;
  copyText?: Parameters<typeof runWorkbenchContextMenuCommand>[0]['copyText'];
  setFileClipboard?: Parameters<typeof runWorkbenchContextMenuCommand>[0]['setFileClipboard'];
  confirmPermanentDelete?: Parameters<typeof runWorkbenchContextMenuCommand>[0]['confirmPermanentDelete'];
  confirmMoveOverwrite?: (input: { entries: Array<{ projectRelativePath: string; kind: 'file' | 'directory' }>; targetDirectoryProjectRelativePath: string }) => boolean;
}): Parameters<typeof runWorkbenchContextMenuCommand>[0] {
  return {
    command: overrides.command,
    contextMenu: {
      target: overrides.target ?? {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'briefs/concept.md', kind: 'file' }],
        primaryPath: 'briefs/concept.md',
        targetDirectoryPath: 'briefs'
      },
      position: { x: 0, y: 0 }
    },
    activeProjection: undefined,
    activeCanvasRuntime: undefined,
    fileClipboard: overrides.fileClipboard,
    actions: {
      copyProjectAbsolutePaths: async () => ({ paths: ['/tmp/debrute-project/unused'] }),
      trashProjectPaths: async () => ({ results: [], snapshot: snapshotFixture() }),
      deleteProjectPathsPermanently: async () => ({ results: [], snapshot: snapshotFixture() }),
      moveProjectPaths: async () => ({ results: [], snapshot: snapshotFixture() }),
      ...overrides.actions
    } as Parameters<typeof runWorkbenchContextMenuCommand>[0]['actions'],
    setInlineProjectTreeEdit: () => undefined,
    setFileClipboard: overrides.setFileClipboard ?? (() => undefined),
    copyText: overrides.copyText ?? (() => undefined),
    notify: () => undefined,
    closeContextMenu: () => undefined,
    openInspectorPanel: () => undefined,
    confirmPermanentDelete: overrides.confirmPermanentDelete ?? (() => true),
    projectSnapshot: overrides.snapshot,
    confirmMoveOverwrite: overrides.confirmMoveOverwrite ?? (() => true)
  };
}

function rootTarget(): NonNullable<Parameters<typeof runWorkbenchContextMenuCommand>[0]['contextMenu']>['target'] {
  return {
    source: 'explorer',
    targetKind: 'root',
    paths: [],
    primaryPath: null,
    targetDirectoryPath: ''
  };
}

function snapshotFixture(overrides: Partial<WorkbenchProjectSessionSnapshot> = {}): WorkbenchProjectSessionSnapshot {
  return {
    metadata: {
      schemaVersion: 1,
      project: {
        id: 'project-1',
        name: 'Test Project',
        createdAt: '2026-06-05T00:00:00.000Z',
        updatedAt: '2026-06-05T00:00:00.000Z'
      }
    },
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
    health: {
      projectName: 'Test Project',
      canvasCount: 0,
      diagnosticCounts: {
        errors: 0,
        warnings: 0,
        infos: 0
      },
      runtimeDataLocation: 'debrute-home',
      checkedAt: '2026-06-05T00:00:00.000Z'
    },
    ...overrides
  };
}
