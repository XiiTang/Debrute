import type { WorkbenchPreferencesView } from '@debrute/app-protocol';

export const WORKBENCH_DARK_BACKGROUND = '#181818';
export const WORKBENCH_LIGHT_BACKGROUND = '#f4f5f7';

export interface WorkbenchStartupBackgroundRuntime {
  workbenchPreferencesGet(): Promise<WorkbenchPreferencesView>;
}

export interface WorkbenchNativeThemeState {
  shouldUseDarkColors: boolean;
}

export function workbenchStartupBackgroundColor(input: {
  preferences: WorkbenchPreferencesView;
  nativeTheme: WorkbenchNativeThemeState;
}): string {
  if (input.preferences.themePreference === 'dark') {
    return WORKBENCH_DARK_BACKGROUND;
  }
  if (input.preferences.themePreference === 'light') {
    return WORKBENCH_LIGHT_BACKGROUND;
  }
  return input.nativeTheme.shouldUseDarkColors ? WORKBENCH_DARK_BACKGROUND : WORKBENCH_LIGHT_BACKGROUND;
}

export async function workbenchStartupBackgroundColorForRuntime(
  runtime: WorkbenchStartupBackgroundRuntime,
  nativeTheme: WorkbenchNativeThemeState
): Promise<string> {
  return workbenchStartupBackgroundColor({
    preferences: await runtime.workbenchPreferencesGet(),
    nativeTheme
  });
}
