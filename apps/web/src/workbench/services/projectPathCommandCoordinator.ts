import {
  buildWorkbenchContextMenuItems,
  type ProjectPathCommand,
  type PhotoshopDocumentTarget,
  type WorkbenchContextMenuItem,
  type WorkbenchContextMenuTarget
} from '../shell/contextMenu';
import { runProjectPathCommand } from './workbenchContextMenuCommands';

type ProjectPathCommandMenuContext = Omit<
  Parameters<typeof buildWorkbenchContextMenuItems>[0],
  'target' | 'canRevealInCanvas'
>;

type ProjectPathCommandContext = Omit<
  Parameters<typeof runProjectPathCommand>[0],
  'command' | 'contextMenu'
>;

export interface ProjectPathCommandCoordinator {
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

export function createProjectPathCommandCoordinator(input: {
  canStartCommand(): boolean;
  isCurrentScope(): boolean;
  menuContext: ProjectPathCommandMenuContext;
  commandContext: ProjectPathCommandContext;
}): ProjectPathCommandCoordinator {
  return {
    contextMenuItems: (target, canRevealInCanvas) => {
      const items = buildWorkbenchContextMenuItems({
        ...input.menuContext,
        canRevealInCanvas,
        target
      });
      return input.canStartCommand() ? items : disableActions(items);
    },
    run: (command, contextMenu, photoshopTarget) => {
      if (!input.canStartCommand()) {
        input.commandContext.closeContextMenu();
        return;
      }
      runProjectPathCommand({
        ...input.commandContext,
        copyText: (text) => input.isCurrentScope()
          ? input.commandContext.copyText(text)
          : undefined,
        notify: (message) => {
          if (input.isCurrentScope()) {
            input.commandContext.notify(message);
          }
        },
        getProjectSnapshot: () => input.isCurrentScope()
          ? input.commandContext.getProjectSnapshot()
          : undefined,
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
