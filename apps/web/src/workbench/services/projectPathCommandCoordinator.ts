import {
  buildWorkbenchContextMenuItems,
  type ProjectPathCommand,
  type WorkbenchContextMenuItem,
  type WorkbenchContextMenuTarget
} from '../shell/contextMenu';
import { runProjectPathCommand } from './workbenchContextMenuCommands';

type ProjectPathCommandMenuContext = Omit<
  Parameters<typeof buildWorkbenchContextMenuItems>[0],
  'target'
>;

type ProjectPathCommandContext = Omit<
  Parameters<typeof runProjectPathCommand>[0],
  'command' | 'contextMenu'
>;

export interface ProjectPathCommandCoordinator {
  contextMenuItems(target: WorkbenchContextMenuTarget): WorkbenchContextMenuItem[];
  run(
    command: ProjectPathCommand,
    contextMenu: Parameters<typeof runProjectPathCommand>[0]['contextMenu']
  ): void;
}

export function createProjectPathCommandCoordinator(input: {
  canStartCommand(): boolean;
  isCurrentScope(): boolean;
  menuContext: ProjectPathCommandMenuContext;
  commandContext: ProjectPathCommandContext;
}): ProjectPathCommandCoordinator {
  return {
    contextMenuItems: (target) => {
      const items = buildWorkbenchContextMenuItems({
        ...input.menuContext,
        target
      });
      return input.canStartCommand() ? items : disableActions(items);
    },
    run: (command, contextMenu) => {
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
        contextMenu
      });
    }
  };
}

function disableActions(items: WorkbenchContextMenuItem[]): WorkbenchContextMenuItem[] {
  return items.map((item) => item.kind === 'action'
    ? { ...item, disabled: true }
    : item);
}
