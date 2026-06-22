import { describe, expect, it } from 'vitest';
import {
  closeTitleBarMenu,
  openTitleBarMenu,
  switchTitleBarMenuOnHover,
  titleBarMenuKeyAction
} from './workbenchTitleBarInteraction';

describe('title bar menu interaction state', () => {
  it('opens, switches, and closes top-level menus', () => {
    expect(openTitleBarMenu(undefined, 'file')).toBe('file');
    expect(switchTitleBarMenuOnHover('file', 'edit')).toBe('edit');
    expect(closeTitleBarMenu('edit')).toBeUndefined();
  });

  it('does not switch menus when no menu is already open', () => {
    expect(switchTitleBarMenuOnHover(undefined, 'view')).toBeUndefined();
  });

  it('classifies menu keyboard commands used by the title bar', () => {
    expect(titleBarMenuKeyAction('Escape')).toBe('close-menu');
    expect(titleBarMenuKeyAction('ArrowRight')).toBe('open-submenu');
    expect(titleBarMenuKeyAction('ArrowLeft')).toBe('close-submenu');
    expect(titleBarMenuKeyAction('ArrowDown')).toBeUndefined();
  });
});
