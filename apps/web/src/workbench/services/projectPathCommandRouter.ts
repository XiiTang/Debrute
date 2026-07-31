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

type ProjectPathCommandMenuContext = Omit<
  Parameters<typeof buildWorkbenchContextMenuItems>[0],
  'target' | 'canRevealInCanvas'
>;

type ProjectPathCommandContext = Omit<
  Parameters<typeof runProjectPathCommand>[0],
  | 'scope'
  | 'command'
  | 'contextMenu'
  | 'sendProjectFileToPhotoshop'
  | 'resetCanvasNodeLayouts'
  | 'openTerminalPanel'
>;

export interface ProjectPathCommandRouter {
  contextMenuItems(
    target: WorkbenchContextMenuTarget,
    canRevealInCanvas: boolean
  ): WorkbenchContextMenuItem[];
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
    | 'resetCanvasNodeLayouts'
  >;
  openTerminalPanel(
    scope: AcceptedProjectPathCommandScope,
    cwdProjectRelativePath: string
  ): void;
  menuContext: ProjectPathCommandMenuContext;
  commandContext: ProjectPathCommandContext;
}): ProjectPathCommandRouter {
  return {
    contextMenuItems: (target, canRevealInCanvas) => {
      const items = buildWorkbenchContextMenuItems({
        ...input.menuContext,
        canRevealInCanvas,
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
      runProjectPathCommand({
        ...input.commandContext,
        copyText: (text) => scope.isCurrent()
          ? input.commandContext.copyText(text)
          : undefined,
        notify: (message) => {
          if (scope.isCurrent()) {
            input.commandContext.notify(message);
          }
        },
        startNotification: (message) => {
          const update = input.commandContext.startNotification(message);
          return (nextMessage) => {
            if (scope.isCurrent()) {
              update(nextMessage);
            }
          };
        },
        getProjectSnapshot: () => scope.isCurrent()
          ? input.commandContext.getProjectSnapshot()
          : undefined,
        sendProjectFileToPhotoshop: (sendInput) => (
          input.commandEffects.sendProjectFileToPhotoshop(scope, sendInput)
        ),
        resetCanvasNodeLayouts: (resetInput) => (
          input.commandEffects.resetCanvasNodeLayouts(scope, resetInput)
        ),
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
