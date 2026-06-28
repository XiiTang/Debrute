import type { WorkbenchI18n, WorkbenchTranslationKey } from '../i18n';
import type { WorkbenchContextMenuCommand } from './contextMenu';

const commandKeys: Record<WorkbenchContextMenuCommand, WorkbenchTranslationKey> = {
  'send-to-photoshop': 'shell.contextMenu.sendToPhotoshop',
  'show-details': 'shell.contextMenu.showDetails',
  'reveal-in-canvas': 'shell.contextMenu.revealInCanvas',
  'reset-auto-layout': 'shell.contextMenu.resetAutoLayout',
  'create-file': 'shell.contextMenu.newFile',
  'create-directory': 'shell.contextMenu.newFolder',
  cut: 'shell.contextMenu.cut',
  copy: 'shell.contextMenu.copy',
  paste: 'shell.contextMenu.paste',
  'copy-path': 'shell.contextMenu.copyPath',
  'reveal-in-system-file-manager': 'shell.contextMenu.openContainingFolder',
  rename: 'shell.contextMenu.rename',
  delete: 'shell.contextMenu.delete',
  'delete-permanently': 'shell.contextMenu.deletePermanently',
  'open-terminal': 'shell.contextMenu.openInTerminal',
  'copy-relative-path': 'shell.contextMenu.copyRelativePath'
};

export function workbenchContextMenuCommandLabel(command: WorkbenchContextMenuCommand, i18n: WorkbenchI18n): string {
  return i18n.t(commandKeys[command]);
}

export function projectSystemFileManagerLabelForLocale(platform: NodeJS.Platform, i18n: WorkbenchI18n): string {
  if (platform === 'darwin') {
    return i18n.t('shell.contextMenu.revealInFinder');
  }
  if (platform === 'win32') {
    return i18n.t('shell.contextMenu.revealInFileExplorer');
  }
  return i18n.t('shell.contextMenu.openContainingFolder');
}
