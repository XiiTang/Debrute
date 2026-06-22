import { describe, expect, it } from 'vitest';
import {
  buildWorkbenchTitleBarState,
  menuLabels,
  titleBarPresentationForPlatform,
  type WorkbenchMenuCommandId
} from '@debrute/app-protocol';

describe('Workbench chrome protocol', () => {
  it('uses native macOS menus and no self-drawn controls', () => {
    const state = buildWorkbenchTitleBarState({
      platform: 'darwin',
      projectTitle: 'Storyboard',
      recentProjectRoots: ['/projects/alpha'],
      host: 'desktop'
    });

    expect(state.title).toBe('Storyboard');
    expect(state.presentation).toEqual({
      platform: 'darwin',
      host: 'desktop',
      showWebMenus: false,
      showWindowControls: false,
      trafficLightSpacer: true
    });
    expect(menuLabels(state.menus)).toEqual(['File', 'Edit', 'View']);
  });

  it('uses Web menus and self-drawn controls for Windows and Linux desktop', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const state = buildWorkbenchTitleBarState({
        platform,
        projectTitle: 'Cutout Project',
        recentProjectRoots: ['/projects/alpha', '/projects/beta'],
        host: 'desktop'
      });

      expect(state.presentation.showWebMenus).toBe(true);
      expect(state.presentation.showWindowControls).toBe(true);
      expect(commandIds(state)).toContain('project.open-recent');
      expect(commandIds(state)).toContain('window.close');
      expect(commandIds(state)).toContain('edit.paste-and-match-style');
      expect(commandIds(state)).not.toContain('edit.start-speaking');
      expect(commandIds(state)).not.toContain('edit.stop-speaking');
    }
  });

  it('uses Web menus without native window controls for browser Workbench', () => {
    const state = buildWorkbenchTitleBarState({
      platform: 'darwin',
      projectTitle: undefined,
      recentProjectRoots: [],
      host: 'web'
    });

    expect(state.title).toBe('Debrute');
    expect(state.presentation).toEqual({
      platform: 'darwin',
      host: 'web',
      showWebMenus: true,
      showWindowControls: false,
      trafficLightSpacer: false
    });
    expect(commandIds(state)).not.toContain('window.close');
    expect(commandIds(state)).not.toContain('edit.paste-and-match-style');
    expect(commandIds(state)).not.toContain('edit.start-speaking');
    expect(commandIds(state)).not.toContain('edit.stop-speaking');
  });

  it('omits native-only File commands without leaving separator artifacts in browser Workbench', () => {
    const state = buildWorkbenchTitleBarState({
      platform: 'linux',
      projectTitle: 'Storyboard',
      recentProjectRoots: ['/projects/alpha'],
      host: 'web'
    });

    const fileMenu = state.menus.find((menu) => menu.id === 'file');
    expect(fileMenu?.items.map((item) => item.kind === 'separator' ? 'separator' : item.label)).toEqual([
      'Open Project...',
      'Open Recent',
      'Clear Recent'
    ]);
  });

  it('keeps speech commands native macOS only', () => {
    const state = buildWorkbenchTitleBarState({
      platform: 'darwin',
      projectTitle: 'Storyboard',
      recentProjectRoots: [],
      host: 'desktop'
    });

    expect(commandIds(state)).toContain('edit.start-speaking');
    expect(commandIds(state)).toContain('edit.stop-speaking');
  });

  it('keeps platform presentation as a pure helper', () => {
    expect(titleBarPresentationForPlatform({ platform: 'darwin', host: 'desktop' }).showWebMenus).toBe(false);
    expect(titleBarPresentationForPlatform({ platform: 'win32', host: 'desktop' }).showWindowControls).toBe(true);
    expect(titleBarPresentationForPlatform({ platform: 'linux', host: 'web' }).showWindowControls).toBe(false);
  });
});

function commandIds(state: { menus: ReturnType<typeof buildWorkbenchTitleBarState>['menus'] }): WorkbenchMenuCommandId[] {
  return state.menus.flatMap((menu) => menu.items.flatMap((item) => {
    if (item.kind === 'command') {
      return [item.commandId];
    }
    if (item.kind === 'submenu') {
      return item.items.filter((subItem) => subItem.kind === 'command').map((subItem) => subItem.commandId);
    }
    return [];
  }));
}
