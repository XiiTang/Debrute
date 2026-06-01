import type { CanvasProjection } from '@axis/canvas-core';
import type { WorkbenchActions } from '../../types';
import type { CanvasNavigationState } from '../canvas/canvasMinimap';
import {
  createInlineEditState,
  projectTreePasteTargetDirectory,
  type ProjectTreeInlineEditState
} from '../project-explorer/projectTreeEditing';
import {
  clearClipboardAfterPaste,
  notificationMessageForFileCommandError
} from '../project-explorer/workbenchFileCommands';
import {
  centeredCanvasViewportForNode,
  projectedContextMenuNode,
  type WorkbenchContextMenuCommand,
  type WorkbenchContextMenuPosition,
  type WorkbenchContextMenuTarget,
  type WorkbenchFileClipboard
} from '../shell/contextMenu';

type SetState<T> = (value: T | ((current: T) => T)) => void;

export function runWorkbenchContextMenuCommand(input: {
  command: WorkbenchContextMenuCommand;
  contextMenu: { target: WorkbenchContextMenuTarget; position: WorkbenchContextMenuPosition } | undefined;
  activeProjection: CanvasProjection | undefined;
  activeCanvasNavigationState: CanvasNavigationState | undefined;
  fileClipboard: WorkbenchFileClipboard | undefined;
  actions: WorkbenchActions;
  setInlineProjectTreeEdit: SetState<ProjectTreeInlineEditState | undefined>;
  setFileClipboard: SetState<WorkbenchFileClipboard | undefined>;
  copyText: (text: string) => void | Promise<void>;
  notify: (message: string) => void;
  closeContextMenu: () => void;
  openInspectorPanel: () => void;
}): void {
  const target = input.contextMenu?.target;
  if (!target) {
    return;
  }
  const projectRelativePath = target.projectRelativePath;

  if (target.source === 'explorer' && runExplorerCommand(input, target, projectRelativePath)) {
    return;
  }

  if (input.command === 'copy-relative-path') {
    void input.copyText(projectRelativePath);
    input.closeContextMenu();
    return;
  }

  const node = projectedContextMenuNode(input.activeProjection, projectRelativePath);
  if (!node) {
    input.closeContextMenu();
    return;
  }

  input.actions.selectCanvasEntity({ kind: 'node', projectRelativePath });
  if (input.command === 'show-details') {
    input.openInspectorPanel();
    input.closeContextMenu();
    return;
  }

  if (input.command === 'reveal-in-canvas' && input.activeCanvasNavigationState) {
    input.activeCanvasNavigationState.requestViewportChange(centeredCanvasViewportForNode({
      node,
      surfaceSize: input.activeCanvasNavigationState.surfaceSize,
      viewport: input.activeCanvasNavigationState.viewport
    }));
  }
  input.closeContextMenu();
}

function runExplorerCommand(
  input: Parameters<typeof runWorkbenchContextMenuCommand>[0],
  target: WorkbenchContextMenuTarget,
  projectRelativePath: string
): boolean {
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
  if (input.command === 'rename') {
    input.setInlineProjectTreeEdit(createInlineEditState('renaming', projectRelativePath));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'cut') {
    input.setFileClipboard({ operation: 'cut', projectRelativePath, kind: target.kind });
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'copy') {
    input.setFileClipboard({ operation: 'copy', projectRelativePath, kind: target.kind });
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'paste') {
    runPasteCommand(input, target);
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'copy-path') {
    void input.actions.resolveProjectAbsolutePath(projectRelativePath)
      .then(input.copyText)
      .catch((error) => input.notify(notificationMessageForFileCommandError('Copy path failed', error)));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'copy-relative-path') {
    void input.copyText(projectRelativePath);
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'reveal-in-system-file-manager') {
    void input.actions.revealProjectPathInSystemFileManager({ projectRelativePath, kind: target.kind })
      .catch((error) => input.notify(notificationMessageForFileCommandError('Reveal failed', error)));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'move-to-trash') {
    void input.actions.trashProjectPath({ projectRelativePath })
      .catch((error) => input.notify(notificationMessageForFileCommandError('Move to trash failed', error)));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'delete-permanently') {
    void input.actions.deleteProjectPathPermanently({ projectRelativePath })
      .catch((error) => input.notify(notificationMessageForFileCommandError('Delete failed', error)));
    input.closeContextMenu();
    return true;
  }
  return false;
}

function runPasteCommand(
  input: Parameters<typeof runWorkbenchContextMenuCommand>[0],
  target: WorkbenchContextMenuTarget
): void {
  const fileClipboard = input.fileClipboard;
  if (!fileClipboard) {
    return;
  }
  const paste = fileClipboard.operation === 'cut'
    ? input.actions.moveProjectPath
    : input.actions.copyProjectPath;
  void paste({
    sourceProjectRelativePath: fileClipboard.projectRelativePath,
    targetDirectoryProjectRelativePath: projectTreePasteTargetDirectory(target)
  }).then(() => {
    input.setFileClipboard(clearClipboardAfterPaste(fileClipboard));
  }).catch((error) => {
    input.notify(notificationMessageForFileCommandError('Paste failed', error));
  });
}
