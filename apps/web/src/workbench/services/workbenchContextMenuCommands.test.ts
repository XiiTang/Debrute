import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { runWorkbenchContextMenuCommand } from './workbenchContextMenuCommands';

describe('workbench context menu commands', () => {
  it('confirms permanent delete before deleting', () => {
    const deleteProjectPathPermanently = vi.fn(async () => ({
      projectRelativePath: 'briefs/concept.md',
      kind: 'file' as const,
      snapshot: snapshotFixture()
    }));
    runWorkbenchContextMenuCommand(commandInput({
      command: 'delete-permanently',
      actions: {
        deleteProjectPathPermanently
      },
      confirmPermanentDelete: () => false
    }));

    expect(deleteProjectPathPermanently).not.toHaveBeenCalled();
  });

  it('runs trash delete for the visible Delete command', () => {
    const trashProjectPath = vi.fn(async () => ({
      projectRelativePath: 'briefs/concept.md',
      snapshot: snapshotFixture()
    }));
    runWorkbenchContextMenuCommand(commandInput({
      command: 'delete',
      actions: {
        trashProjectPath
      }
    }));

    expect(trashProjectPath).toHaveBeenCalledWith({
      projectRelativePath: 'briefs/concept.md',
      kind: 'file'
    });
  });
});

function commandInput(overrides: {
  command: 'delete' | 'delete-permanently';
  actions: Partial<Parameters<typeof runWorkbenchContextMenuCommand>[0]['actions']>;
  confirmPermanentDelete?: Parameters<typeof runWorkbenchContextMenuCommand>[0]['confirmPermanentDelete'];
}): Parameters<typeof runWorkbenchContextMenuCommand>[0] {
  return {
    command: overrides.command,
    contextMenu: {
      target: { source: 'explorer', kind: 'file', projectRelativePath: 'briefs/concept.md' },
      position: { x: 0, y: 0 }
    },
    activeProjection: undefined,
    activeCanvasRuntime: undefined,
    fileClipboard: undefined,
    actions: {
      trashProjectPath: async () => ({ projectRelativePath: 'unused', snapshot: snapshotFixture() }),
      deleteProjectPathPermanently: async () => ({ projectRelativePath: 'unused', kind: 'file', snapshot: snapshotFixture() }),
      ...overrides.actions
    } as Parameters<typeof runWorkbenchContextMenuCommand>[0]['actions'],
    setInlineProjectTreeEdit: () => undefined,
    setFileClipboard: () => undefined,
    copyText: () => undefined,
    notify: () => undefined,
    closeContextMenu: () => undefined,
    openInspectorPanel: () => undefined,
    confirmPermanentDelete: overrides.confirmPermanentDelete ?? (() => true)
  };
}

function snapshotFixture(): WorkbenchProjectSessionSnapshot {
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
    }
  };
}
