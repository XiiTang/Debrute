export type WorkbenchHostKind = 'web' | 'desktop';
export type WorkbenchChromePlatform = NodeJS.Platform | 'unknown';

export type WorkbenchMenuId = 'file' | 'edit' | 'view';

export type WorkbenchMenuCommandId =
  | 'window.new'
  | 'project.open-picker'
  | 'project.open-picker-new-window'
  | 'project.open-recent'
  | 'project.clear-recent'
  | 'window.close'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.cut'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.paste-and-match-style'
  | 'edit.delete'
  | 'edit.select-all'
  | 'edit.start-speaking'
  | 'edit.stop-speaking'
  | 'view.reload'
  | 'view.toggle-devtools';

export interface WorkbenchTitleBarPresentation {
  platform: WorkbenchChromePlatform;
  host: WorkbenchHostKind;
  showWebMenus: boolean;
  showWindowControls: boolean;
  trafficLightSpacer: boolean;
}

export type WorkbenchMenuItem =
  | { kind: 'separator'; id: string }
  | {
      kind: 'command';
      id: string;
      label: string;
      commandId: WorkbenchMenuCommandId;
      enabled: boolean;
      accelerator?: string;
      payload?: Record<string, string | boolean>;
    }
  | {
      kind: 'submenu';
      id: string;
      label: string;
      enabled: boolean;
      items: WorkbenchMenuItem[];
    };

export interface WorkbenchMenu {
  id: WorkbenchMenuId;
  label: string;
  items: WorkbenchMenuItem[];
}

export interface WorkbenchTitleBarState {
  title: string;
  recentProjectRoots: string[];
  presentation: WorkbenchTitleBarPresentation;
  menus: WorkbenchMenu[];
}

export function titleBarPresentationForPlatform(input: {
  platform: NodeJS.Platform;
  host: WorkbenchHostKind;
}): WorkbenchTitleBarPresentation {
  const desktop = input.host === 'desktop';
  return {
    platform: input.platform,
    host: input.host,
    showWebMenus: !desktop || input.platform !== 'darwin',
    showWindowControls: desktop && input.platform === 'win32',
    trafficLightSpacer: desktop && input.platform === 'darwin'
  };
}

export function buildWorkbenchTitleBarState(input: {
  platform: NodeJS.Platform;
  host: WorkbenchHostKind;
  projectTitle?: string | undefined;
  recentProjectRoots: string[];
}): WorkbenchTitleBarState {
  const recentProjectRoots = [...input.recentProjectRoots];
  return {
    title: input.projectTitle?.trim() || 'Debrute',
    recentProjectRoots,
    presentation: titleBarPresentationForPlatform({ platform: input.platform, host: input.host }),
    menus: buildWorkbenchMenus({ platform: input.platform, host: input.host, recentProjectRoots })
  };
}

export function unavailableWorkbenchTitleBarState(): WorkbenchTitleBarState {
  return {
    title: 'Debrute',
    recentProjectRoots: [],
    presentation: {
      platform: 'unknown',
      host: 'web',
      showWebMenus: false,
      showWindowControls: false,
      trafficLightSpacer: false
    },
    menus: []
  };
}

export function menuLabels(menus: WorkbenchMenu[]): string[] {
  return menus.map((menu) => menu.label);
}

export function buildWorkbenchMenus(input: {
  platform: NodeJS.Platform;
  host: WorkbenchHostKind;
  recentProjectRoots: string[];
}): WorkbenchMenu[] {
  const desktop = input.host === 'desktop';
  const macDesktop = desktop && input.platform === 'darwin';
  const fileItems: WorkbenchMenuItem[] = [];
  const recentItems: WorkbenchMenuItem[] = input.recentProjectRoots.length > 0
    ? input.recentProjectRoots.map((projectRoot) => ({
        kind: 'command' as const,
        id: `recent:${projectRoot}`,
        label: projectRoot,
        commandId: 'project.open-recent' as const,
        enabled: true,
        payload: { projectRoot }
      }))
    : [{
        kind: 'command',
        id: 'recent:none',
        label: 'No Recent Projects',
        commandId: 'project.open-recent',
        enabled: false
      }];

  if (desktop) {
    fileItems.push({
      kind: 'command',
      id: 'window.new',
      label: 'New Window',
      commandId: 'window.new',
      enabled: true,
      accelerator: 'CmdOrCtrl+N'
    }, {
      kind: 'separator',
      id: 'file-open-separator'
    });
  }
  fileItems.push({
    kind: 'command',
    id: 'project.open-picker',
    label: 'Open Project...',
    commandId: 'project.open-picker',
    enabled: true,
    accelerator: 'CmdOrCtrl+O'
  });
  if (desktop) {
    fileItems.push({
      kind: 'command',
      id: 'project.open-picker-new-window',
      label: 'Open Project in New Window...',
      commandId: 'project.open-picker-new-window',
      enabled: true,
      accelerator: 'CmdOrCtrl+Shift+O'
    });
  }
  fileItems.push({
    kind: 'submenu',
    id: 'project.open-recent',
    label: 'Open Recent',
    enabled: input.recentProjectRoots.length > 0,
    items: recentItems
  }, {
    kind: 'command',
    id: 'project.clear-recent',
    label: 'Clear Recent',
    commandId: 'project.clear-recent',
    enabled: input.recentProjectRoots.length > 0
  });
  if (desktop) {
    fileItems.push({
      kind: 'separator',
      id: 'file-close-separator'
    }, {
      kind: 'command',
      id: 'window.close',
      label: 'Close Window',
      commandId: 'window.close',
      enabled: true,
      accelerator: 'CmdOrCtrl+W'
    });
  }

  const menus: WorkbenchMenu[] = [{
    id: 'file',
    label: 'File',
    items: fileItems
  }, {
    id: 'edit',
    label: 'Edit',
    items: [
      { kind: 'command', id: 'edit.undo', label: 'Undo', commandId: 'edit.undo', enabled: true, accelerator: 'CmdOrCtrl+Z' },
      { kind: 'command', id: 'edit.redo', label: 'Redo', commandId: 'edit.redo', enabled: true, accelerator: 'Shift+CmdOrCtrl+Z' },
      { kind: 'separator', id: 'edit-clipboard-separator' },
      { kind: 'command', id: 'edit.cut', label: 'Cut', commandId: 'edit.cut', enabled: true, accelerator: 'CmdOrCtrl+X' },
      { kind: 'command', id: 'edit.copy', label: 'Copy', commandId: 'edit.copy', enabled: true, accelerator: 'CmdOrCtrl+C' },
      { kind: 'command', id: 'edit.paste', label: 'Paste', commandId: 'edit.paste', enabled: true, accelerator: 'CmdOrCtrl+V' },
      ...(desktop ? [{
        kind: 'command' as const,
        id: 'edit.paste-and-match-style',
        label: 'Paste and Match Style',
        commandId: 'edit.paste-and-match-style' as const,
        enabled: true,
        accelerator: 'Shift+CmdOrCtrl+V'
      }] : []),
      { kind: 'command', id: 'edit.delete', label: 'Delete', commandId: 'edit.delete', enabled: true },
      { kind: 'command', id: 'edit.select-all', label: 'Select All', commandId: 'edit.select-all', enabled: true, accelerator: 'CmdOrCtrl+A' },
      ...(macDesktop ? [
        { kind: 'separator' as const, id: 'edit-speech-separator' },
        { kind: 'command' as const, id: 'edit.start-speaking', label: 'Start Speaking', commandId: 'edit.start-speaking' as const, enabled: true },
        { kind: 'command' as const, id: 'edit.stop-speaking', label: 'Stop Speaking', commandId: 'edit.stop-speaking' as const, enabled: true }
      ] : [])
    ]
  }];
  if (desktop) {
    menus.push({
      id: 'view',
      label: 'View',
      items: [
        { kind: 'command', id: 'view.reload', label: 'Reload', commandId: 'view.reload', enabled: true, accelerator: 'CmdOrCtrl+R' },
        { kind: 'command', id: 'view.toggle-devtools', label: 'Toggle Developer Tools', commandId: 'view.toggle-devtools', enabled: true, accelerator: 'Alt+CmdOrCtrl+I' }
      ]
    });
  }
  return menus;
}
