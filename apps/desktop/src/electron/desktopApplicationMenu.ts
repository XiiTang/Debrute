import {
  workbenchCommandShortcutAccelerator,
  type DebruteProductPlatform,
  type NativeEditCommandId,
  type NativeMenuCommandId
} from '@debrute/app-protocol';

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
    ? [{ role: 'close', accelerator: accelerator('window.close', input.platform) }]
    : [
        { label: 'Close Window', accelerator: accelerator('window.close', input.platform), role: 'close' },
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
        { label: 'New Window', accelerator: accelerator('window.new', input.platform), click: input.newWindow },
        { type: 'separator' },
        {
          label: 'Open Project…',
          accelerator: accelerator('project.open-picker', input.platform),
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
        { role: 'undo', accelerator: accelerator('edit.undo', input.platform) },
        { role: 'redo', accelerator: accelerator('edit.redo', input.platform) },
        { type: 'separator' },
        editCommandItem('Cut', 'edit.cut', input),
        editCommandItem('Copy', 'edit.copy', input),
        editCommandItem('Paste', 'edit.paste', input),
        {
          role: 'pasteAndMatchStyle',
          accelerator: accelerator('edit.paste-and-match-style', input.platform)
        },
        editCommandItem('Delete', 'edit.delete', input),
        editCommandItem('Select All', 'edit.select-all', input),
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
          accelerator: accelerator('view.reload', input.platform),
          click: (_item, window) => input.reloadWorkbench(window)
        },
        {
          role: 'toggleDevTools',
          accelerator: accelerator('view.toggle-devtools', input.platform)
        },
        { type: 'separator' }, { role: 'resetZoom' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
}

function editCommandItem(
  label: string,
  command: NativeEditCommandId,
  input: DesktopApplicationMenuInput
): Electron.MenuItemConstructorOptions {
  return {
    label,
    accelerator: accelerator(command, input.platform),
    click: (_item, window) => input.dispatchEditCommand(window, command)
  };
}

function accelerator(
  commandId: NativeMenuCommandId,
  platform: DebruteProductPlatform
): string {
  const value = workbenchCommandShortcutAccelerator(commandId, platform);
  if (!value) {
    throw new Error(`Native menu command has no shortcut: ${commandId}`);
  }
  return value;
}
