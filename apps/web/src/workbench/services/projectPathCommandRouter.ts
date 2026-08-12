import type {
  ProjectPathRef,
  PhotoshopStateView,
  WorkbenchApiClient
} from '@debrute/app-protocol';
import type { CanvasProjection } from '../canvas/CanvasScene';
import type { ProjectExplorerController } from '../project-explorer/useProjectExplorerController';
import {
  buildWorkbenchContextMenuItems,
  projectedContextMenuNode,
  type PhotoshopDocumentTarget,
  type ProjectPathCommand,
  type WorkbenchContextMenuItem,
  type WorkbenchContextMenuPosition,
  type WorkbenchContextMenuTarget
} from '../shell/contextMenu';
import type { ProjectCommandGate } from './projectCommandGate';
import {
  projectPathParent,
  projectPathCommandsAvailable,
  resolveProjectPathCommandTarget
} from './projectPathCommandTarget';
import type { WorkbenchActivityNoticeReporter } from './WorkbenchActivities';

export interface ProjectPathCommandRouter {
  contextMenuItems(target: WorkbenchContextMenuTarget): WorkbenchContextMenuItem[];
  run(
    command: ProjectPathCommand,
    contextMenu: { target: WorkbenchContextMenuTarget; position: WorkbenchContextMenuPosition },
    photoshopTarget?: PhotoshopDocumentTarget
  ): void;
}

export function createProjectPathCommandRouter(input: {
  commandGate: ProjectCommandGate;
  api: Pick<WorkbenchApiClient,
    | 'copyProjectPathsToSystemClipboard'
    | 'sendProjectFileToPhotoshop'
  >;
  projection: CanvasProjection | undefined;
  explorer: ProjectExplorerController;
  photoshop: PhotoshopStateView | undefined;
  activities: WorkbenchActivityNoticeReporter;
  closeContextMenu(): void;
  openTerminalPanel(cwdProjectRelativePath: string): void;
  revealInCanvas(projectRelativePath: string): void;
  inspectEntries(entries: readonly ProjectPathRef[]): void;
  openInspectorPanel(): void;
  resetCanvasNodeLayouts(nodePaths: string[]): Promise<void>;
  confirmTrash(input: { entries: ProjectPathRef[] }): boolean;
  confirmPermanentDelete(input: { entries: ProjectPathRef[] }): boolean;
}): ProjectPathCommandRouter {
  return {
    contextMenuItems(target) {
      const items = buildWorkbenchContextMenuItems({
        target,
        projection: input.projection,
        fileClipboard: input.explorer.fileClipboard,
        photoshop: input.photoshop
      });
      return input.commandGate.available() ? items : disableActions(items);
    },
    run(command, contextMenu, photoshopTarget) {
      input.closeContextMenu();
      const target = contextMenu.target;
      const entries = [...resolveProjectPathCommandTarget(target)];
      const invocation = target.invocation;
      if (command === 'inspect') {
        if (entries.length > 0) {
          input.inspectEntries(entries);
          input.openInspectorPanel();
        }
        return;
      }
      if (command === 'create-file' || command === 'create-directory') {
        if (target.source !== 'explorer') {
          return;
        }
        const parent = invocation.kind === 'directory'
          ? invocation.projectRelativePath
          : projectPathParent(invocation.projectRelativePath);
        input.explorer.beginCreate(command === 'create-file' ? 'file' : 'directory', parent);
        return;
      }
      if (command === 'rename') {
        if (
          target.source === 'explorer'
          && entries.length === 1
          && entries[0]!.projectRelativePath === invocation.projectRelativePath
        ) {
          input.explorer.beginRename(invocation);
        }
        return;
      }
      if (command === 'copy' || command === 'cut') {
        if (projectPathCommandsAvailable(entries)) {
          input.explorer.setClipboard(command, entries);
        }
        return;
      }
      if (command === 'paste') {
        if (invocation.missing === true) {
          return;
        }
        const targetDirectory = invocation.kind === 'directory'
          ? invocation.projectRelativePath
          : projectPathParent(invocation.projectRelativePath);
        input.explorer.paste(targetDirectory);
        return;
      }
      if (command === 'delete' || command === 'delete-permanently') {
        if (!projectPathCommandsAvailable(entries)) {
          return;
        }
        const confirmed = command === 'delete'
          ? input.confirmTrash({ entries })
          : input.confirmPermanentDelete({ entries });
        if (confirmed) {
          input.explorer.deleteEntries(
            command === 'delete' ? 'trash' : 'permanent',
            entries
          );
        }
        return;
      }
      if (command === 'reveal-in-system-file-manager') {
        if (invocation.missing !== true) {
          input.explorer.reveal(invocation);
        }
        return;
      }
      if (command === 'reveal-in-canvas') {
        input.revealInCanvas(invocation.projectRelativePath);
        return;
      }
      if (command === 'open-terminal') {
        input.openTerminalPanel(invocation.kind === 'directory'
          ? invocation.projectRelativePath
          : projectPathParent(invocation.projectRelativePath));
        return;
      }
      if (command === 'copy-path' || command === 'copy-relative-path') {
        const scope = input.commandGate.accept();
        const request = scope?.submit(() => input.api.copyProjectPathsToSystemClipboard({
          format: command === 'copy-path' ? 'absolute' : 'relative',
          entries
        }));
        void request?.catch(() => {
          if (scope?.isCurrent()) {
            input.activities.report({
              kind: target.source === 'canvas'
                ? 'canvas-operation-failed'
                : 'explorer-operation-failed',
              operation: 'copy-path'
            });
          }
        });
        return;
      }
      if (command === 'send-to-photoshop') {
        if (entries.length !== 1 || entries[0]!.kind !== 'file' || !photoshopTarget) {
          return;
        }
        const scope = input.commandGate.accept();
        const entry = entries[0]!;
        const request = scope?.submit(() => input.api.sendProjectFileToPhotoshop({
          projectRelativePath: entry.projectRelativePath,
          pluginSessionId: photoshopTarget.pluginSessionId,
          documentId: photoshopTarget.documentId
        }));
        void request?.catch(() => undefined);
        return;
      }
      if (command === 'reset-auto-layout') {
        const nodes = entries.flatMap((entry) => {
          const node = projectedContextMenuNode(input.projection, entry.projectRelativePath);
          return node ? [node] : [];
        });
        if (nodes.length !== entries.length || !nodes.some((node) => node.layoutMode === 'manual')) {
          return;
        }
        void input.resetCanvasNodeLayouts(nodes.map((node) => node.projectRelativePath)).catch(() => {
          input.activities.report({ kind: 'canvas-operation-failed', operation: 'reset-auto-layout' });
        });
      }
    }
  };
}

function disableActions(items: WorkbenchContextMenuItem[]): WorkbenchContextMenuItem[] {
  return items.map((item) => item.kind === 'action'
    ? { ...item, disabled: true }
    : item.kind === 'photoshop-submenu'
      ? { ...item, targets: [] }
      : item);
}
