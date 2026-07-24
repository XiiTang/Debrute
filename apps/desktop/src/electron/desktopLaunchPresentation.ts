import type { WorkbenchThemePreference } from '@debrute/app-protocol';

export function desktopWindowBackgroundColor(
  themePreference: WorkbenchThemePreference,
  systemUsesDarkColors: boolean
): string {
  const dark = themePreference === 'dark'
    || (themePreference === 'system' && systemUsesDarkColors);
  return dark ? '#171714' : '#f7e3d0';
}
