import { describe, expect, it } from 'vitest';
import { terminalThemeForWorkbenchTheme } from './terminalTheme';

const ANSI_COLOR_KEYS = [
  'foreground',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const;

describe('terminalThemeForWorkbenchTheme', { tags: ['terminal'] }, () => {
  it('maps the dark Workbench theme to the dark terminal surface and ANSI palette', () => {
    expect(terminalThemeForWorkbenchTheme('dark')).toMatchObject({
      background: '#0d0d0b',
      foreground: '#f7e7d2',
      cursor: '#e98245',
      selectionBackground: '#5a3522',
      selectionForeground: '#fff0dc',
      black: '#0d0d0b',
      red: '#e77967',
      green: '#aab76a',
      yellow: '#e0a838',
      blue: '#83a7c7',
      magenta: '#c08ba8',
      cyan: '#73b8b5',
      white: '#f7e7d2',
      brightBlack: '#918373',
      brightWhite: '#fff0dc'
    });
  });

  it('maps the light Workbench theme to the light terminal surface and ANSI palette', () => {
    expect(terminalThemeForWorkbenchTheme('light')).toMatchObject({
      background: '#f7f3ee',
      foreground: '#282825',
      cursor: '#b44e19',
      selectionBackground: '#e9b994',
      selectionForeground: '#282825',
      black: '#282825',
      red: '#a93c32',
      green: '#647043',
      yellow: '#8a5b06',
      blue: '#35627e',
      magenta: '#80536d',
      cyan: '#2e7073',
      white: '#655a50',
      brightBlack: '#6f6257',
      brightWhite: '#4d443b'
    });
  });

  it.each(['dark', 'light'] as const)('keeps the %s ANSI palette legible', (themeName) => {
    const theme = terminalThemeForWorkbenchTheme(themeName);
    for (const key of ANSI_COLOR_KEYS) {
      expect(contrastRatio(requireColor(theme[key]), requireColor(theme.background)), key)
        .toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(requireColor(theme.cursor), requireColor(theme.background)), 'cursor')
      .toBeGreaterThanOrEqual(3);
    expect(
      contrastRatio(requireColor(theme.selectionForeground), requireColor(theme.selectionBackground)),
      'selection'
    ).toBeGreaterThanOrEqual(4.5);
  });
});

function requireColor(value: string | undefined): string {
  if (!value) {
    throw new Error('Expected a terminal theme color.');
  }
  return value;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: string): number {
  const channels = color.match(/[0-9a-f]{2}/gi);
  if (!channels || channels.length !== 3) {
    throw new Error(`Expected a six-digit hex color, received ${color}.`);
  }
  const [red, green, blue] = channels.map((channel) => {
    const normalized = Number.parseInt(channel, 16) / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
