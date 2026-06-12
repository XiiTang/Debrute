import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

export interface ProjectOpenMenuOptions {
  forceNewWindow: boolean;
}

type ProjectOpenMenuAction = (sourceWindow: BrowserWindow | undefined, options: ProjectOpenMenuOptions) => void | Promise<void>;
type MenuAction = () => void | Promise<void>;

export interface BuildApplicationMenuOptions {
  recentProjectRoots: string[];
  onNewWindow: MenuAction;
  onOpenProject: ProjectOpenMenuAction;
  onOpenRecentProject: (projectRoot: string, sourceWindow: BrowserWindow | undefined, options: ProjectOpenMenuOptions) => void | Promise<void>;
  onClearRecentProjects: MenuAction;
}

export function buildApplicationMenuTemplate({
  recentProjectRoots,
  onNewWindow,
  onOpenProject,
  onOpenRecentProject,
  onClearRecentProjects
}: BuildApplicationMenuOptions): MenuItemConstructorOptions[] {
  const recentProjectItems: MenuItemConstructorOptions[] = recentProjectRoots.length > 0
    ? [
        ...recentProjectRoots.map((projectRoot) => ({
          label: projectRoot,
          click: (_item, browserWindow) => onOpenRecentProject(projectRoot, browserWindow ?? undefined, { forceNewWindow: false })
        })),
        { type: 'separator' },
        { label: 'Clear Recent', click: () => onClearRecentProjects() }
      ]
    : [
        { label: 'No Recent Projects', enabled: false },
        { type: 'separator' },
        { label: 'Clear Recent', enabled: false, click: () => onClearRecentProjects() }
      ];

  return [
    {
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
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => onNewWindow()
        },
        { type: 'separator' },
        {
          label: 'Open Project...',
          accelerator: 'CmdOrCtrl+O',
          click: (_item, browserWindow) => onOpenProject(browserWindow ?? undefined, { forceNewWindow: false })
        },
        {
          label: 'Open Project in New Window...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: (_item, browserWindow) => onOpenProject(browserWindow ?? undefined, { forceNewWindow: true })
        },
        {
          label: 'Open Recent',
          submenu: recentProjectItems
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Speech',
          submenu: [
            { role: 'startSpeaking' },
            { role: 'stopSpeaking' }
          ]
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' }
      ]
    }
  ];
}
