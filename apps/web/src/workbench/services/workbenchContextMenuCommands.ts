import type {
  ProjectPathEntry,
  WorkbenchApiClient,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import type { CanvasProjection } from '@debrute/canvas-core';
import type { CanvasEditorRuntime } from '../canvas/runtime/CanvasEditorRuntime.js';
import { projectTreePasteTargetDirectory } from '../project-explorer/projectTreeEditing.js';
import { projectTreeBatchMoveHasConflict } from '../project-explorer/projectTreeInteraction.js';
import type { ProjectExplorerController } from '../project-explorer/useProjectExplorerController.js';
import { notificationMessageForFileCommandError } from '../project-explorer/workbenchFileCommands.js';
import type { AcceptedProjectPathCommandScope } from './projectPathCommandIntake.js';
import {
  cameraCenteredOnNode,
  explorerContextMenuEntries,
  explorerContextMenuPrimaryEntry,
  explorerContextMenuProjectRelativePaths,
  projectedContextMenuNode,
  type ProjectPathCommand,
  type PhotoshopDocumentTarget,
  type WorkbenchContextMenuPosition,
  type WorkbenchContextMenuTarget,
  type WorkbenchFileClipboard
} from '../shell/contextMenu.js';

export interface ProjectPathCommandErrorLabels {
  copyPathFailed: string;
  resetAutoLayoutFailed: string;
}

type CanvasLayoutResetInput =
  | { all: true }
  | { pathRules: { paths: string[]; globs: string[] } };

type ExplorerContextCommands = Pick<ProjectExplorerController,
  | 'beginCreateFile'
  | 'beginCreateDirectory'
  | 'beginRename'
  | 'copyEntries'
  | 'cutEntries'
  | 'pasteEntries'
  | 'copyAbsolutePaths'
  | 'revealEntry'
  | 'trashEntries'
  | 'deleteEntriesPermanently'
>;

export function runProjectPathCommand(input: {
  scope: AcceptedProjectPathCommandScope;
  command: ProjectPathCommand;
  photoshopTarget?: PhotoshopDocumentTarget;
  contextMenu: { target: WorkbenchContextMenuTarget; position: WorkbenchContextMenuPosition } | undefined;
  activeProjection: CanvasProjection | undefined;
  activeCanvasRuntime: CanvasEditorRuntime | undefined;
  fileClipboard: WorkbenchFileClipboard | undefined;
  resetCanvasNodeLayouts(
    input: Parameters<WorkbenchApiClient['resetCanvasNodeLayouts']>[0]
  ): ReturnType<WorkbenchApiClient['resetCanvasNodeLayouts']> | undefined;
  openTerminalPanel(cwdProjectRelativePath: string): void;
  sendProjectFileToPhotoshop(
    input: Parameters<WorkbenchApiClient['sendProjectFileToPhotoshop']>[0]
  ): ReturnType<WorkbenchApiClient['sendProjectFileToPhotoshop']> | undefined;
  explorerCommands: ExplorerContextCommands;
  copyText: (text: string) => void | Promise<void>;
  notify: (message: string) => void;
  startNotification: (message: string) => (message: string) => void;
  photoshopLabels: {
    sending(path: string, documentTitle: string): string;
    sent(path: string, documentTitle: string): string;
    failed(message: string): string;
  };
  closeContextMenu: () => void;
  openInspectorPanel: () => void;
  confirmPermanentDelete: (input: { entries: ProjectPathEntry[] }) => boolean;
  getProjectSnapshot(): WorkbenchProjectSessionSnapshot | undefined;
  confirmMoveOverwrite: (input: {
    entries: ProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
  }) => boolean;
  errorLabels: ProjectPathCommandErrorLabels;
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
      const resetInput = canvasLayoutResetInputForTarget(primaryEntry);
      const request = input.resetCanvasNodeLayouts(
        'all' in resetInput
          ? { canvasId, all: true }
          : { canvasId, pathRules: resetInput.pathRules }
      );
      void request?.then(() => {
        const acceptedProjection = input.getProjectSnapshot()
          ?.projections.find((projection) => projection.canvasId === canvasId);
        const updatedNode = projectedContextMenuNode(acceptedProjection, projectRelativePath);
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
        input.notify(notificationMessageForFileCommandError(input.errorLabels.resetAutoLayoutFailed, error));
      });
    }
  }
  input.closeContextMenu();
}

function canvasLayoutResetInputForTarget(
  target: ProjectPathEntry
): CanvasLayoutResetInput {
  if (target.kind === 'directory' && target.projectRelativePath === '') {
    return { all: true };
  }
  return {
    pathRules: {
      paths: [target.kind === 'directory' ? `${target.projectRelativePath}/` : target.projectRelativePath],
      globs: []
    }
  };
}

function runSinglePathFileCommand(
  input: Parameters<typeof runProjectPathCommand>[0],
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
    input.explorerCommands.cutEntries(input.scope, entries);
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'copy') {
    if (canvasProjectRoot) {
      input.closeContextMenu();
      return true;
    }
    input.explorerCommands.copyEntries(input.scope, entries);
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
    void input.explorerCommands.copyAbsolutePaths(input.scope, entries)
      .then((paths) => paths ? input.copyText(paths.join('\n')) : undefined)
      .catch((error) => input.notify(notificationMessageForFileCommandError(input.errorLabels.copyPathFailed, error)));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'copy-relative-path') {
    if (canvasProjectRoot) {
      input.closeContextMenu();
      return true;
    }
    void Promise.resolve(input.copyText(explorerContextMenuProjectRelativePaths(target).join('\n')))
      .catch((error) => input.notify(notificationMessageForFileCommandError(input.errorLabels.copyPathFailed, error)));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'open-terminal') {
    input.openTerminalPanel(terminalCwdForEntry(primaryEntry));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'send-to-photoshop') {
    if (primaryEntry.kind === 'file' && input.photoshopTarget) {
      const destination = input.photoshopTarget;
      const request = input.sendProjectFileToPhotoshop({
        projectRelativePath: primaryEntry.projectRelativePath,
        pluginSessionId: destination.pluginSessionId,
        documentId: destination.documentId
      });
      if (request) {
        const updateNotification = input.startNotification(input.photoshopLabels.sending(
          primaryEntry.projectRelativePath,
          destination.title
        ));
        void request.then((result) => {
          updateNotification(input.photoshopLabels.sent(
            primaryEntry.projectRelativePath,
            result.documentTitle
          ));
        }).catch((error) => {
          updateNotification(input.photoshopLabels.failed(errorMessage(error)));
        });
      }
    }
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'reveal-in-system-file-manager') {
    input.explorerCommands.revealEntry(input.scope, primaryEntry);
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'delete') {
    if (canvasProjectRoot) {
      input.closeContextMenu();
      return true;
    }
    input.explorerCommands.trashEntries(input.scope, entries);
    input.closeContextMenu();
    return true;
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runExplorerSpecificCommand(
  input: Parameters<typeof runProjectPathCommand>[0],
  target: Extract<WorkbenchContextMenuTarget, { source: 'explorer' }>
): boolean {
  const entries = explorerContextMenuEntries(target);
  const primaryEntry = explorerContextMenuPrimaryEntry(target);
  if (target.targetKind === 'root') {
    if (input.command === 'create-file') {
      input.explorerCommands.beginCreateFile(input.scope, projectTreePasteTargetDirectory(target));
      input.closeContextMenu();
      return true;
    }
    if (input.command === 'create-directory') {
      input.explorerCommands.beginCreateDirectory(input.scope, projectTreePasteTargetDirectory(target));
      input.closeContextMenu();
      return true;
    }
    if (input.command === 'paste') {
      runPasteCommand(input, target);
      input.closeContextMenu();
      return true;
    }
    if (input.command === 'open-terminal') {
      input.openTerminalPanel('');
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
    input.explorerCommands.beginCreateFile(input.scope, projectTreePasteTargetDirectory(target));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'create-directory') {
    if (target.targetKind !== 'item' || primaryEntry?.kind !== 'directory') {
      input.closeContextMenu();
      return true;
    }
    input.explorerCommands.beginCreateDirectory(input.scope, projectTreePasteTargetDirectory(target));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'rename') {
    if (primaryEntry && entries.length === 1) {
      input.explorerCommands.beginRename(input.scope, primaryEntry);
    }
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'delete-permanently') {
    if (!input.confirmPermanentDelete({ entries })) {
      input.closeContextMenu();
      return true;
    }
    input.explorerCommands.deleteEntriesPermanently(input.scope, entries);
    input.closeContextMenu();
    return true;
  }
  return false;
}

function terminalCwdForEntry(entry: ProjectPathEntry): string {
  if (entry.kind === 'directory') {
    return entry.projectRelativePath;
  }
  const slashIndex = entry.projectRelativePath.lastIndexOf('/');
  return slashIndex < 0 ? '' : entry.projectRelativePath.slice(0, slashIndex);
}

function isCanvasProjectRootTarget(
  target: WorkbenchContextMenuTarget,
  entry: ProjectPathEntry
): boolean {
  return target.source === 'canvas'
    && entry.kind === 'directory'
    && entry.projectRelativePath === '';
}

function runPasteCommand(
  input: Parameters<typeof runProjectPathCommand>[0],
  target: WorkbenchContextMenuTarget
): void {
  const fileClipboard = input.fileClipboard;
  if (!fileClipboard || fileClipboard.entries.length === 0) {
    return;
  }
  const targetDirectoryProjectRelativePath = projectTreePasteTargetDirectory(target);
  if (fileClipboard.operation === 'cut') {
    const snapshot = input.getProjectSnapshot();
    const overwrite = snapshot && projectTreeBatchMoveHasConflict({
      existingProjectRelativePaths: new Set(snapshot.files.map((file) => file.projectRelativePath)),
      entries: fileClipboard.entries,
      targetDirectoryProjectRelativePath
    });
    if (overwrite && !input.confirmMoveOverwrite({
      entries: fileClipboard.entries,
      targetDirectoryProjectRelativePath
    })) {
      return;
    }
    input.explorerCommands.pasteEntries(input.scope, {
      clipboard: fileClipboard,
      targetDirectoryProjectRelativePath,
      ...(overwrite ? { overwrite: true } : {})
    });
    return;
  }
  input.explorerCommands.pasteEntries(input.scope, {
    clipboard: fileClipboard,
    targetDirectoryProjectRelativePath
  });
}
