import type { MenuItemConstructorOptions } from 'electron';

type MenuAction = () => void | Promise<void>;

export interface BuildApplicationMenuOptions {
  recentProjectRoots: string[];
  onOpenProject: MenuAction;
  onOpenRecentProject: (projectRoot: string) => void | Promise<void>;
  onClearRecentProjects: MenuAction;
}

export function buildApplicationMenuTemplate({
  recentProjectRoots,
  onOpenProject,
  onOpenRecentProject,
  onClearRecentProjects
}: BuildApplicationMenuOptions): MenuItemConstructorOptions[] {
  const recentProjectItems: MenuItemConstructorOptions[] = recentProjectRoots.length > 0
    ? [
        ...recentProjectRoots.map((projectRoot) => ({
          label: projectRoot,
          click: () => onOpenRecentProject(projectRoot)
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
          label: 'Open Project...',
          accelerator: 'CmdOrCtrl+O',
          click: () => onOpenProject()
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
