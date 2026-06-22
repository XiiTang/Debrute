import type { WorkbenchMenuId } from '@debrute/app-protocol';

export type OpenTitleBarMenu = WorkbenchMenuId | undefined;
export type TitleBarMenuKeyAction = 'close-menu' | 'open-submenu' | 'close-submenu';

export function openTitleBarMenu(_current: OpenTitleBarMenu, menuId: WorkbenchMenuId): OpenTitleBarMenu {
  return menuId;
}

export function switchTitleBarMenuOnHover(current: OpenTitleBarMenu, menuId: WorkbenchMenuId): OpenTitleBarMenu {
  return current ? menuId : undefined;
}

export function closeTitleBarMenu(_current: OpenTitleBarMenu): OpenTitleBarMenu {
  return undefined;
}

export function titleBarMenuKeyAction(key: string): TitleBarMenuKeyAction | undefined {
  if (key === 'Escape') {
    return 'close-menu';
  }
  if (key === 'ArrowRight') {
    return 'open-submenu';
  }
  if (key === 'ArrowLeft') {
    return 'close-submenu';
  }
  return undefined;
}
