import type { DebruteProductPlatform } from '@debrute/app-protocol';

export interface DesktopApplicationMenuInput {
  platform: DebruteProductPlatform;
  recentItems: Electron.MenuItemConstructorOptions[];
  newWindow(): void;
  openProject(window: Electron.BaseWindow | undefined): void;
  openProjectInNewWindow(): void;
  reloadWorkbench(window: Electron.BaseWindow | undefined): void;
  quitProduct(): void;
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
        {
          label: 'Open Project in New Window…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: input.openProjectInNewWindow
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
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        ...(input.platform === 'darwin' ? [{ role: 'pasteAndMatchStyle' as const }] : []),
        { role: 'delete' }, { role: 'selectAll' },
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
