import type { WorkbenchMenuCommandId, WorkbenchMenuItem } from '@debrute/app-protocol';
import type { DebruteShellApi } from '../../api/shellApi';
import type { WorkbenchApiClient } from '../../types';

export interface TitleBarCommandContext {
  api: WorkbenchApiClient;
  shell: DebruteShellApi | undefined;
  notify(message: string): void;
  openProjectFromPicker(): Promise<void>;
  openProjectRoot(projectRoot: string): Promise<void>;
  refreshTitleBarState(): Promise<void>;
}

export async function executeTitleBarMenuCommand(
  item: Extract<WorkbenchMenuItem, { kind: 'command' }>,
  context: TitleBarCommandContext
): Promise<void> {
  if (!item.enabled) {
    return;
  }
  if (context.shell?.executeNativeMenuCommand) {
    await context.shell.executeNativeMenuCommand({
      commandId: item.commandId,
      ...(item.payload ? { payload: item.payload } : {})
    });
    await context.refreshTitleBarState();
    return;
  }
  await executeBrowserMenuCommand(item.commandId, item.payload, context);
}

async function executeBrowserMenuCommand(
  commandId: WorkbenchMenuCommandId,
  payload: Record<string, string | boolean> | undefined,
  context: TitleBarCommandContext
): Promise<void> {
  switch (commandId) {
    case 'project.open-picker':
      await context.openProjectFromPicker();
      return;
    case 'project.open-recent': {
      const projectRoot = typeof payload?.projectRoot === 'string' ? payload.projectRoot : '';
      if (!projectRoot) {
        throw new Error('Recent project command requires projectRoot.');
      }
      await context.openProjectRoot(projectRoot);
      return;
    }
    case 'project.clear-recent':
      await context.api.clearRecentProjectRoots();
      await context.refreshTitleBarState();
      return;
    case 'edit.undo':
    case 'edit.redo':
    case 'edit.cut':
    case 'edit.copy':
    case 'edit.paste':
    case 'edit.delete':
    case 'edit.select-all':
      executeDocumentEditCommand(commandId);
      return;
    default:
      context.notify(`${commandLabel(commandId)} is not available in this host.`);
  }
}

function executeDocumentEditCommand(commandId: WorkbenchMenuCommandId): void {
  const commandById: Partial<Record<WorkbenchMenuCommandId, string>> = {
    'edit.undo': 'undo',
    'edit.redo': 'redo',
    'edit.cut': 'cut',
    'edit.copy': 'copy',
    'edit.paste': 'paste',
    'edit.delete': 'delete',
    'edit.select-all': 'selectAll'
  };
  const browserCommand = commandById[commandId];
  if (browserCommand) {
    document.execCommand(browserCommand);
  }
}

function commandLabel(commandId: WorkbenchMenuCommandId): string {
  return commandId.split('.').at(-1)?.replaceAll('-', ' ') ?? commandId;
}
