import type { NativeMenuCommandId } from '@debrute/app-protocol';
import type { DebruteShellApi } from '../../api/shellApi';
import type { WorkbenchApiClient } from '../../types';
import type { WorkbenchMenuCommandId, WorkbenchMenuItem } from './workbenchTitleBarState';

export interface TitleBarCommandContext {
  api: WorkbenchApiClient;
  shell: DebruteShellApi | undefined;
  openProjectFromPicker(): Promise<void>;
  openProjectRoot(projectRoot: string): Promise<void>;
}

export async function executeTitleBarMenuCommand(
  item: Extract<WorkbenchMenuItem, { kind: 'command' }>,
  context: TitleBarCommandContext
): Promise<void> {
  if (!item.enabled) {
    return;
  }
  if (context.shell && isNativeMenuCommand(item.commandId)) {
    await context.shell.executeNativeMenuCommand({ commandId: item.commandId });
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
      throw new Error(`Title-bar command requires the native Desktop shell: ${commandId}`);
  }
}

function executeDocumentEditCommand(
  commandId: 'edit.undo' | 'edit.redo' | 'edit.cut' | 'edit.copy' | 'edit.paste' | 'edit.delete' | 'edit.select-all'
): void {
  const commandById = {
    'edit.undo': 'undo',
    'edit.redo': 'redo',
    'edit.cut': 'cut',
    'edit.copy': 'copy',
    'edit.paste': 'paste',
    'edit.delete': 'delete',
    'edit.select-all': 'selectAll'
  } as const;
  document.execCommand(commandById[commandId]);
}

function isNativeMenuCommand(commandId: WorkbenchMenuCommandId): commandId is NativeMenuCommandId {
  return commandId !== 'project.open-picker'
    && commandId !== 'project.open-recent'
    && commandId !== 'project.clear-recent';
}
