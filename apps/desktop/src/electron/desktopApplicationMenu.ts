import type { DebruteProductPlatform, NativeEditCommandId } from '@debrute/app-protocol';

export interface DesktopApplicationMenuInput {
  platform: DebruteProductPlatform;
  recentItems: Electron.MenuItemConstructorOptions[];
  newWindow(): void;
  openProject(window: Electron.BaseWindow | undefined): void;
  reloadWorkbench(window: Electron.BaseWindow | undefined): void;
  dispatchEditCommand(window: Electron.BaseWindow | undefined, command: NativeEditCommandId): void;
  quitProduct(): void;
}

export function buildDesktopDockMenu(
  newWindow: () => void
): Electron.MenuItemConstructorOptions[] {
  return [{ label: 'New Window', click: newWindow }];
}

export function buildDesktopApplicationMenu(
  input: DesktopApplicationMenuInput
): Electron.MenuItemConstructorOptions[] {
  const closeItems: Electron.MenuItemConstructorOptions[] = input.platform === 'darwin'
    ? [{ role: 'close' }]
    : [
        { label: 'Close Window', accelerator: 'Ctrl+W', role: 'close' },
        { type: 'separator' },
        { label: 'Quit Debrute', accelerator: 'Ctrl+Q', click: input.quitProduct }
      ];
  return [
    ...(input.platform === 'darwin' ? [{
      label: 'Debrute',
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: input.newWindow },
        { type: 'separator' },
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: (_item, window) => input.openProject(window)
        },
        { label: 'Open Recent', submenu: input.recentItems },
        { type: 'separator' },
        ...closeItems
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        editCommandItem('Cut', 'CmdOrCtrl+X', 'edit.cut', input),
        editCommandItem('Copy', 'CmdOrCtrl+C', 'edit.copy', input),
        editCommandItem('Paste', 'CmdOrCtrl+V', 'edit.paste', input),
        ...(input.platform === 'darwin' ? [{ role: 'pasteAndMatchStyle' as const }] : []),
        editCommandItem('Delete', input.platform === 'darwin' ? 'Command+Backspace' : 'Delete', 'edit.delete', input),
        editCommandItem('Select All', 'CmdOrCtrl+A', 'edit.select-all', input),
        ...(input.platform === 'darwin' ? [
          { type: 'separator' as const },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' as const },
              { role: 'stopSpeaking' as const }
            ]
          }
        ] : [])
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Workbench',
          accelerator: 'CmdOrCtrl+R',
          click: (_item, window) => input.reloadWorkbench(window)
        },
        { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
}

function editCommandItem(
  label: string,
  accelerator: string,
  command: NativeEditCommandId,
  input: DesktopApplicationMenuInput
): Electron.MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: (_item, window) => input.dispatchEditCommand(window, command)
  };
}
