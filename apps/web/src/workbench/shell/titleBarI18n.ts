import type { WorkbenchMenu, WorkbenchMenuId, WorkbenchMenuItem } from '@debrute/app-protocol';
import type { WorkbenchI18n, WorkbenchTranslationKey } from '../i18n';

const itemKeys: Record<string, WorkbenchTranslationKey> = {
  'window.new': 'shell.titleBar.newWindow',
  'project.open-picker': 'shell.titleBar.openProject',
  'project.open-picker-new-window': 'shell.titleBar.openProjectNewWindow',
  'project.open-recent': 'shell.titleBar.openRecent',
  'project.clear-recent': 'shell.titleBar.clearRecent',
  'recent:none': 'shell.titleBar.noRecentProjects',
  'window.close': 'shell.titleBar.closeWindow',
  'edit.undo': 'shell.titleBar.undo',
  'edit.redo': 'shell.titleBar.redo',
  'edit.cut': 'shell.contextMenu.cut',
  'edit.copy': 'shell.contextMenu.copy',
  'edit.paste': 'shell.contextMenu.paste',
  'edit.paste-and-match-style': 'shell.titleBar.pasteAndMatchStyle',
  'edit.delete': 'shell.contextMenu.delete',
  'edit.select-all': 'shell.titleBar.selectAll',
  'edit.start-speaking': 'shell.titleBar.startSpeaking',
  'edit.stop-speaking': 'shell.titleBar.stopSpeaking',
  'view.reload': 'shell.titleBar.reload',
  'view.toggle-devtools': 'shell.titleBar.toggleDevtools'
};

const menuKeys: Record<WorkbenchMenuId, WorkbenchTranslationKey> = {
  file: 'shell.titleBar.file',
  edit: 'shell.titleBar.edit',
  view: 'shell.titleBar.view'
};

export function localizedWorkbenchMenus(menus: WorkbenchMenu[], i18n: WorkbenchI18n): WorkbenchMenu[] {
  return menus.map((menu) => ({
    ...menu,
    label: i18n.t(menuKeys[menu.id]),
    items: menu.items.map((item) => localizedWorkbenchMenuItem(item, i18n))
  }));
}

function localizedWorkbenchMenuItem(item: WorkbenchMenuItem, i18n: WorkbenchI18n): WorkbenchMenuItem {
  if (item.kind === 'separator') {
    return item;
  }
  if (item.kind === 'submenu') {
    return {
      ...item,
      label: localizedItemLabel(item.id, item.label, i18n),
      items: item.items.map((child) => localizedWorkbenchMenuItem(child, i18n))
    };
  }
  return {
    ...item,
    label: localizedItemLabel(item.id, item.label, i18n)
  };
}

function localizedItemLabel(
  id: string,
  sourceLabel: string,
  i18n: WorkbenchI18n
): string {
  const key = itemKeys[id];
  if (key) {
    return i18n.t(key);
  }
  if (id.startsWith('recent:')) {
    return sourceLabel;
  }
  throw new Error(`[debrute:i18n] Missing title bar label key for ${id}.`);
}
