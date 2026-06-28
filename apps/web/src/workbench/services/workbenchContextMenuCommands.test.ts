import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchProjectFileBatchOperationResult, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { CanvasProjection } from '@debrute/canvas-core';
import type { CanvasEditorRuntime } from '../canvas/runtime/CanvasEditorRuntime';
import type { WorkbenchContextMenuCommand } from '../shell/contextMenu';
import { runWorkbenchContextMenuCommand } from './workbenchContextMenuCommands';

describe('workbench context menu commands', () => {
  it('confirms permanent delete before deleting', () => {
    const deleteProjectPathsPermanently = vi.fn(async () => ({
      ...batchResult(),
      results: []
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
      ...batchResult(),
      results: [{
        sourceProjectRelativePath: 'briefs/concept.md',
        projectRelativePath: 'briefs/concept.md',
        kind: 'file' as const,
        status: 'ok' as const
      }]
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
      ...batchResult(),
      results: []
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

  it('opens terminal in a directory from the Explorer context menu', () => {
    const openTerminalPanel = vi.fn();

    runWorkbenchContextMenuCommand(commandInput({
      command: 'open-terminal',
      actions: {
        openTerminalPanel
      },
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'assets', kind: 'directory' }],
        primaryPath: 'assets',
        targetDirectoryPath: ''
      }
    }));

    expect(openTerminalPanel).toHaveBeenCalledWith('assets');
  });

  it('opens terminal in a file parent directory from the Explorer context menu', () => {
    const openTerminalPanel = vi.fn();

    runWorkbenchContextMenuCommand(commandInput({
      command: 'open-terminal',
      actions: {
        openTerminalPanel
      },
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'briefs/concept.md', kind: 'file' }],
        primaryPath: 'briefs/concept.md',
        targetDirectoryPath: 'briefs'
      }
    }));

    expect(openTerminalPanel).toHaveBeenCalledWith('briefs');
  });

  it('opens terminal in the project root from the Explorer root context menu', () => {
    const openTerminalPanel = vi.fn();

    runWorkbenchContextMenuCommand(commandInput({
      command: 'open-terminal',
      actions: {
        openTerminalPanel
      },
      target: rootTarget()
    }));

    expect(openTerminalPanel).toHaveBeenCalledWith('');
  });

  it('does not paste when the internal clipboard has no entries', async () => {
    const copyProjectPaths = vi.fn(async () => ({
      ...batchResult(),
      results: []
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
      ...batchResult(),
      results: [{
        sourceProjectRelativePath: 'cover.png',
        projectRelativePath: 'assets/cover.png',
        kind: 'file' as const,
        status: 'ok' as const
      }]
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

  it('sets the file clipboard from a Canvas Cut command', () => {
    const setFileClipboard = vi.fn();

    runWorkbenchContextMenuCommand(commandInput({
      command: 'cut',
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'flow/cover.png' },
      activeProjection: canvasProjectionFixture('canvas-1', {
        projectRelativePath: 'flow/cover.png',
        x: 200,
        y: 100,
        width: 100,
        height: 50
      }),
      actions: {},
      setFileClipboard
    }));

    expect(setFileClipboard).toHaveBeenCalledWith({
      operation: 'cut',
      entries: [{ projectRelativePath: 'flow/cover.png', kind: 'file' }]
    });
  });

  it('copies daemon-returned absolute paths for a Canvas Copy Path command', async () => {
    const copiedText: string[] = [];
    const copyProjectAbsolutePaths = vi.fn(async () => ({
      paths: ['/tmp/debrute-project/flow/cover.png']
    }));

    runWorkbenchContextMenuCommand(commandInput({
      command: 'copy-path',
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'flow/cover.png' },
      actions: {
        copyProjectAbsolutePaths
      },
      copyText: (text) => {
        copiedText.push(text);
      }
    }));

    await Promise.resolve();

    expect(copyProjectAbsolutePaths).toHaveBeenCalledWith({
      entries: [{ projectRelativePath: 'flow/cover.png', kind: 'file' }]
    });
    expect(copiedText).toEqual(['/tmp/debrute-project/flow/cover.png']);
  });

  it('opens a terminal in a Canvas directory node', () => {
    const openTerminalPanel = vi.fn();

    runWorkbenchContextMenuCommand(commandInput({
      command: 'open-terminal',
      target: { source: 'canvas', kind: 'directory', projectRelativePath: 'assets' },
      actions: {
        openTerminalPanel
      }
    }));

    expect(openTerminalPanel).toHaveBeenCalledWith('assets');
  });

  it('opens a terminal in a Canvas file parent directory', () => {
    const openTerminalPanel = vi.fn();

    runWorkbenchContextMenuCommand(commandInput({
      command: 'open-terminal',
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'flow/cover.png' },
      actions: {
        openTerminalPanel
      }
    }));

    expect(openTerminalPanel).toHaveBeenCalledWith('flow');
  });

  it('pastes into a Canvas directory node', async () => {
    const copyProjectPaths = vi.fn(async () => ({
      ...batchResult(),
      results: [{
        sourceProjectRelativePath: 'briefs/concept.md',
        projectRelativePath: 'assets/concept.md',
        kind: 'file' as const,
        status: 'ok' as const
      }]
    }));
    const setFileClipboard = vi.fn();
    const clipboard = {
      operation: 'copy' as const,
      entries: [{ projectRelativePath: 'briefs/concept.md', kind: 'file' as const }]
    };

    runWorkbenchContextMenuCommand(commandInput({
      command: 'paste',
      target: { source: 'canvas', kind: 'directory', projectRelativePath: 'assets' },
      actions: {
        copyProjectPaths
      },
      fileClipboard: clipboard,
      setFileClipboard
    }));

    await Promise.resolve();

    expect(copyProjectPaths).toHaveBeenCalledWith({
      entries: [{ projectRelativePath: 'briefs/concept.md', kind: 'file' }],
      targetDirectoryProjectRelativePath: 'assets'
    });
    expect(setFileClipboard).toHaveBeenCalledWith(clipboard);
  });

  it('does not paste from a stale Canvas file target command', async () => {
    const copyProjectPaths = vi.fn(async () => ({
      ...batchResult(),
      results: []
    }));

    runWorkbenchContextMenuCommand(commandInput({
      command: 'paste',
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'flow/cover.png' },
      actions: {
        copyProjectPaths
      },
      fileClipboard: {
        operation: 'copy',
        entries: [{ projectRelativePath: 'briefs/concept.md', kind: 'file' }]
      }
    }));

    await Promise.resolve();

    expect(copyProjectPaths).not.toHaveBeenCalled();
  });

  it('reveals a Canvas path in the system file manager', async () => {
    const revealProjectPathInSystemFileManager = vi.fn(async () => ({ ok: true as const }));

    runWorkbenchContextMenuCommand(commandInput({
      command: 'reveal-in-system-file-manager',
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'flow/cover.png' },
      actions: {
        revealProjectPathInSystemFileManager
      }
    }));

    await Promise.resolve();

    expect(revealProjectPathInSystemFileManager).toHaveBeenCalledWith({
      projectRelativePath: 'flow/cover.png',
      kind: 'file'
    });
  });

  it('deletes a Canvas path through the project trash flow', async () => {
    const trashProjectPaths = vi.fn(async () => ({
      ...batchResult(),
      results: [{
        sourceProjectRelativePath: 'flow/cover.png',
        projectRelativePath: 'flow/cover.png',
        kind: 'file' as const,
        status: 'ok' as const
      }]
    }));

    runWorkbenchContextMenuCommand(commandInput({
      command: 'delete',
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'flow/cover.png' },
      actions: {
        trashProjectPaths
      }
    }));

    await Promise.resolve();

    expect(trashProjectPaths).toHaveBeenCalledWith({
      entries: [{ projectRelativePath: 'flow/cover.png', kind: 'file' }]
    });
  });

  it('does not run root entry file commands from stale Canvas project root commands', async () => {
    const setFileClipboard = vi.fn();
    const copyText = vi.fn();
    const trashProjectPaths = vi.fn(async () => ({
      ...batchResult(),
      results: []
    }));
    const rootTarget = { source: 'canvas' as const, kind: 'directory' as const, projectRelativePath: '' };
    const rootProjection = canvasProjectionFixture('canvas-1', {
      projectRelativePath: '',
      nodeKind: 'directory',
      x: 200,
      y: 100,
      width: 120,
      height: 80,
      layoutMode: 'manual'
    });

    for (const command of ['cut', 'copy', 'copy-relative-path', 'delete'] as const) {
      runWorkbenchContextMenuCommand(commandInput({
        command,
        target: rootTarget,
        activeProjection: rootProjection,
        activeCanvasRuntime: canvasRuntimeFixture(),
        actions: {
          trashProjectPaths
        },
        setFileClipboard,
        copyText
      }));
    }

    await Promise.resolve();

    expect(setFileClipboard).not.toHaveBeenCalled();
    expect(copyText).not.toHaveBeenCalled();
    expect(trashProjectPaths).not.toHaveBeenCalled();
  });

  it('runs Show Details from a Project Explorer item that exists in the Canvas projection', () => {
    const openInspectorPanel = vi.fn();
    const setSelection = vi.fn<CanvasEditorRuntime['setSelection']>();

    runWorkbenchContextMenuCommand(commandInput({
      command: 'show-details',
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'flow/cover.png', kind: 'file' }],
        primaryPath: 'flow/cover.png',
        targetDirectoryPath: 'flow'
      },
      activeProjection: canvasProjectionFixture('canvas-1', {
        projectRelativePath: 'flow/cover.png',
        x: 200,
        y: 100,
        width: 100,
        height: 50
      }),
      activeCanvasRuntime: canvasRuntimeFixture({ setSelection }),
      actions: {},
      openInspectorPanel
    }));

    expect(setSelection).toHaveBeenCalledWith({ kind: 'node', projectRelativePath: 'flow/cover.png' });
    expect(openInspectorPanel).toHaveBeenCalled();
  });

  it('does not reset auto layout from a stale command for an automatic node', async () => {
    const resetCanvasNodeLayouts = vi.fn(async () => ({
      projectId: 'project-live-id',
      projectRevision: 2,
      resetCount: 0,
      canvas: {
        id: 'canvas-1',
        nodeElements: [],
        annotations: [],
        preferences: {
          showDiagnostics: true
        }
      },
      projection: canvasProjectionFixture('canvas-1', {
        projectRelativePath: 'flow/cover.png',
        x: 200,
        y: 100,
        width: 100,
        height: 50
      })
    }));

    runWorkbenchContextMenuCommand(commandInput({
      command: 'reset-auto-layout',
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'flow/cover.png', kind: 'file' }],
        primaryPath: 'flow/cover.png',
        targetDirectoryPath: 'flow'
      },
      activeProjection: canvasProjectionFixture('canvas-1', {
        projectRelativePath: 'flow/cover.png',
        x: 200,
        y: 100,
        width: 100,
        height: 50
      }),
      activeCanvasRuntime: canvasRuntimeFixture(),
      actions: {
        resetCanvasNodeLayouts
      }
    }));

    await Promise.resolve();

    expect(resetCanvasNodeLayouts).not.toHaveBeenCalled();
  });

  it('resets a manual Canvas node and centers its updated projection', async () => {
    const resetCanvasNodeLayouts = vi.fn(async () => ({
      projectId: 'project-live-id',
      projectRevision: 2,
      resetCount: 1,
      canvas: {
        id: 'canvas-1',
        nodeElements: [],
        annotations: [],
        preferences: {
          showDiagnostics: true
        }
      },
      projection: canvasProjectionFixture('canvas-1', {
        projectRelativePath: 'flow/cover.png',
        x: 200,
        y: 100,
        width: 100,
        height: 50
      })
    }));
    const setCamera = vi.fn<CanvasEditorRuntime['camera']['setCamera']>();
    const setSelection = vi.fn<CanvasEditorRuntime['setSelection']>();

    runWorkbenchContextMenuCommand(commandInput({
      command: 'reset-auto-layout',
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'flow/cover.png' },
      activeProjection: canvasProjectionFixture('canvas-1', {
        projectRelativePath: 'flow/cover.png',
        x: 1000,
        y: 900,
        width: 100,
        height: 50,
        layoutMode: 'manual'
      }),
      activeCanvasRuntime: canvasRuntimeFixture({ setSelection, setCamera }),
      actions: {
        resetCanvasNodeLayouts
      }
    }));

    await Promise.resolve();

    expect(resetCanvasNodeLayouts).toHaveBeenCalledWith('canvas-1', {
      pathRules: ['flow/cover.png']
    });
    expect(setSelection).toHaveBeenCalledWith({ kind: 'node', projectRelativePath: 'flow/cover.png' });
    expect(setCamera).toHaveBeenCalledWith({ x: 250, y: 175, z: 1 });
  });

  it('resets a manual Canvas directory with a recursive Canvas Map path rule', async () => {
    const resetCanvasNodeLayouts = vi.fn(async () => ({
      projectId: 'project-live-id',
      projectRevision: 2,
      resetCount: 1,
      canvas: {
        id: 'canvas-1',
        nodeElements: [],
        annotations: [],
        preferences: {
          showDiagnostics: true
        }
      },
      projection: canvasProjectionFixture('canvas-1', {
        projectRelativePath: 'flow',
        nodeKind: 'directory',
        x: 200,
        y: 100,
        width: 120,
        height: 80
      })
    }));
    const setCamera = vi.fn<CanvasEditorRuntime['camera']['setCamera']>();

    runWorkbenchContextMenuCommand(commandInput({
      command: 'reset-auto-layout',
      target: { source: 'canvas', kind: 'directory', projectRelativePath: 'flow' },
      activeProjection: canvasProjectionFixture('canvas-1', {
        projectRelativePath: 'flow',
        nodeKind: 'directory',
        x: 1000,
        y: 900,
        width: 120,
        height: 80,
        layoutMode: 'manual'
      }),
      activeCanvasRuntime: canvasRuntimeFixture({ setCamera }),
      actions: {
        resetCanvasNodeLayouts
      }
    }));

    await Promise.resolve();

    expect(resetCanvasNodeLayouts).toHaveBeenCalledWith('canvas-1', {
      pathRules: ['flow/']
    });
    expect(setCamera).toHaveBeenCalledWith({ x: 240, y: 160, z: 1 });
  });

  it('resets the Canvas project root with a full Canvas Map layout reset', async () => {
    const resetCanvasNodeLayouts = vi.fn(async () => ({
      projectId: 'project-live-id',
      projectRevision: 2,
      resetCount: 1,
      canvas: {
        id: 'canvas-1',
        nodeElements: [],
        annotations: [],
        preferences: {
          showDiagnostics: true
        }
      },
      projection: canvasProjectionFixture('canvas-1', {
        projectRelativePath: '',
        nodeKind: 'directory',
        x: 200,
        y: 100,
        width: 120,
        height: 80
      })
    }));
    const setCamera = vi.fn<CanvasEditorRuntime['camera']['setCamera']>();

    runWorkbenchContextMenuCommand(commandInput({
      command: 'reset-auto-layout',
      target: { source: 'canvas', kind: 'directory', projectRelativePath: '' },
      activeProjection: canvasProjectionFixture('canvas-1', {
        projectRelativePath: '',
        nodeKind: 'directory',
        x: 1000,
        y: 900,
        width: 120,
        height: 80,
        layoutMode: 'manual'
      }),
      activeCanvasRuntime: canvasRuntimeFixture({ setCamera }),
      actions: {
        resetCanvasNodeLayouts
      }
    }));

    await Promise.resolve();

    expect(resetCanvasNodeLayouts).toHaveBeenCalledWith('canvas-1', {
      all: true
    });
    expect(setCamera).toHaveBeenCalledWith({ x: 240, y: 160, z: 1 });
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
  activeProjection?: Parameters<typeof runWorkbenchContextMenuCommand>[0]['activeProjection'];
  activeCanvasRuntime?: Partial<Parameters<typeof runWorkbenchContextMenuCommand>[0]['activeCanvasRuntime']>;
  fileClipboard?: Parameters<typeof runWorkbenchContextMenuCommand>[0]['fileClipboard'];
  snapshot?: WorkbenchProjectSessionSnapshot;
  copyText?: Parameters<typeof runWorkbenchContextMenuCommand>[0]['copyText'];
  setFileClipboard?: Parameters<typeof runWorkbenchContextMenuCommand>[0]['setFileClipboard'];
  openInspectorPanel?: Parameters<typeof runWorkbenchContextMenuCommand>[0]['openInspectorPanel'];
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
    activeProjection: overrides.activeProjection,
    activeCanvasRuntime: overrides.activeCanvasRuntime as Parameters<typeof runWorkbenchContextMenuCommand>[0]['activeCanvasRuntime'],
    fileClipboard: overrides.fileClipboard,
    actions: {
      copyProjectAbsolutePaths: async () => ({ paths: ['/tmp/debrute-project/unused'] }),
      trashProjectPaths: async () => batchResult(),
      deleteProjectPathsPermanently: async () => batchResult(),
      moveProjectPaths: async () => batchResult(),
      openTerminalPanel: () => undefined,
      ...overrides.actions
    } as Parameters<typeof runWorkbenchContextMenuCommand>[0]['actions'],
    setInlineProjectTreeEdit: () => undefined,
    setFileClipboard: overrides.setFileClipboard ?? (() => undefined),
    copyText: overrides.copyText ?? (() => undefined),
    notify: () => undefined,
    closeContextMenu: () => undefined,
    openInspectorPanel: overrides.openInspectorPanel ?? (() => undefined),
    confirmPermanentDelete: overrides.confirmPermanentDelete ?? (() => true),
    projectSnapshot: overrides.snapshot,
    confirmMoveOverwrite: overrides.confirmMoveOverwrite ?? (() => true),
    errorLabels: {
      copyPathFailed: 'Copy Path failed',
      revealFailed: 'Reveal failed',
      deleteFailed: 'Delete failed',
      pasteFailed: 'Paste failed',
      resetAutoLayoutFailed: 'Reset auto layout failed'
    }
  };
}

function canvasRuntimeFixture(input: {
  setSelection?: CanvasEditorRuntime['setSelection'];
  setCamera?: CanvasEditorRuntime['camera']['setCamera'];
} = {}): Partial<CanvasEditorRuntime> {
  const setSelection = input.setSelection ?? (() => undefined);
  const setCamera = input.setCamera ?? (() => undefined);
  return {
    setSelection: (selection) => {
      setSelection(selection);
    },
    getSnapshot: () => ({
      surfaceSize: { width: 1000, height: 600 },
      camera: { x: 0, y: 0, z: 1 },
      cameraState: 'idle' as const,
      selection: undefined,
      dragState: undefined,
      imageResourceZoom: 1
    }),
    camera: {
      getCamera: () => ({ x: 0, y: 0, z: 1 }),
      setCamera: (camera) => {
        setCamera(camera);
      },
      panBy: vi.fn(),
      zoomByWheel: vi.fn(),
      zoomByGesture: vi.fn(),
      centerOn: vi.fn(),
      reset: vi.fn()
    }
  };
}

function canvasProjectionFixture(
  canvasId: string,
  node: {
    projectRelativePath: string;
    nodeKind?: 'file' | 'directory';
    x: number;
    y: number;
    width: number;
    height: number;
    layoutMode?: 'manual';
  }
): CanvasProjection {
  return {
    canvasId,
    nodes: [{
      projectRelativePath: node.projectRelativePath,
      nodeKind: node.nodeKind ?? 'file',
      ...(node.nodeKind === 'directory' ? {} : { mediaKind: 'image' as const }),
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      z: 0,
      ...(node.layoutMode ? { layoutMode: node.layoutMode } : {}),
      availability: {
        state: 'available',
        size: 100,
        mimeType: 'image/png',
        fileUrl: 'http://127.0.0.1/file.png',
        revision: 'rev'
      }
    }],
    edges: [],
    diagnostics: []
  };
}

function batchResult(): WorkbenchProjectFileBatchOperationResult {
  return {
    projectId: 'project-live-id',
    projectRevision: 2,
    results: [],
    snapshot: snapshotFixture()
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
    canvasRegistry: {
      status: 'ready',
      canvasOrder: []
    },
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
