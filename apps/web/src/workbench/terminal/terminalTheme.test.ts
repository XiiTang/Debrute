import { describe, expect, it } from 'vitest';
import { terminalThemeForWorkbenchTheme } from './terminalTheme';

describe('terminalThemeForWorkbenchTheme', () => {
  it('maps the dark Workbench theme to the dark terminal surface and ANSI palette', () => {
    expect(terminalThemeForWorkbenchTheme('dark')).toMatchObject({
      background: '#0c0e10',
      foreground: '#e6edf3',
      cursor: '#f6f8fa',
      selectionBackground: '#264f78',
      black: '#0c0e10',
      red: '#ff7b72',
      green: '#7ee787',
      yellow: '#d29922',
      blue: '#79c0ff',
      magenta: '#d2a8ff',
      cyan: '#76e3ea',
      white: '#e6edf3',
      brightBlack: '#6e7681',
      brightWhite: '#f0f6fc'
    });
  });

  it('maps the light Workbench theme to the light terminal surface and ANSI palette', () => {
    expect(terminalThemeForWorkbenchTheme('light')).toMatchObject({
      background: '#f8f9fb',
      foreground: '#111827',
      cursor: '#050816',
      selectionBackground: '#bfdbfe',
      black: '#111827',
      red: '#b91c1c',
      green: '#047857',
      yellow: '#b45309',
      blue: '#2563eb',
      magenta: '#9333ea',
      cyan: '#0891b2',
      white: '#6b7280',
      brightBlack: '#6b7280',
      brightWhite: '#374151'
    });
  });
});
