import type { DebruteProductPlatform } from '@debrute/app-protocol';
import type { WorkbenchI18n, WorkbenchTranslationKey } from '../i18n';
import type { ProjectPathCommand } from './contextMenu';

const commandKeys: Record<ProjectPathCommand, WorkbenchTranslationKey> = {
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

export function workbenchContextMenuCommandLabel(command: ProjectPathCommand, i18n: WorkbenchI18n): string {
  return i18n.t(commandKeys[command]);
}

export function projectSystemFileManagerLabelForLocale(platform: DebruteProductPlatform, i18n: WorkbenchI18n): string {
  if (platform === 'darwin') {
    return i18n.t('shell.contextMenu.revealInFinder');
  }
  return i18n.t('shell.contextMenu.revealInFileExplorer');
}
