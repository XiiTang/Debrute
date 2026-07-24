import type { ITheme } from '@xterm/xterm';
import type { WorkbenchResolvedTheme } from '../services/workbenchTheme';

const TERMINAL_THEMES: Record<WorkbenchResolvedTheme, ITheme> = {
  dark: {
    background: '#0d0d0b',
    foreground: '#f7e7d2',
    cursor: '#e98245',
    cursorAccent: '#171714',
    selectionBackground: '#5a3522',
    selectionForeground: '#fff0dc',
    selectionInactiveBackground: '#3a2a21',
    black: '#0d0d0b',
    red: '#e77967',
    green: '#aab76a',
    yellow: '#e0a838',
    blue: '#83a7c7',
    magenta: '#c08ba8',
    cyan: '#73b8b5',
    white: '#f7e7d2',
    brightBlack: '#918373',
    brightRed: '#f08d7c',
    brightGreen: '#bdc982',
    brightYellow: '#efbf55',
    brightBlue: '#a4c3de',
    brightMagenta: '#d7a4c0',
    brightCyan: '#99d0cd',
    brightWhite: '#fff0dc'
  },
  light: {
    background: '#f7f3ee',
    foreground: '#282825',
    cursor: '#b44e19',
    cursorAccent: '#f7f3ee',
    selectionBackground: '#e9b994',
    selectionForeground: '#282825',
    selectionInactiveBackground: '#edd1bb',
    black: '#282825',
    red: '#a93c32',
    green: '#647043',
    yellow: '#8a5b06',
    blue: '#35627e',
    magenta: '#80536d',
    cyan: '#2e7073',
    white: '#655a50',
    brightBlack: '#6f6257',
    brightRed: '#b74739',
    brightGreen: '#5d7137',
    brightYellow: '#925f08',
    brightBlue: '#3f7291',
    brightMagenta: '#8f5877',
    brightCyan: '#327477',
    brightWhite: '#4d443b'
  }
};

export function terminalThemeForWorkbenchTheme(theme: WorkbenchResolvedTheme): ITheme {
  return { ...TERMINAL_THEMES[theme] };
}
