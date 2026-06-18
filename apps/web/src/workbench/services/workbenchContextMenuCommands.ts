import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { CanvasProjection } from '@debrute/canvas-core';
import type { WorkbenchActions } from '../../types';
import type { CanvasEditorRuntime } from '../canvas/runtime/CanvasEditorRuntime';
import {
  createInlineEditState,
  projectTreePasteTargetDirectory,
  type ProjectTreeInlineEditState
} from '../project-explorer/projectTreeEditing';
import { projectTreeBatchMoveHasConflict } from '../project-explorer/projectTreeInteraction';
import {
  clearClipboardAfterPaste,
  notificationMessageForFileCommandError
} from '../project-explorer/workbenchFileCommands';
import {
  cameraCenteredOnNode,
  explorerContextMenuEntries,
  explorerContextMenuPrimaryEntry,
  explorerContextMenuProjectRelativePaths,
  projectedContextMenuNode,
  type WorkbenchContextMenuCommand,
  type WorkbenchContextMenuPosition,
  type WorkbenchContextMenuTarget,
  type WorkbenchProjectPathEntry,
  type WorkbenchFileClipboard
} from '../shell/contextMenu';

type SetState<T> = (value: T | ((current: T) => T)) => void;

export function runWorkbenchContextMenuCommand(input: {
  command: WorkbenchContextMenuCommand;
  contextMenu: { target: WorkbenchContextMenuTarget; position: WorkbenchContextMenuPosition } | undefined;
  activeProjection: CanvasProjection | undefined;
  activeCanvasRuntime: CanvasEditorRuntime | undefined;
  fileClipboard: WorkbenchFileClipboard | undefined;
  actions: WorkbenchActions;
  setInlineProjectTreeEdit: SetState<ProjectTreeInlineEditState | undefined>;
  setFileClipboard: SetState<WorkbenchFileClipboard | undefined>;
  copyText: (text: string) => void | Promise<void>;
  notify: (message: string) => void;
  closeContextMenu: () => void;
  openInspectorPanel: () => void;
  confirmPermanentDelete: (input: { entries: WorkbenchProjectPathEntry[] }) => boolean;
  projectSnapshot?: WorkbenchProjectSessionSnapshot | undefined;
  confirmMoveOverwrite: (input: {
    entries: WorkbenchProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
  }) => boolean;
}): void {
  const target = input.contextMenu?.target;
  if (!target) {
    return;
  }

  if (target.source === 'explorer') {
    if (runExplorerSpecificCommand(input, target)) {
      return;
    }
    if (target.targetKind === 'root') {
      input.closeContextMenu();
      return;
    }
  }

  if (runSinglePathFileCommand(input, target)) {
    return;
  }

  if (target.source === 'explorer' && target.targetKind !== 'item') {
    input.closeContextMenu();
    return;
  }

  const primaryEntry = explorerContextMenuPrimaryEntry(target);
  if (!primaryEntry) {
    input.closeContextMenu();
    return;
  }
  const projectRelativePath = primaryEntry.projectRelativePath;

  const node = projectedContextMenuNode(input.activeProjection, projectRelativePath);
  if (!node) {
    input.closeContextMenu();
    return;
  }

  input.activeCanvasRuntime?.setSelection({ kind: 'node', projectRelativePath });
  if (input.command === 'show-details') {
    if (input.activeCanvasRuntime) {
      input.openInspectorPanel();
    }
    input.closeContextMenu();
    return;
  }

  const liveRuntimeSnapshot = input.activeCanvasRuntime?.getSnapshot();
  if (input.command === 'reveal-in-canvas' && input.activeCanvasRuntime && liveRuntimeSnapshot?.surfaceSize) {
    input.activeCanvasRuntime.camera.setCamera(cameraCenteredOnNode({
      node,
      surfaceSize: liveRuntimeSnapshot.surfaceSize,
      camera: liveRuntimeSnapshot.camera
    }));
  }
  if (input.command === 'reset-auto-layout') {
    if (node.layoutMode !== 'manual') {
      input.closeContextMenu();
      return;
    }
    const canvasId = input.activeProjection?.canvasId;
    if (canvasId) {
      void input.actions.resetCanvasNodeLayouts(canvasId, canvasLayoutResetInputForTarget(primaryEntry)).then((result) => {
        const updatedNode = projectedContextMenuNode(result.projection, projectRelativePath);
        const snapshot = input.activeCanvasRuntime?.getSnapshot();
        if (!updatedNode || !input.activeCanvasRuntime || !snapshot?.surfaceSize) {
          return;
        }
        input.activeCanvasRuntime.camera.setCamera(cameraCenteredOnNode({
          node: updatedNode,
          surfaceSize: snapshot.surfaceSize,
          camera: snapshot.camera
        }));
      }).catch((error) => {
        input.notify(`Reset auto layout failed: ${errorMessage(error)}`);
      });
    }
  }
  input.closeContextMenu();
}

function canvasLayoutResetInputForTarget(
  target: WorkbenchProjectPathEntry
): Parameters<WorkbenchActions['resetCanvasNodeLayouts']>[1] {
  if (target.kind === 'directory' && target.projectRelativePath === '') {
    return { all: true };
  }
  return {
    pathRules: [target.kind === 'directory' ? `${target.projectRelativePath}/` : target.projectRelativePath]
  };
}

function runSinglePathFileCommand(
  input: Parameters<typeof runWorkbenchContextMenuCommand>[0],
  target: WorkbenchContextMenuTarget
): boolean {
  const primaryEntry = explorerContextMenuPrimaryEntry(target);
  if (!primaryEntry) {
    return false;
  }
  const entries = explorerContextMenuEntries(target);
  const canvasProjectRoot = isCanvasProjectRootTarget(target, primaryEntry);
  if (input.command === 'cut') {
    if (canvasProjectRoot) {
      input.closeContextMenu();
      return true;
    }
    input.setFileClipboard({ operation: 'cut', entries });
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'copy') {
    if (canvasProjectRoot) {
      input.closeContextMenu();
      return true;
    }
    input.setFileClipboard({ operation: 'copy', entries });
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'paste') {
    if (target.source === 'canvas' && primaryEntry.kind !== 'directory') {
      input.closeContextMenu();
      return true;
    }
    runPasteCommand(input, target);
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'copy-path') {
    void input.actions.copyProjectAbsolutePaths({ entries })
      .then((result) => input.copyText(result.paths.join('\n')))
      .catch((error) => input.notify(notificationMessageForFileCommandError('Copy Path failed', error)));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'copy-relative-path') {
    if (canvasProjectRoot) {
      input.closeContextMenu();
      return true;
    }
    void input.copyText(explorerContextMenuProjectRelativePaths(target).join('\n'));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'open-terminal') {
    input.actions.openTerminalPanel(terminalCwdForEntry(primaryEntry));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'send-to-photoshop') {
    if (primaryEntry.kind === 'file') {
      input.actions.openSendToPhotoshopPicker(primaryEntry.projectRelativePath);
    }
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'reveal-in-system-file-manager') {
    void input.actions.revealProjectPathInSystemFileManager(primaryEntry)
      .catch((error) => input.notify(notificationMessageForFileCommandError('Reveal failed', error)));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'delete') {
    if (canvasProjectRoot) {
      input.closeContextMenu();
      return true;
    }
    void input.actions.trashProjectPaths({ entries })
      .catch((error) => input.notify(notificationMessageForFileCommandError('Delete failed', error)));
    input.closeContextMenu();
    return true;
  }
  return false;
}

function runExplorerSpecificCommand(
  input: Parameters<typeof runWorkbenchContextMenuCommand>[0],
  target: Extract<WorkbenchContextMenuTarget, { source: 'explorer' }>
): boolean {
  const entries = explorerContextMenuEntries(target);
  const primaryEntry = explorerContextMenuPrimaryEntry(target);
  if (target.targetKind === 'root') {
    if (input.command === 'create-file') {
      input.setInlineProjectTreeEdit(createInlineEditState('creating-file', projectTreePasteTargetDirectory(target)));
      input.closeContextMenu();
      return true;
    }
    if (input.command === 'create-directory') {
      input.setInlineProjectTreeEdit(createInlineEditState('creating-directory', projectTreePasteTargetDirectory(target)));
      input.closeContextMenu();
      return true;
    }
    if (input.command === 'paste') {
      runPasteCommand(input, target);
      input.closeContextMenu();
      return true;
    }
    if (input.command === 'open-terminal') {
      input.actions.openTerminalPanel('');
      input.closeContextMenu();
      return true;
    }
    return false;
  }
  if (input.command === 'create-file') {
    if (target.targetKind !== 'item' || primaryEntry?.kind !== 'directory') {
      input.closeContextMenu();
      return true;
    }
    input.setInlineProjectTreeEdit(createInlineEditState('creating-file', projectTreePasteTargetDirectory(target)));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'create-directory') {
    if (target.targetKind !== 'item' || primaryEntry?.kind !== 'directory') {
      input.closeContextMenu();
      return true;
    }
    input.setInlineProjectTreeEdit(createInlineEditState('creating-directory', projectTreePasteTargetDirectory(target)));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'rename') {
    if (primaryEntry && entries.length === 1) {
      input.setInlineProjectTreeEdit(createInlineEditState('renaming', primaryEntry.projectRelativePath));
    }
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'delete-permanently') {
    if (!input.confirmPermanentDelete({ entries })) {
      input.closeContextMenu();
      return true;
    }
    void input.actions.deleteProjectPathsPermanently({ entries })
      .catch((error) => input.notify(notificationMessageForFileCommandError('Delete failed', error)));
    input.closeContextMenu();
    return true;
  }
  return false;
}

function terminalCwdForEntry(entry: WorkbenchProjectPathEntry): string {
  if (entry.kind === 'directory') {
    return entry.projectRelativePath;
  }
  const slashIndex = entry.projectRelativePath.lastIndexOf('/');
  return slashIndex < 0 ? '' : entry.projectRelativePath.slice(0, slashIndex);
}

function isCanvasProjectRootTarget(
  target: WorkbenchContextMenuTarget,
  entry: WorkbenchProjectPathEntry
): boolean {
  return target.source === 'canvas'
    && entry.kind === 'directory'
    && entry.projectRelativePath === '';
}

function runPasteCommand(
  input: Parameters<typeof runWorkbenchContextMenuCommand>[0],
  target: WorkbenchContextMenuTarget
): void {
  const fileClipboard = input.fileClipboard;
  if (!fileClipboard || fileClipboard.entries.length === 0) {
    return;
  }
  const targetDirectoryProjectRelativePath = projectTreePasteTargetDirectory(target);
  if (fileClipboard.operation === 'cut') {
    const overwrite = input.projectSnapshot && projectTreeBatchMoveHasConflict({
      existingProjectRelativePaths: new Set(input.projectSnapshot.files.map((file) => file.projectRelativePath)),
      entries: fileClipboard.entries,
      targetDirectoryProjectRelativePath
    });
    if (overwrite && !input.confirmMoveOverwrite({
      entries: fileClipboard.entries,
      targetDirectoryProjectRelativePath
    })) {
      return;
    }
    void input.actions.moveProjectPaths({
      entries: fileClipboard.entries,
      targetDirectoryProjectRelativePath,
      ...(overwrite ? { overwrite: true } : {})
    }).then(() => {
      input.setFileClipboard(clearClipboardAfterPaste(fileClipboard));
    }).catch((error) => {
      input.notify(notificationMessageForFileCommandError('Paste failed', error));
    });
    return;
  }
  void input.actions.copyProjectPaths({
    entries: fileClipboard.entries,
    targetDirectoryProjectRelativePath
  }).then(() => {
    input.setFileClipboard(clearClipboardAfterPaste(fileClipboard));
  }).catch((error) => {
    input.notify(notificationMessageForFileCommandError('Paste failed', error));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
