import type {
  ProjectPathEntry,
  WorkbenchApiClient,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import type { CanvasProjection } from '../canvas/CanvasScene.js';
import type { CanvasEditorRuntime } from '../canvas/runtime/CanvasEditorRuntime.js';
import { projectTreePasteTargetDirectory } from '../project-explorer/projectTreeEditing.js';
import { projectTreeBatchMoveHasConflict } from '../project-explorer/projectTreeInteraction.js';
import type { ProjectExplorerController } from '../project-explorer/useProjectExplorerController.js';
import type { AcceptedProjectPathCommandScope } from './projectPathCommandIntake.js';
import {
  explorerContextMenuEntries,
  explorerContextMenuPrimaryEntry,
  projectedContextMenuNode,
  type ProjectPathCommand,
  type PhotoshopDocumentTarget,
  type WorkbenchContextMenuPosition,
  type WorkbenchContextMenuTarget,
  type WorkbenchFileClipboard
} from '../shell/contextMenu.js';
import { resolveProjectPathCommandTarget } from './projectPathCommandTarget.js';
import type { WorkbenchActivityNoticeReporter } from './WorkbenchActivities.js';

type ExplorerContextCommands = Pick<ProjectExplorerController,
  | 'beginCreateFile'
  | 'beginCreateDirectory'
  | 'beginRename'
  | 'copyEntries'
  | 'cutEntries'
  | 'pasteEntries'
  | 'revealEntry'
  | 'trashEntries'
  | 'deleteEntriesPermanently'
>;

export function runProjectPathCommand(input: {
  scope: AcceptedProjectPathCommandScope;
  command: ProjectPathCommand;
  photoshopTarget?: PhotoshopDocumentTarget;
  contextMenu: { target: WorkbenchContextMenuTarget; position: WorkbenchContextMenuPosition } | undefined;
  canvasProjection: CanvasProjection | undefined;
  canvasRuntime: CanvasEditorRuntime | undefined;
  fileClipboard: WorkbenchFileClipboard | undefined;
  resetCanvasNodeLayouts(nodePaths: string[]): Promise<void> | undefined;
  openTerminalPanel(cwdProjectRelativePath: string): void;
  revealInCanvas(projectRelativePath: string): void;
  sendProjectFileToPhotoshop(
    input: Parameters<WorkbenchApiClient['sendProjectFileToPhotoshop']>[0]
  ): ReturnType<WorkbenchApiClient['sendProjectFileToPhotoshop']> | undefined;
  copyProjectPathsToSystemClipboard(
    input: Parameters<WorkbenchApiClient['copyProjectPathsToSystemClipboard']>[0]
  ): ReturnType<WorkbenchApiClient['copyProjectPathsToSystemClipboard']> | undefined;
  explorerCommands: ExplorerContextCommands;
  activities: WorkbenchActivityNoticeReporter;
  closeContextMenu: () => void;
  openInspectorPanel: () => void;
  confirmPermanentDelete: (input: { entries: ProjectPathEntry[] }) => boolean;
  confirmTrash: (input: { entries: ProjectPathEntry[] }) => boolean;
  getProjectSnapshot(): WorkbenchProjectSessionSnapshot | undefined;
  confirmMoveOverwrite: (input: {
    entries: ProjectPathEntry[];
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
    if (target.selectedEntries.length === 0) {
      input.closeContextMenu();
      return;
    }
  }

  if (runSinglePathFileCommand(input, target)) {
    return;
  }

  const primaryEntry = explorerContextMenuPrimaryEntry(target);
  if (!primaryEntry) {
    input.closeContextMenu();
    return;
  }
  const projectRelativePath = primaryEntry.projectRelativePath;

  const node = projectedContextMenuNode(input.canvasProjection, projectRelativePath);
  if (!node) {
    input.closeContextMenu();
    return;
  }

  if (input.command === 'show-details') {
    input.openInspectorPanel();
    input.closeContextMenu();
    return;
  }

  if (input.command === 'reset-auto-layout') {
    const selectionEntries = resolveProjectPathCommandTarget(target).selectionEntries;
    const selectedNodes = selectionEntries.flatMap((entry) => {
      const selectedNode = projectedContextMenuNode(input.canvasProjection, entry.projectRelativePath);
      return selectedNode ? [selectedNode] : [];
    });
    if (
      selectedNodes.length !== selectionEntries.length
      || !selectedNodes.some((selectedNode) => selectedNode.layoutMode === 'manual')
    ) {
      input.closeContextMenu();
      return;
    }
    const request = input.resetCanvasNodeLayouts(
      selectedNodes.map((selectedNode) => selectedNode.projectRelativePath)
    );
    void request?.catch(() => {
      input.activities.report({
        kind: 'canvas-operation-failed',
        operation: 'reset-auto-layout'
      });
    });
  }
  input.closeContextMenu();
}

function runSinglePathFileCommand(
  input: Parameters<typeof runProjectPathCommand>[0],
  target: WorkbenchContextMenuTarget
): boolean {
  const primaryEntry = explorerContextMenuPrimaryEntry(target);
  if (!primaryEntry) {
    return false;
  }
  const resolved = resolveProjectPathCommandTarget(target);
  const entries = [...resolved.effectiveFilesystemEntries];
  if (input.command === 'cut') {
    if (!resolved.filesystemCommandsAvailable) {
      input.closeContextMenu();
      return true;
    }
    input.explorerCommands.cutEntries(input.scope, entries);
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'copy') {
    if (!resolved.filesystemCommandsAvailable) {
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
  if (input.command === 'copy-path' || input.command === 'copy-relative-path') {
    const request = input.copyProjectPathsToSystemClipboard({
      format: input.command === 'copy-path' ? 'absolute' : 'relative',
      entries: [...resolved.selectionEntries]
    });
    void request?.catch(() => {
      input.activities.report({
        kind: target.source === 'canvas'
          ? 'canvas-operation-failed'
          : 'explorer-operation-failed',
        operation: 'copy-path'
      });
    });
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'open-terminal') {
    input.openTerminalPanel(terminalCwdForEntry(primaryEntry));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'reveal-in-canvas') {
    input.revealInCanvas(primaryEntry.projectRelativePath);
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'send-to-photoshop') {
    const singleEntry = resolved.selectionEntries.length === 1 ? resolved.selectionEntries[0] : undefined;
    if (singleEntry?.kind === 'file' && input.photoshopTarget) {
      const destination = input.photoshopTarget;
      const request = input.sendProjectFileToPhotoshop({
        projectRelativePath: singleEntry.projectRelativePath,
        pluginSessionId: destination.pluginSessionId,
        documentId: destination.documentId
      });
      void request?.catch(() => undefined);
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
    if (!resolved.filesystemCommandsAvailable || !input.confirmTrash({ entries })) {
      input.closeContextMenu();
      return true;
    }
    input.explorerCommands.trashEntries(input.scope, entries);
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'delete-permanently') {
    if (
      !resolved.filesystemCommandsAvailable
      || !input.confirmPermanentDelete({ entries })
    ) {
      input.closeContextMenu();
      return true;
    }
    input.explorerCommands.deleteEntriesPermanently(input.scope, entries);
    input.closeContextMenu();
    return true;
  }
  return false;
}

function runExplorerSpecificCommand(
  input: Parameters<typeof runProjectPathCommand>[0],
  target: Extract<WorkbenchContextMenuTarget, { source: 'explorer' }>
): boolean {
  const entries = explorerContextMenuEntries(target);
  const primaryEntry = explorerContextMenuPrimaryEntry(target);
  if (target.selectedEntries.length === 0) {
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
    if (entries.length !== 1 || primaryEntry?.kind !== 'directory') {
      input.closeContextMenu();
      return true;
    }
    input.explorerCommands.beginCreateFile(input.scope, projectTreePasteTargetDirectory(target));
    input.closeContextMenu();
    return true;
  }
  if (input.command === 'create-directory') {
    if (entries.length !== 1 || primaryEntry?.kind !== 'directory') {
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
  return false;
}

function terminalCwdForEntry(entry: ProjectPathEntry): string {
  if (entry.kind === 'directory') {
    return entry.projectRelativePath;
  }
  const slashIndex = entry.projectRelativePath.lastIndexOf('/');
  return slashIndex < 0 ? '' : entry.projectRelativePath.slice(0, slashIndex);
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
      existingProjectRelativePaths: new Set(snapshot.projectTree.map((entry) => entry.projectRelativePath)),
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
