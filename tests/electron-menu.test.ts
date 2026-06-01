import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { buildApplicationMenuTemplate } from '../apps/desktop/src/electron/menu/applicationMenu';

describe('desktop application menu', () => {
  it('puts project actions under a top-level File menu', () => {
    const template = buildApplicationMenuTemplate({
      recentProjectRoots: ['/tmp/alpha-project', '/tmp/beta-project'],
      onOpenProject: vi.fn(),
      onOpenRecentProject: vi.fn(),
      onClearRecentProjects: vi.fn()
    });

    const fileMenu = template.find((item) => item.label === 'File');
    expect(fileMenu).toBeDefined();

    const fileItems = fileMenu?.submenu as MenuItemConstructorOptions[];
    expect(fileItems.map((item) => item.label ?? item.role)).toContain('Open Project...');

    const openRecent = fileItems.find((item) => item.label === 'Open Recent');
    expect(openRecent).toBeDefined();

    const recentItems = openRecent?.submenu as MenuItemConstructorOptions[];
    expect(recentItems.map((item) => item.label ?? item.role)).toEqual([
      '/tmp/alpha-project',
      '/tmp/beta-project',
      undefined,
      'Clear Recent'
    ]);
  });

  it('keeps the recent-project submenu usable when there are no recents', () => {
    const template = buildApplicationMenuTemplate({
      recentProjectRoots: [],
      onOpenProject: vi.fn(),
      onOpenRecentProject: vi.fn(),
      onClearRecentProjects: vi.fn()
    });

    const fileMenu = template.find((item) => item.label === 'File');
    const fileItems = fileMenu?.submenu as MenuItemConstructorOptions[];
    const openRecent = fileItems.find((item) => item.label === 'Open Recent');
    const recentItems = openRecent?.submenu as MenuItemConstructorOptions[];

    expect(recentItems.map((item) => item.label ?? item.role)).toEqual([
      'No Recent Projects',
      undefined,
      'Clear Recent'
    ]);
    expect(recentItems[0]?.enabled).toBe(false);
    expect(recentItems[2]?.enabled).toBe(false);
  });

  it('provides native editing roles including speech controls', () => {
    const template = buildApplicationMenuTemplate({
      recentProjectRoots: [],
      onOpenProject: vi.fn(),
      onOpenRecentProject: vi.fn(),
      onClearRecentProjects: vi.fn()
    });

    const editMenu = template.find((item) => item.label === 'Edit');
    expect(editMenu).toBeDefined();

    const editItems = editMenu?.submenu as MenuItemConstructorOptions[];
    expect(editItems.map((item) => item.role)).toContain('copy');
    expect(editItems.map((item) => item.role)).toContain('selectAll');

    const speech = editItems.find((item) => item.label === 'Speech');
    const speechItems = speech?.submenu as MenuItemConstructorOptions[];
    expect(speechItems.map((item) => item.role)).toEqual(['startSpeaking', 'stopSpeaking']);
  });
});
