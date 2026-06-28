import type { ITheme } from '@xterm/xterm';
import type { WorkbenchResolvedTheme } from '../services/workbenchTheme';

const TERMINAL_THEMES: Record<WorkbenchResolvedTheme, ITheme> = {
  dark: {
    background: '#0c0e10',
    foreground: '#e6edf3',
    cursor: '#f6f8fa',
    cursorAccent: '#0c0e10',
    selectionBackground: '#264f78',
    selectionForeground: '#f6f8fa',
    selectionInactiveBackground: '#1f3a5f',
    black: '#0c0e10',
    red: '#ff7b72',
    green: '#7ee787',
    yellow: '#d29922',
    blue: '#79c0ff',
    magenta: '#d2a8ff',
    cyan: '#76e3ea',
    white: '#e6edf3',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#a5d6ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#b3f0ff',
    brightWhite: '#f0f6fc'
  },
  light: {
    background: '#f8f9fb',
    foreground: '#111827',
    cursor: '#050816',
    cursorAccent: '#f8f9fb',
    selectionBackground: '#bfdbfe',
    selectionForeground: '#111827',
    selectionInactiveBackground: '#dbeafe',
    black: '#111827',
    red: '#b91c1c',
    green: '#047857',
    yellow: '#b45309',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#6b7280',
    brightBlack: '#6b7280',
    brightRed: '#dc2626',
    brightGreen: '#059669',
    brightYellow: '#d97706',
    brightBlue: '#1d4ed8',
    brightMagenta: '#7e22ce',
    brightCyan: '#0e7490',
    brightWhite: '#374151'
  }
};

export function terminalThemeForWorkbenchTheme(theme: WorkbenchResolvedTheme): ITheme {
  return { ...TERMINAL_THEMES[theme] };
}
