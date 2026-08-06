import {
  buildWorkbenchContextMenuItems,
  type ProjectPathCommand,
  type PhotoshopDocumentTarget,
  type WorkbenchContextMenuItem,
  type WorkbenchContextMenuTarget
} from '../shell/contextMenu.js';
import { runProjectPathCommand } from './workbenchContextMenuCommands.js';
import type { ProjectPathCommandEffects } from './projectPathCommandEffects.js';
import type {
  AcceptedProjectPathCommandScope,
  ProjectPathCommandIntake
} from './projectPathCommandIntake.js';
import { scopeWorkbenchActivityNoticeReporter } from './WorkbenchActivities.js';

type ProjectPathCommandMenuContext = Omit<
  Parameters<typeof buildWorkbenchContextMenuItems>[0],
  'target'
>;

type ProjectPathCommandContext = Omit<
  Parameters<typeof runProjectPathCommand>[0],
  | 'scope'
  | 'command'
  | 'contextMenu'
  | 'sendProjectFileToPhotoshop'
  | 'copyProjectPathsToSystemClipboard'
  | 'openTerminalPanel'
>;

export interface ProjectPathCommandRouter {
  contextMenuItems(target: WorkbenchContextMenuTarget): WorkbenchContextMenuItem[];
  run(
    command: ProjectPathCommand,
    contextMenu: Parameters<typeof runProjectPathCommand>[0]['contextMenu'],
    photoshopTarget?: PhotoshopDocumentTarget
  ): void;
}

export function createProjectPathCommandRouter(input: {
  commandIntake: ProjectPathCommandIntake;
  commandEffects: Pick<ProjectPathCommandEffects,
    | 'sendProjectFileToPhotoshop'
    | 'copyProjectPathsToSystemClipboard'
  >;
  openTerminalPanel(
    scope: AcceptedProjectPathCommandScope,
    cwdProjectRelativePath: string
  ): void;
  menuContext: ProjectPathCommandMenuContext;
  commandContext: ProjectPathCommandContext;
}): ProjectPathCommandRouter {
  return {
    contextMenuItems: (target) => {
      const items = buildWorkbenchContextMenuItems({
        ...input.menuContext,
        target
      });
      return input.commandIntake.canAccept() ? items : disableActions(items);
    },
    run: (command, contextMenu, photoshopTarget) => {
      const scope = input.commandIntake.tryAccept();
      if (!scope) {
        input.commandContext.closeContextMenu();
        return;
      }
      const activities = scopeWorkbenchActivityNoticeReporter(
        input.commandContext.activities,
        () => scope.isCurrent()
      );
      runProjectPathCommand({
        ...input.commandContext,
        activities,
        getProjectSnapshot: () => scope.isCurrent()
          ? input.commandContext.getProjectSnapshot()
          : undefined,
        sendProjectFileToPhotoshop: (sendInput) => (
          input.commandEffects.sendProjectFileToPhotoshop(scope, sendInput)
        ),
        copyProjectPathsToSystemClipboard: (clipboardInput) => (
          input.commandEffects.copyProjectPathsToSystemClipboard(scope, clipboardInput)
        ),
        resetCanvasNodeLayouts: (canvasId, nodePaths) => scope.canSubmit()
          ? input.commandContext.resetCanvasNodeLayouts(canvasId, nodePaths)
          : undefined,
        openTerminalPanel: (cwdProjectRelativePath) => {
          input.openTerminalPanel(scope, cwdProjectRelativePath);
        },
        scope,
        command,
        contextMenu,
        ...(photoshopTarget === undefined ? {} : { photoshopTarget })
      });
    }
  };
}

function disableActions(items: WorkbenchContextMenuItem[]): WorkbenchContextMenuItem[] {
  return items.map((item) => {
    if (item.kind === 'action') {
      return { ...item, disabled: true };
    }
    if (item.kind === 'photoshop-submenu') {
      return { ...item, targets: [] };
    }
    return item;
  });
}
