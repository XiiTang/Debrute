import type { BaseWindow, BrowserWindow, MenuItem, MenuItemConstructorOptions } from 'electron';
import type {
  WorkbenchMenuCommandId,
  WorkbenchMenuItem,
  WorkbenchTitleBarState
} from '@debrute/app-protocol';

export type ApplicationMenuCommand = {
  commandId: WorkbenchMenuCommandId;
  payload?: Record<string, string | boolean>;
};

type MenuAction = (sourceWindow: BrowserWindow | undefined, command: ApplicationMenuCommand) => void | Promise<void>;

export interface BuildApplicationMenuOptions {
  state: WorkbenchTitleBarState;
  onCommand: MenuAction;
}

export function buildApplicationMenuTemplate({
  state,
  onCommand
}: BuildApplicationMenuOptions): MenuItemConstructorOptions[] {
  return [
    macApplicationMenu(),
    ...state.menus.map((menu) => ({
      label: menu.label,
      submenu: menu.items.map((item) => nativeMenuItem(item, onCommand))
    }))
  ];
}

function nativeMenuItem(item: WorkbenchMenuItem, onCommand: MenuAction): MenuItemConstructorOptions {
  if (item.kind === 'separator') {
    return { type: 'separator' };
  }
  if (item.kind === 'submenu') {
    return {
      label: item.label,
      enabled: item.enabled,
      submenu: item.items.map((subItem) => nativeMenuItem(subItem, onCommand))
    };
  }
  const role = nativeMenuRoleForCommand(item.commandId);
  if (role) {
    return {
      role,
      enabled: item.enabled
    };
  }
  return {
    label: item.label,
    enabled: item.enabled,
    ...(item.accelerator ? { accelerator: item.accelerator } : {}),
    click: (_item: MenuItem, browserWindow: BaseWindow | undefined) => onCommand(menuBrowserWindow(browserWindow), {
      commandId: item.commandId,
      ...(item.payload ? { payload: item.payload } : {})
    })
  };
}

function nativeMenuRoleForCommand(commandId: WorkbenchMenuCommandId): MenuItemConstructorOptions['role'] | undefined {
  if (commandId === 'edit.undo') {
    return 'undo';
  }
  if (commandId === 'edit.redo') {
    return 'redo';
  }
  if (commandId === 'edit.cut') {
    return 'cut';
  }
  if (commandId === 'edit.copy') {
    return 'copy';
  }
  if (commandId === 'edit.paste') {
    return 'paste';
  }
  if (commandId === 'edit.paste-and-match-style') {
    return 'pasteAndMatchStyle';
  }
  if (commandId === 'edit.delete') {
    return 'delete';
  }
  if (commandId === 'edit.select-all') {
    return 'selectAll';
  }
  if (commandId === 'edit.start-speaking') {
    return 'startSpeaking';
  }
  if (commandId === 'edit.stop-speaking') {
    return 'stopSpeaking';
  }
  return undefined;
}

function macApplicationMenu(): MenuItemConstructorOptions {
  return {
    label: 'Debrute',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  };
}

function menuBrowserWindow(window: BaseWindow | undefined): BrowserWindow | undefined {
  return window as BrowserWindow | undefined;
}
