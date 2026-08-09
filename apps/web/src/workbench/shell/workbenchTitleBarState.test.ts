import { describe, expect, it } from 'vitest';
import {
  buildWorkbenchTitleBarState,
  workbenchMenuCommandItem,
  type WorkbenchMenuCommandId
} from './workbenchTitleBarState';

describe('Workbench title-bar state', () => {
  it('uses native macOS menus and no self-drawn controls', () => {
    const state = buildWorkbenchTitleBarState({
      platform: 'darwin',
      projectTitle: 'Storyboard',
      recentProjects: [{ projectRoot: '/projects/alpha' }],
      host: 'desktop',
      locale: 'en'
    });

    expect(state.title).toBe('Storyboard');
    expect(state.presentation).toEqual({
      showWebMenus: false,
      showWindowControls: false,
      trafficLightSpacer: true
    });
    expect(state.menus.map((menu) => menu.label)).toEqual(['File', 'Edit', 'View']);
  });

  it('uses Web menus and self-drawn controls for Windows desktop', () => {
    const state = buildWorkbenchTitleBarState({
      platform: 'win32',
      projectTitle: 'Cutout Project',
      recentProjects: [
        { projectRoot: '/projects/alpha' },
        { projectRoot: '/projects/beta' }
      ],
      host: 'desktop',
      locale: 'en'
    });

    expect(state.presentation.showWebMenus).toBe(true);
    expect(state.presentation.showWindowControls).toBe(true);
    expect(commandIds(state)).toContain('project.open-recent');
    expect(commandIds(state)).toContain('window.close');
    expect(commandIds(state)).toContain('edit.paste-and-match-style');
    expect(workbenchMenuCommandItem(state, 'project.open-picker')).toMatchObject({ shortcutLabel: 'Ctrl+O' });
    expect(workbenchMenuCommandItem(state, 'edit.redo')).toMatchObject({ shortcutLabel: 'Ctrl+Y' });
  });

  it('uses Web menus without native window controls for browser Workbench', () => {
    const state = buildWorkbenchTitleBarState({
      platform: 'darwin',
      projectTitle: undefined,
      recentProjects: [],
      host: 'web',
      locale: 'en'
    });

    expect(state.title).toBe('Debrute');
    expect(state.presentation).toEqual({
      showWebMenus: true,
      showWindowControls: false,
      trafficLightSpacer: false
    });
    expect(state.menus.map((menu) => menu.label)).toEqual(['File', 'Edit']);
    expect(commandIds(state)).not.toContain('window.close');
    expect(commandIds(state)).not.toContain('edit.paste-and-match-style');
    expect(workbenchMenuCommandItem(state, 'project.open-picker')).toMatchObject({ shortcutLabel: '⌘O' });
  });

  it('omits native-only File commands without separator artifacts in the browser', () => {
    const state = buildWorkbenchTitleBarState({
      platform: 'darwin',
      projectTitle: 'Storyboard',
      recentProjects: [{ projectRoot: '/projects/alpha' }],
      host: 'web',
      locale: 'en'
    });

    const fileMenu = state.menus.find((menu) => menu.id === 'file');
    expect(fileMenu?.items.map((item) => item.kind === 'separator' ? 'separator' : item.label)).toEqual([
      'Open Project...',
      'Open Recent',
      'Clear Recent'
    ]);
  });

  it('derives localized menu labels directly from the current locale', () => {
    const state = buildWorkbenchTitleBarState({
      platform: 'darwin',
      host: 'web',
      locale: 'zh-CN',
      recentProjects: []
    });

    expect(state.menus.map((menu) => menu.label)).toEqual(['文件', '编辑']);
    expect(state.menus[0]?.items[0]).toMatchObject({ label: '打开项目...' });
  });
});

function commandIds(state: ReturnType<typeof buildWorkbenchTitleBarState>): string[] {
  return state.menus.flatMap((menu) => menu.items.flatMap((item) => {
    if (item.kind === 'command') {
      return [item.commandId];
    }
    if (item.kind === 'submenu') {
      return item.items.flatMap((subItem) => subItem.kind === 'command' ? [subItem.commandId] : []);
    }
    return [];
  })) satisfies WorkbenchMenuCommandId[];
}
