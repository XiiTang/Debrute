import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type { ProjectPathKind } from '@axis/project-core';

export interface ProjectShellLike {
  showItemInFolder(path: string): void;
  openPath(path: string): Promise<string>;
  trashItem(path: string): Promise<void>;
}

export interface ProjectDialogLike {
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
}

export async function revealProjectPathWithShell(
  shell: Pick<ProjectShellLike, 'showItemInFolder' | 'openPath'>,
  input: { absolutePath: string; kind: ProjectPathKind }
): Promise<{ ok: true }> {
  if (input.kind === 'directory') {
    const error = await shell.openPath(input.absolutePath);
    if (error) {
      throw new Error(error);
    }
    return { ok: true };
  }
  shell.showItemInFolder(input.absolutePath);
  return { ok: true };
}

export async function trashProjectPathWithShell(
  shell: Pick<ProjectShellLike, 'trashItem'>,
  absolutePath: string
): Promise<{ ok: true }> {
  await shell.trashItem(absolutePath);
  return { ok: true };
}

export async function shouldDeleteProjectPathPermanently(
  dialog: Pick<ProjectDialogLike, 'showMessageBox'>,
  projectRelativePath: string
): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: ['Delete Permanently', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Delete "${projectRelativePath}" permanently?`,
    detail: 'This removes the project file or folder without moving it to the system trash.'
  };
  const result = await dialog.showMessageBox(options);
  return result.response === 0;
}
