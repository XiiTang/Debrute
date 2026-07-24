import type { DebruteProductPlatform, NativeMenuCommandId } from '@debrute/app-protocol';
import { createI18n, type WorkbenchI18n, type WorkbenchLocale } from '../i18n';

type WorkbenchHostKind = 'web' | 'desktop';

export type WorkbenchMenuId = 'file' | 'edit' | 'view';

export type WorkbenchMenuCommandId = NativeMenuCommandId
  | 'project.open-picker'
  | 'project.open-recent'
  | 'project.clear-recent';

interface WorkbenchTitleBarPresentation {
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
  presentation: WorkbenchTitleBarPresentation;
  menus: WorkbenchMenu[];
}

export function buildWorkbenchTitleBarState(input: {
  platform: DebruteProductPlatform;
  host: WorkbenchHostKind;
  locale: WorkbenchLocale;
  projectTitle?: string | undefined;
  recentProjectRoots: string[];
}): WorkbenchTitleBarState {
  const i18n = createI18n(input.locale);
  return {
    title: input.projectTitle?.trim() || 'Debrute',
    presentation: titleBarPresentationForPlatform(input),
    menus: buildWorkbenchMenus({ ...input, i18n })
  };
}

function titleBarPresentationForPlatform(input: {
  platform: DebruteProductPlatform;
  host: WorkbenchHostKind;
}): WorkbenchTitleBarPresentation {
  const desktop = input.host === 'desktop';
  return {
    showWebMenus: !desktop || input.platform !== 'darwin',
    showWindowControls: desktop && input.platform === 'win32',
    trafficLightSpacer: desktop && input.platform === 'darwin'
  };
}

function buildWorkbenchMenus(input: {
  platform: DebruteProductPlatform;
  host: WorkbenchHostKind;
  i18n: WorkbenchI18n;
  recentProjectRoots: string[];
}): WorkbenchMenu[] {
  const desktop = input.host === 'desktop';
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
        label: input.i18n.t('shell.titleBar.noRecentProjects'),
        commandId: 'project.open-recent',
        enabled: false
      }];

  if (desktop) {
    fileItems.push({
      kind: 'command',
      id: 'window.new',
      label: input.i18n.t('shell.titleBar.newWindow'),
      commandId: 'window.new',
      enabled: true
    }, {
      kind: 'separator',
      id: 'file-open-separator'
    });
  }
  fileItems.push({
    kind: 'command',
    id: 'project.open-picker',
    label: input.i18n.t('shell.titleBar.openProject'),
    commandId: 'project.open-picker',
    enabled: true
  });
  if (desktop) {
    fileItems.push({
      kind: 'command',
      id: 'project.open-picker-new-window',
      label: input.i18n.t('shell.titleBar.openProjectNewWindow'),
      commandId: 'project.open-picker-new-window',
      enabled: true
    });
  }
  fileItems.push({
    kind: 'submenu',
    id: 'project.open-recent',
    label: input.i18n.t('shell.titleBar.openRecent'),
    enabled: input.recentProjectRoots.length > 0,
    items: recentItems
  }, {
    kind: 'command',
    id: 'project.clear-recent',
    label: input.i18n.t('shell.titleBar.clearRecent'),
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
      label: input.i18n.t('shell.titleBar.closeWindow'),
      commandId: 'window.close',
      enabled: true
    });
  }

  const menus: WorkbenchMenu[] = [{
    id: 'file',
    label: input.i18n.t('shell.titleBar.file'),
    items: fileItems
  }, {
    id: 'edit',
    label: input.i18n.t('shell.titleBar.edit'),
    items: [
      { kind: 'command', id: 'edit.undo', label: input.i18n.t('shell.titleBar.undo'), commandId: 'edit.undo', enabled: true },
      { kind: 'command', id: 'edit.redo', label: input.i18n.t('shell.titleBar.redo'), commandId: 'edit.redo', enabled: true },
      { kind: 'separator', id: 'edit-clipboard-separator' },
      { kind: 'command', id: 'edit.cut', label: input.i18n.t('shell.contextMenu.cut'), commandId: 'edit.cut', enabled: true },
      { kind: 'command', id: 'edit.copy', label: input.i18n.t('shell.contextMenu.copy'), commandId: 'edit.copy', enabled: true },
      { kind: 'command', id: 'edit.paste', label: input.i18n.t('shell.contextMenu.paste'), commandId: 'edit.paste', enabled: true },
      ...(desktop ? [{
        kind: 'command' as const,
        id: 'edit.paste-and-match-style',
        label: input.i18n.t('shell.titleBar.pasteAndMatchStyle'),
        commandId: 'edit.paste-and-match-style' as const,
        enabled: true
      }] : []),
      { kind: 'command', id: 'edit.delete', label: input.i18n.t('shell.contextMenu.delete'), commandId: 'edit.delete', enabled: true },
      { kind: 'command', id: 'edit.select-all', label: input.i18n.t('shell.titleBar.selectAll'), commandId: 'edit.select-all', enabled: true }
    ]
  }];
  if (desktop) {
    menus.push({
      id: 'view',
      label: input.i18n.t('shell.titleBar.view'),
      items: [
        { kind: 'command', id: 'view.reload', label: input.i18n.t('shell.titleBar.reload'), commandId: 'view.reload', enabled: true },
        { kind: 'command', id: 'view.toggle-devtools', label: input.i18n.t('shell.titleBar.toggleDevtools'), commandId: 'view.toggle-devtools', enabled: true }
      ]
    });
  }
  return menus;
}
